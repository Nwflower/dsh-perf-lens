// Process-level readings for one window: the fs-operation delta and the
// process-CPU delta that calibrates the sampler against reality.

import { describe, expect, test } from 'vitest'
import { GlobalMetrics, type MetricsDeps } from '../src/host/metrics'

function makeDeps() {
  const state = {
    cpu: { user: 0, system: 0 },
    fsRead: 0,
    fsWrite: 0,
  }
  const deps: MetricsDeps = {
    memoryUsage: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4, arrayBuffers: 5 }),
    resourceUsage: () => ({ fsRead: state.fsRead, fsWrite: state.fsWrite }),
    cpuUsage: () => ({ ...state.cpu }),
    now: () => 0,
  }
  return { deps, state }
}

describe('GlobalMetrics', () => {
  test('processCpuMs is the window delta of user + system CPU', () => {
    const { deps, state } = makeDeps()
    const metrics = new GlobalMetrics(deps)
    metrics.start()
    // 12.5ms user + 2.5ms system while the window runs.
    state.cpu = { user: 12_500, system: 2_500 }
    const row = metrics.read(5000, 100)
    expect(row.processCpuMs).toBeCloseTo(15, 6)
    expect(row.sampleWindowMs).toBe(5000)
    expect(row.sampleCount).toBe(100)
    metrics.stop()
  })

  test('a second read measures only the CPU spent since the first', () => {
    const { deps, state } = makeDeps()
    const metrics = new GlobalMetrics(deps)
    metrics.start()
    state.cpu = { user: 10_000, system: 0 }
    expect(metrics.read(5000, 10).processCpuMs).toBeCloseTo(10, 6)
    // No further CPU: the next window reports zero, not the running total.
    expect(metrics.read(5000, 10).processCpuMs).toBe(0)
    state.cpu = { user: 13_000, system: 1_000 }
    expect(metrics.read(5000, 10).processCpuMs).toBeCloseTo(4, 6)
    metrics.stop()
  })

  test('a clock that steps backwards cannot produce a negative window', () => {
    const { deps, state } = makeDeps()
    const metrics = new GlobalMetrics(deps)
    metrics.start()
    state.cpu = { user: 10_000, system: 0 }
    metrics.read(5000, 10)
    state.cpu = { user: 9_000, system: 0 }
    expect(metrics.read(5000, 10).processCpuMs).toBe(0)
    metrics.stop()
  })

  test('fs operations are counted per window, not cumulatively', () => {
    const { deps, state } = makeDeps()
    const metrics = new GlobalMetrics(deps)
    metrics.start()
    state.fsRead = 4
    state.fsWrite = 3
    expect(metrics.read(5000, 10).fsOpsTotal).toBe(7)
    state.fsRead = 5
    expect(metrics.read(5000, 10).fsOpsTotal).toBe(1)
    metrics.stop()
  })
})
