// The trend chart's data shaping and the "hide 0% plugins" rule.

import { describe, expect, test } from 'vitest'
import { buildSeries } from '../../src/client/trend-chart'
import type { PerfSnapshot, PluginMetricRow } from '../../src/shared/contract'

function row(moduleName: string, cpuShare: number): PluginMetricRow {
  return {
    moduleName, entryId: moduleName, fiberPhase: 'active', cpuShare, cpuSelfMs: 0,
    liveHeapBytes: 0, allocBytesPerSec: 0, fsReadOps: 0, fsWriteOps: 0,
    fsReadBytes: 0, fsWriteBytes: 0, coverage: 0, timers: 0, listeners: 0, handles: 0,
    diskFootprintBytes: 0,
  }
}

function snapshot(at: number, plugins: PluginMetricRow[]): PerfSnapshot {
  return {
    windowStartedAt: at, mode: 'duty',
    global: {
      rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0,
      eventLoopLagP99Ms: 0, gcPauseMs: 0, fsOpsTotal: 0,
      sampleWindowMs: 5000, sampleCount: 1, idleSamples: 0,
    },
    plugins, unattributedShare: 0, selfShare: 0,
  }
}

describe('buildSeries', () => {
  test('aligns each plugin to the ordered windows, zero-filling gaps', () => {
    const series = buildSeries([
      snapshot(2000, [row('a', 0.2)]),
      snapshot(1000, [row('a', 0.1), row('b', 0.4)]),
    ])
    const a = series.find(item => item.name === 'a')
    const b = series.find(item => item.name === 'b')
    expect(a?.values).toEqual([0.1, 0.2])
    expect(b?.values).toEqual([0.4, 0])
  })

  test('the hide rule drops a plugin whose peak is below the threshold', () => {
    const series = buildSeries([snapshot(1000, [row('idle', 0)]), snapshot(2000, [row('busy', 0.5)])])
    const visible = series.filter(item => Math.max(...item.values, 0) >= 0.005)
    expect(visible.map(item => item.name)).toEqual(['busy'])
  })
})
