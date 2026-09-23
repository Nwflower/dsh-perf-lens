// Range aggregation arithmetic: averages, peaks, percentiles and the
// coverage-scaled estimate. Pure functions, so the numbers are locked exactly.

import { describe, expect, test } from 'vitest'
import { aggregateStats, aggregateTrend, percentile, rangeToSince } from '../src/host/stats'
import type { PerfSnapshot, PluginMetricRow } from '../src/shared/contract'

function row(moduleName: string, cpuShare: number, cpuSelfMs: number): PluginMetricRow {
  return {
    moduleName, entryId: moduleName, fiberPhase: 'active', cpuShare, cpuSelfMs,
    liveHeapBytes: 0, allocBytesPerSec: 0, fsReadOps: 0, fsWriteOps: 0,
    fsReadBytes: 0, fsWriteBytes: 0, coverage: 0, timers: 0, listeners: 0, handles: 0,
    diskFootprintBytes: 0,
  }
}

function snapshot(at: number, windowMs: number, plugins: PluginMetricRow[]): PerfSnapshot {
  return {
    windowStartedAt: at, mode: 'duty',
    global: {
      rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0,
      eventLoopLagP99Ms: 0, gcPauseMs: 0, fsOpsTotal: 0,
      sampleWindowMs: windowMs, sampleCount: 10, idleSamples: 0, sampleIntervalMs: 0.5,
    },
    plugins, unattributedShare: 0, selfShare: 0,
  }
}

describe('rangeToSince', () => {
  const now = 1_000_000_000
  test('maps known ranges', () => {
    expect(rangeToSince('1h', now)).toEqual({ range: '1h', since: now - 3_600_000 })
    expect(rangeToSince('24h', now)).toEqual({ range: '24h', since: now - 86_400_000 })
    expect(rangeToSince('7d', now)).toEqual({ range: '7d', since: now - 7 * 86_400_000 })
  })
  test('unknown ranges fall back to 24h', () => {
    expect(rangeToSince('nonsense', now).range).toBe('24h')
  })
})

describe('percentile', () => {
  test('empty input is zero', () => {
    expect(percentile([], 0.95)).toBe(0)
  })
  test('nearest rank', () => {
    const sorted = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    expect(percentile(sorted, 0.95)).toBe(9)
    expect(percentile(sorted, 0.5)).toBe(4)
    expect(percentile([2], 0.95)).toBe(2)
  })
})

describe('aggregateStats', () => {
  const now = 100_000
  const since = now - 10_000

  test('computes avg, peak, p95 and cumulative per plugin', () => {
    const snapshots = [
      snapshot(91_000, 5_000, [row('a', 0.10, 1), row('b', 0.30, 3)]),
      snapshot(93_000, 5_000, [row('a', 0.20, 2), row('b', 0.10, 1)]),
      snapshot(95_000, 5_000, [row('a', 0.60, 6)]),
    ]
    const stats = aggregateStats(snapshots, '24h', since, now)
    expect(stats.windowCount).toBe(3)
    expect(stats.sampledWindowMs).toBe(15_000)
    // 15s sampled over a 10s range is capped at full coverage.
    expect(stats.coverage).toBe(1)
    const a = stats.plugins.find(p => p.moduleName === 'a')
    expect(a).toMatchObject({
      avgCpuShare: 0.3,
      peakCpuShare: 0.6,
      cumulativeCpuMs: 9,
      estimatedCpuMs: 9,
      windows: 3,
    })
    const b = stats.plugins.find(p => p.moduleName === 'b')
    // b is absent from the third window; absence counts as a zero window, so the
    // average is over all three (persisted windows drop all-zero rows).
    expect(b).toMatchObject({ avgCpuShare: 0.4 / 3, peakCpuShare: 0.3, cumulativeCpuMs: 4, windows: 2 })
  })

  test('a window without a row counts as zero in the average', () => {
    const snapshots = [
      snapshot(91_000, 5_000, [row('spiky', 0.5, 5)]),
      snapshot(93_000, 5_000, []),
      snapshot(95_000, 5_000, []),
    ]
    const stats = aggregateStats(snapshots, '24h', since, now)
    const spiky = stats.plugins.find(p => p.moduleName === 'spiky')
    expect(spiky?.avgCpuShare).toBeCloseTo(0.5 / 3, 10)
    expect(spiky?.peakCpuShare).toBe(0.5)
    expect(spiky?.windows).toBe(1)
  })

  test('coverage scales the estimate and never exceeds one', () => {
    // 5s sampled over a 100s range: 5% coverage.
    const snapshots = [snapshot(now - 5_000, 5_000, [row('a', 0.5, 10)])]
    const stats = aggregateStats(snapshots, '24h', now - 100_000, now)
    expect(stats.coverage).toBeCloseTo(0.05, 10)
    const a = stats.plugins[0]
    expect(a?.cumulativeCpuMs).toBe(10)
    expect(a?.estimatedCpuMs).toBeCloseTo(200, 10)
    expect(a?.coverage).toBeCloseTo(0.05, 10)
  })

  test('drops windows before since and sorts by cumulative cost', () => {
    const snapshots = [
      snapshot(50_000, 5_000, [row('old', 0.9, 90)]),
      snapshot(now - 2_000, 5_000, [row('cheap', 0.1, 1), row('pricey', 0.2, 20)]),
    ]
    const stats = aggregateStats(snapshots, '24h', now - 10_000, now)
    expect(stats.windowCount).toBe(1)
    expect(stats.plugins.map(p => p.moduleName)).toEqual(['pricey', 'cheap'])
  })

  test('an empty range yields zero coverage, not a division blowup', () => {
    const stats = aggregateStats([], '24h', since, since)
    expect(stats).toMatchObject({ windowCount: 0, sampledWindowMs: 0, coverage: 0, plugins: [] })
  })
})
describe('aggregateTrend', () => {
  test('averages each bucket and keeps every plugin name', () => {
    const snapshots = [
      snapshot(1000, 5000, [row('a', 0.10, 1), row('b', 0.30, 3)]),
      snapshot(2000, 5000, [row('a', 0.20, 2)]),
      snapshot(3000, 5000, [row('a', 0.60, 6)]),
      snapshot(4000, 5000, [row('a', 0.80, 8)]),
    ]
    // Two points: windows [0,1] and [2,3].
    const trend = aggregateTrend(snapshots, '24h', 0, 2)
    expect(trend.windowCount).toBe(4)
    expect(trend.times).toEqual([1000, 3000])
    const a = trend.series.find(s => s.moduleName === 'a')
    // Bucket 0: (0.10 + 0.20) / 2; bucket 1: (0.60 + 0.80) / 2.
    expect(a?.shares[0]).toBeCloseTo(0.15, 10)
    expect(a?.shares[1]).toBeCloseTo(0.7, 10)
    const b = trend.series.find(s => s.moduleName === 'b')
    // b is absent from bucket 0's second window and all of bucket 1: zeros count.
    expect(b?.shares[0]).toBeCloseTo(0.15, 10)
    expect(b?.shares[1]).toBe(0)
  })

  test('carries the absolute basis per bucket, divided by sampled seconds', () => {
    const snapshots = [
      snapshot(1000, 5000, [row('a', 0.10, 5)]),
      snapshot(2000, 5000, [row('a', 0.20, 15)]),
      snapshot(3000, 5000, [row('a', 0.60, 30)]),
    ]
    const trend = aggregateTrend(snapshots, '24h', 0, 2)
    const a = trend.series.find(s => s.moduleName === 'a')
    // Bucket 0: (5 + 15) ms over (5 + 5) s = 2 ms/s. Bucket 1: 30 ms over 5 s.
    expect(a?.cpuMsPerSec[0]).toBeCloseTo(2, 10)
    expect(a?.cpuMsPerSec[1]).toBeCloseTo(6, 10)
  })

  test('downsamples to at most maxPoints and sorts by peak', () => {
    const snapshots = Array.from({ length: 300 }, (_, index) =>
      snapshot(index * 1000, 5000, [row('low', 0.01, 1), row('high', 0.5, 5)]))
    const trend = aggregateTrend(snapshots, '24h', 0, 120)
    expect(trend.times).toHaveLength(120)
    expect(trend.series[0]?.moduleName).toBe('high')
    expect(trend.series[0]?.shares).toHaveLength(120)
  })

  test('drops windows before since and handles an empty range', () => {
    const trend = aggregateTrend([snapshot(1, 5000, [row('a', 0.5, 1)])], '24h', 5000, 120)
    expect(trend).toMatchObject({ windowCount: 0, times: [], series: [] })
  })
})

