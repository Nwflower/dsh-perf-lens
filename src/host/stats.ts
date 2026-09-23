// Range aggregation over recorded windows: "which plugin has cost the most
// over the last day/week" and "how spiky is it".
//
// Pure functions over snapshots: no ctx, no clock, no I/O, so the arithmetic is
// unit-testable exactly like attribute.ts. The route layer supplies the
// snapshots (ring buffer + JSONL) and the range.

import type { PerfRange, PerfStats, PerfSnapshot, PerfTrend, PerfTrendSeries, PluginMetricRow, PluginStatsRow } from '../shared/contract'
import { percentile } from '../shared/math'

export { percentile }

/** Range to a start timestamp. Unknown ranges fall back to 24h. */
export function rangeToSince(range: string, now: number): { range: PerfRange; since: number } {
  switch (range) {
    case '1h': return { range: '1h', since: now - 60 * 60 * 1000 }
    case '7d': return { range: '7d', since: now - 7 * 24 * 60 * 60 * 1000 }
    default: return { range: '24h', since: now - 24 * 60 * 60 * 1000 }
  }
}

/**
 * The slice of a recorded window the range aggregators read. A full
 * PerfSnapshot satisfies it; the history cache keeps only this much per window
 * (history.ts summaries), so the aggregators must never reach past it.
 */
export interface WindowSummary {
  readonly windowStartedAt: number
  readonly global: Pick<PerfSnapshot['global'], 'sampleWindowMs'>
  readonly plugins: readonly Pick<PluginMetricRow, 'moduleName' | 'cpuShare' | 'cpuSelfMs'>[]
}

interface Accumulator {
  shares: number[]
  cumulativeCpuMs: number
  windows: number
}

/**
 * Aggregate per-plugin rows over snapshots at or after `since`.
 *
 * Coverage is sampled window time over range wall time. Under the default duty
 * cycle this is small (a 5s window every 35s), which is exactly why
 * estimatedCpuMs exists and why every consumer must label it an estimate.
 */
export function aggregateStats(
  snapshots: readonly WindowSummary[],
  range: PerfRange,
  since: number,
  now: number,
): PerfStats {
  const byPlugin = new Map<string, Accumulator>()
  let sampledWindowMs = 0
  let windowCount = 0
  for (const snapshot of snapshots) {
    if (snapshot.windowStartedAt < since) continue
    windowCount += 1
    sampledWindowMs += snapshot.global.sampleWindowMs
    for (const row of snapshot.plugins) {
      const name = row.moduleName
      let acc = byPlugin.get(name)
      if (acc === undefined) {
        acc = { shares: [], cumulativeCpuMs: 0, windows: 0 }
        byPlugin.set(name, acc)
      }
      acc.shares.push(row.cpuShare)
      acc.cumulativeCpuMs += row.cpuSelfMs
      acc.windows += 1
    }
  }
  const elapsed = Math.max(0, now - since)
  const coverage = elapsed === 0 ? 0 : Math.min(1, sampledWindowMs / elapsed)
  // The average divides by every window in range, not just the windows this
  // plugin had a row in. Persisted windows drop all-zero rows (history.ts
  // rowHasActivity), so absence already means "zero cost here"; dividing by the
  // rows present would turn a plugin that spiked once into an apparent
  // constant consumer. `windows` still counts the windows it did appear in.
  const shareDenominator = windowCount === 0 ? 1 : windowCount
  const plugins: PluginStatsRow[] = []
  for (const [moduleName, acc] of byPlugin) {
    const sorted = [...acc.shares].sort((a, b) => a - b)
    const sum = acc.shares.reduce((total, share) => total + share, 0)
    plugins.push({
      moduleName,
      avgCpuShare: sum / shareDenominator,
      peakCpuShare: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] ?? 0),
      p95CpuShare: percentile(sorted, 0.95),
      cumulativeCpuMs: acc.cumulativeCpuMs,
      estimatedCpuMs: coverage > 0 ? acc.cumulativeCpuMs / coverage : acc.cumulativeCpuMs,
      coverage,
      windows: acc.windows,
    })
  }
  plugins.sort((a, b) => b.cumulativeCpuMs - a.cumulativeCpuMs)
  return { range, since, windowCount, sampledWindowMs, coverage, plugins }
}

/**
 * Fold snapshots into at most `maxPoints` trend points, averaging each bucket.
 *
 * Averaging (not stride-sampling) keeps a spike visible after downsampling,
 * and the compact shape is what keeps a 24h read from shipping tens of
 * megabytes of metric columns the chart never looks at.
 */
export function aggregateTrend(
  snapshots: readonly WindowSummary[],
  range: PerfRange,
  since: number,
  maxPoints: number,
): PerfTrend {
  const ordered = snapshots
    .filter(snapshot => snapshot.windowStartedAt >= since)
    .sort((a, b) => a.windowStartedAt - b.windowStartedAt)
  if (ordered.length === 0 || maxPoints < 1) {
    return { range, since, times: [], series: [], windowCount: 0 }
  }
  const buckets = Math.min(maxPoints, ordered.length)
  const sums: Map<string, number>[] = []
  // Absolute basis: sampled CPU ms and sampled wall time per bucket. Both are
  // needed because ms/s must divide by the bucket's OWN sampled seconds, not by
  // the number of windows (a background window is 2s, a duty window 5s).
  const cpuMsSums: Map<string, number>[] = []
  const bucketWindowMs: number[] = []
  const times: number[] = []
  const counts: number[] = []
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    sums.push(new Map())
    cpuMsSums.push(new Map())
    bucketWindowMs.push(0)
    counts.push(0)
  }
  for (let index = 0; index < ordered.length; index += 1) {
    const bucket = Math.min(buckets - 1, Math.floor((index * buckets) / ordered.length))
    const snapshot = ordered[index]
    if (snapshot === undefined) continue
    if (times[bucket] === undefined) times[bucket] = snapshot.windowStartedAt
    counts[bucket] = (counts[bucket] ?? 0) + 1
    const bucketSums = sums[bucket]
    if (bucketSums === undefined) continue
    bucketWindowMs[bucket] = (bucketWindowMs[bucket] ?? 0) + snapshot.global.sampleWindowMs
    const bucketCpuMs = cpuMsSums[bucket]
    for (const row of snapshot.plugins) {
      bucketSums.set(row.moduleName, (bucketSums.get(row.moduleName) ?? 0) + row.cpuShare)
      bucketCpuMs?.set(row.moduleName, (bucketCpuMs.get(row.moduleName) ?? 0) + row.cpuSelfMs)
    }
  }
  const names = new Set<string>()
  for (const bucketSums of sums) for (const name of bucketSums.keys()) names.add(name)
  const series: PerfTrendSeries[] = []
  for (const moduleName of names) {
    const shares = sums.map((bucketSums, bucket) => {
      const count = counts[bucket] ?? 0
      return count === 0 ? 0 : (bucketSums.get(moduleName) ?? 0) / count
    })
    const cpuMsPerSec = cpuMsSums.map((bucketCpuMs, bucket) => {
      const sampledMs = bucketWindowMs[bucket] ?? 0
      return sampledMs <= 0 ? 0 : (bucketCpuMs.get(moduleName) ?? 0) / (sampledMs / 1000)
    })
    series.push({ moduleName, shares, cpuMsPerSec })
  }
  series.sort((a, b) => peakOf(b.shares) - peakOf(a.shares))
  return { range, since, times, series, windowCount: ordered.length }
}

function peakOf(values: readonly number[]): number {
  let peak = 0
  for (const value of values) if (value > peak) peak = value
  return peak
}

