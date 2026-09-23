// The trend chart's data shaping and the "hide 0% plugins" rule.

import { describe, expect, test } from 'vitest'
import { buildSeries, totalSeries } from '../../src/client/trend-chart'
import type { PerfTrend } from '../../src/shared/contract'

function trend(
  series: { moduleName: string; shares: number[]; cpuMsPerSec?: number[] }[],
  times = [1000, 2000],
): PerfTrend {
  return {
    range: '24h', since: 0, times, windowCount: times.length,
    // Default absolute values keep the old cases focused on the hide rule;
    // the metric cases pass explicit cpuMsPerSec.
    series: series.map(item => ({
      moduleName: item.moduleName,
      shares: item.shares,
      cpuMsPerSec: item.cpuMsPerSec ?? item.shares.map(share => share * 10),
    })),
  }
}

describe('buildSeries', () => {
  test('keeps every series above the threshold, in host order', () => {
    const built = buildSeries(trend([
      { moduleName: 'busy', shares: [0.5, 0.4] },
      { moduleName: 'idle', shares: [0, 0] },
    ]), 0.005)
    expect(built.map(item => item.name)).toEqual(['busy'])
    expect(built[0]?.values).toEqual([0.5, 0.4])
  })

  test('a plugin that merely idled is hidden; one that peaked is kept', () => {
    const built = buildSeries(trend([
      { moduleName: 'spiky', shares: [0, 0, 0.3, 0] },
      { moduleName: 'flat', shares: [0.001, 0.001] },
    ]), 0.005)
    expect(built.map(item => item.name)).toEqual(['spiky'])
  })

  test('totalSeries counts what the hide rule dropped', () => {
    const source = trend([
      { moduleName: 'a', shares: [0.5, 0.4] },
      { moduleName: 'b', shares: [0, 0] },
    ])
    expect(totalSeries(source)).toBe(2)
    expect(buildSeries(source, 0.005)).toHaveLength(1)
  })
})

describe('drawnSeries caps', () => {
  test('draws at most DRAW_LIMIT series, peak-sorted, and hiddenNotes counts every drop', async () => {
    const { drawnSeries, hiddenNotes, DRAW_LIMIT, buildSeries } = await import('../../src/client/trend-chart')
    const many = Array.from({ length: 16 }, (_, index) => ({
      moduleName: 'p' + index,
      shares: [0.5 - index * 0.01, 0.4],
    }))
    const source = trend([...many, { moduleName: 'flat', shares: [0, 0] }])
    expect(buildSeries(source, 0.005)).toHaveLength(16)
    expect(drawnSeries(source, 0.005)).toHaveLength(DRAW_LIMIT)
    expect(drawnSeries(source, 0.005)[0]?.name).toBe('p0')
    expect(hiddenNotes(source, 0.005)).toHaveLength(2)
  })

  test('nothing hidden, no notes', async () => {
    const { hiddenNotes } = await import('../../src/client/trend-chart')
    expect(hiddenNotes(trend([{ moduleName: 'a', shares: [0.5, 0.4] }]), 0.005)).toEqual([])
  })
})

describe('metric bases', () => {
  test('absolute plots cpuMsPerSec, share plots shares, same selection', async () => {
    const { buildSeries } = await import('../../src/client/trend-chart')
    const source = trend([{ moduleName: 'busy', shares: [0.5, 0.4], cpuMsPerSec: [1.2, 0.8] }])
    expect(buildSeries(source, 0.005, 'share')[0]?.values).toEqual([0.5, 0.4])
    expect(buildSeries(source, 0.005, 'absolute')[0]?.values).toEqual([1.2, 0.8])
    // Selection still keys off the share peak, so a share-quiet plugin stays
    // out even when the absolute axis is showing.
    expect(buildSeries(source, 0.9, 'absolute')).toHaveLength(0)
  })

  test('formats each base in its own unit', async () => {
    const { formatTrendValue } = await import('../../src/client/trend-chart')
    expect(formatTrendValue(0.5, 'share')).toBe('50.0%')
    expect(formatTrendValue(1.2, 'absolute')).toBe('1.20ms/s')
    expect(formatTrendValue(15, 'absolute')).toBe('15.0ms/s')
    expect(formatTrendValue(150, 'absolute')).toBe('150ms/s')
    expect(formatTrendValue(0, 'absolute')).toBe('0ms/s')
  })
})
describe('absolute-basis availability', () => {
  test('a host without cpuMsPerSec falls back to shares instead of crashing', async () => {
    const { buildSeries, hasAbsoluteSeries } = await import('../../src/client/trend-chart')
    const stale = {
      range: '24h' as const, since: 0, times: [1000, 2000], windowCount: 2,
      series: [{ moduleName: 'a', shares: [0.4, 0.5] } as unknown as PerfTrend['series'][number]],
    }
    expect(hasAbsoluteSeries(stale)).toBe(false)
    // Asked for the absolute basis anyway, it must yield the share values, not
    // undefined.
    expect(buildSeries(stale, 0.005, 'absolute')[0]?.values).toEqual([0.4, 0.5])
    expect(hasAbsoluteSeries({ ...stale, series: [{ moduleName: 'a', shares: [0.4], cpuMsPerSec: [1] }] })).toBe(true)
  })
})