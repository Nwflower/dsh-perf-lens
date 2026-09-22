// Range aggregation over recorded windows: "which plugin has cost the most
// over the last day/week" and "how spiky is it".
//
// Pure functions over snapshots: no ctx, no clock, no I/O, so the arithmetic is
// unit-testable exactly like attribute.ts. The route layer supplies the
// snapshots (ring buffer + JSONL) and the range.

import type { PerfRange, PerfStats, PerfSnapshot, PluginStatsRow } from '../shared/contract'

/** Range to a start timestamp. Unknown ranges fall back to 24h. */
export function rangeToSince(range: string, now: number): { range: PerfRange; since: number } {
  switch (range) {
    case '1h': return { range: '1h', since: now - 60 * 60 * 1000 }
    case '7d': return { range: '7d', since: now - 7 * 24 * 60 * 60 * 1000 }
    default: return { range: '24h', since: now - 24 * 60 * 60 * 1000 }
  }
}

/** Nearest-rank percentile of an already sorted ascending array, 0..1. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil(fraction * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index] ?? 0
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
