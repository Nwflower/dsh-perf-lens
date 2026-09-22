// The trend chart's data shaping and the "hide 0% plugins" rule.

import { describe, expect, test } from 'vitest'
import { buildSeries, totalSeries } from '../../src/client/trend-chart'
import type { PerfTrend } from '../../src/shared/contract'

function trend(series: { moduleName: string; shares: number[] }[], times = [1000, 2000]): PerfTrend {
  return { range: '24h', since: 0, times, series, windowCount: times.length }
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
