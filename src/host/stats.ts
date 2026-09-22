// Range aggregation over recorded windows: "which plugin has cost the most
// over the last day/week" and "how spiky is it".
//
// Pure functions over snapshots: no ctx, no clock, no I/O, so the arithmetic is
// unit-testable exactly like attribute.ts. The route layer supplies the
// snapshots (ring buffer + JSONL) and the range.

import type { PerfRange, PerfStats, PerfSnapshot, PerfTrend, PerfTrendSeries, PluginStatsRow } from '../shared/contract'
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
  snapshots: readonly PerfSnapshot[],
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
  const plugins: PluginStatsRow[] = []
  for (const [moduleName, acc] of byPlugin) {
    const sorted = [...acc.shares].sort((a, b) => a - b)
    const sum = acc.shares.reduce((total, share) => total + share, 0)
    plugins.push({
      moduleName,
      avgCpuShare: acc.shares.length === 0 ? 0 : sum / acc.shares.length,
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
  snapshots: readonly PerfSnapshot[],
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
  const times: number[] = []
  const counts: number[] = []
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    sums.push(new Map())
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
    for (const row of snapshot.plugins) {
      bucketSums.set(row.moduleName, (bucketSums.get(row.moduleName) ?? 0) + row.cpuShare)
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
    series.push({ moduleName, shares })
  }
  series.sort((a, b) => peakOf(b.shares) - peakOf(a.shares))
  return { range, since, times, series, windowCount: ordered.length }
}

function peakOf(values: readonly number[]): number {
  let peak = 0
  for (const value of values) if (value > peak) peak = value
  return peak
}

