// The composition bars' data shaping: top-N naming, aggregation buckets, and
// the honesty rules for remainders and overshoots.

import { describe, expect, test } from 'vitest'
import { buildCpuSegments, buildHeapSegments, COMPOSITION_TOP_LIMIT } from '../../src/client/composition'
import type { PerfSnapshot, PluginMetricRow } from '../../src/shared/contract'

function row(moduleName: string, cpuShare: number, liveHeapBytes: number): PluginMetricRow {
  return {
    moduleName, entryId: moduleName, fiberPhase: 'active',
    cpuShare, cpuSelfMs: 0, liveHeapBytes, allocBytesPerSec: 0,
    fsReadOps: 0, fsWriteOps: 0, fsReadBytes: 0, fsWriteBytes: 0, coverage: 0,
    timers: 0, listeners: 0, handles: 0, diskFootprintBytes: 0,
  }
}

function snapshot(plugins: PluginMetricRow[], over: Partial<PerfSnapshot> = {}): PerfSnapshot {
  return {
    windowStartedAt: 1, mode: 'duty',
    global: {
      rss: 1024 * 1024, heapUsed: 1000, heapTotal: 2048, external: 0, arrayBuffers: 0,
      eventLoopLagP99Ms: 1, gcPauseMs: 1, fsOpsTotal: 0, sampleWindowMs: 5000,
      sampleCount: 100, idleSamples: 0, sampleIntervalMs: 0.5,
    },
    plugins,
    unattributedShare: 0,
    selfShare: 0,
    ...over,
  }
}

describe('buildCpuSegments', () => {
  test('names the top plugins, folds the rest, and keeps the remainder', () => {
    const plugins = Array.from({ length: 8 }, (_, index) => row('p' + index, 0.05, 0))
    const segments = buildCpuSegments(snapshot(plugins))
    // 5 named + 其他插件 + 空闲/未采样 (8 x 0.05 = 0.4 used → 0.6 free).
    expect(segments).toHaveLength(COMPOSITION_TOP_LIMIT + 2)
    expect(segments[0]?.label).toBe('p0')
    expect(segments[COMPOSITION_TOP_LIMIT]?.key).toBe('__rest')
    expect(segments[COMPOSITION_TOP_LIMIT]?.share).toBeCloseTo(0.15)
    const free = segments[segments.length - 1]
    expect(free?.key).toBe('__free')
    expect(free?.share).toBeCloseTo(0.6)
  })

  test('unattributed and self overhead are explicit slices', () => {
    const segments = buildCpuSegments(snapshot([row('busy', 0.5, 0)], { unattributedShare: 0.1, selfShare: 0.05 }))
    expect(segments.map(segment => segment.key)).toEqual(['busy', '__unattributed', '__self', '__free'])
    expect(segments[3]?.share).toBeCloseTo(0.35)
  })

  test('an overshooting estimate clamps the remainder instead of going negative', () => {
    const segments = buildCpuSegments(snapshot([row('hot', 0.95, 0)], { unattributedShare: 0.1 }))
    const free = segments.find(segment => segment.key === '__free')
    expect(free).toBeUndefined()
  })
})

describe('buildHeapSegments', () => {
  test('normalizes by heapUsed and shows the unclaimed heap explicitly', () => {
    const segments = buildHeapSegments(snapshot([row('a', 0, 400), row('b', 0, 100)]))
    // total 1000: a 40%, b 10%, unclaimed 50%.
    expect(segments.map(segment => [segment.key, Number(segment.share.toFixed(2))])).toEqual([
      ['a', 0.4],
      ['b', 0.1],
      ['__unclaimed', 0.5],
    ])
    expect(segments[0]?.bytes).toBe(400)
  })

  test('attribution overshoot normalizes against the attribution sum', () => {
    const segments = buildHeapSegments(snapshot([row('a', 0, 800), row('b', 0, 600)]))
    // heapUsed is 1000 but 1400 is attributed: the bar totals 1400.
    expect(segments[0]?.share).toBeCloseTo(800 / 1400)
    expect(segments.find(segment => segment.key === '__unclaimed')).toBeUndefined()
  })

  test('no heap baseline, no bar', () => {
    const snap = snapshot([row('a', 0, 100)])
    const zero = { ...snap, global: { ...snap.global, heapUsed: 0 } }
    expect(buildHeapSegments(zero)).toEqual([])
  })
})

describe('buildCpuSegments dedupe', () => {
  test('a self plugin row and selfShare never become two slices', () => {
    const segments = buildCpuSegments(snapshot([row('self', 0.12, 0), row('a', 0.3, 0)], { selfShare: 0.12 }))
    const selfSlices = segments.filter(segment => segment.key === '__self' || segment.key === 'self')
    expect(selfSlices).toHaveLength(1)
    expect(selfSlices[0]?.share).toBeCloseTo(0.12)
  })
})
