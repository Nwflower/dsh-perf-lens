// Orchestrator behavior: window length per mode, attribution into rows, history
// recording, deep mode, and the continuous-mode budget that must never leak.

import { describe, expect, test, vi } from 'vitest'
import { createOwnerIndex, type ProfileNode } from '../src/host/attribute'
import { HotspotStore } from '../src/host/hotspots'
import { continuousExpired, DEFAULT_LENS_OPTIONS, Lens, nextIdleWait, type LensDeps } from '../src/host/lens'
import type { Sampler } from '../src/host/sampler'
import type { PerfSnapshot } from '../src/shared/contract'

const INDEX = createOwnerIndex([
  { kind: 'plugin', name: 'pluginA', prefix: '/plugins/pluginA/' },
  { kind: 'plugin', name: 'pluginB', prefix: '/plugins/pluginB/' },
])

// Same 200:60 shape as evidence 5, sampled through a shared dependency.
const NODES = [
  { id: 1, callFrame: { url: '/plugins/pluginA/index.mjs' }, children: [2] },
  { id: 2, callFrame: { url: '/shared/dep.mjs' }, children: [] },
  { id: 4, callFrame: { url: '/plugins/pluginB/index.mjs' }, children: [5] },
  { id: 5, callFrame: { url: '/shared/dep.mjs' }, children: [] },
]
const SAMPLES = [...Array<number>(200).fill(2), ...Array<number>(60).fill(5)]

function makeHarness() {
  const sleeps: number[] = []
  const records: PerfSnapshot[] = []
  let nowValue = 0
  const sampler = {
    startCpu: vi.fn(async () => {}),
    stopCpu: vi.fn(async (): Promise<{ nodes: ProfileNode[]; samples: number[] }> => ({ nodes: NODES, samples: SAMPLES })),
    startHeap: vi.fn(async () => {}),
    stopHeap: vi.fn(async () => ({ head: { selfSize: 4096, children: [] } })),
    dispose: vi.fn(async () => {}),
  }
  const io = {
    setOwnerIndex: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    take: () => ({ perOwner: new Map([['plugin:pluginA', { read: 2, write: 1 }]]), total: 3 }),
  }
  const metrics = {
    start: vi.fn(),
    stop: vi.fn(),
    read: (windowMs: number, sampleCount: number) => ({
      rss: 1, heapUsed: 2, heapTotal: 3, external: 4, arrayBuffers: 5,
      eventLoopLagP99Ms: 6, gcPauseMs: 7, fsOpsTotal: 8, sampleWindowMs: windowMs, sampleCount, idleSamples: 0,
    }),
  }
  const history = {
    record: vi.fn((snapshot: PerfSnapshot) => { records.push(snapshot) }),
    read: () => [],
    recent: () => records,
  }
  const clock = {
    sleep: vi.fn(async (ms: number) => { sleeps.push(ms) }),
    now: () => nowValue,
  }
  const deps: LensDeps = {
    sampler: sampler as unknown as Sampler,
    io: io as unknown as LensDeps['io'],
    metrics: metrics as unknown as LensDeps['metrics'],
    history: history as unknown as LensDeps['history'],
    plugins: () => [
      { moduleName: 'pluginA', entryId: 'a', fiberPhase: 'active' },
      { moduleName: 'pluginB', entryId: 'b', fiberPhase: 'active' },
    ],
    ownerIndex: () => INDEX,
    clock,
  }
  return {
    deps, sampler, io, metrics, history, sleeps, records,
    setNow: (value: number) => { nowValue = value },
  }
}

describe('Lens.runWindow', () => {
  test('attributes the shared-dependency samples to the calling plugins', async () => {
    const h = makeHarness()
    const lens = new Lens(h.deps)
    const snapshot = await lens.runWindow()
    const rowA = snapshot.plugins.find(row => row.moduleName === 'pluginA')
    const rowB = snapshot.plugins.find(row => row.moduleName === 'pluginB')
    expect(rowA?.cpuShare).toBeCloseTo(200 / 260, 5)
    expect(rowB?.cpuShare).toBeCloseTo(60 / 260, 5)
    expect(snapshot.unattributedShare).toBe(0)
    expect(snapshot.global.sampleCount).toBe(260)
    expect(h.records).toHaveLength(1)
  })

  test('collects hot functions only in deep mode and clears them when it is off', async () => {
    const h = makeHarness()
    const store = new HotspotStore()
    const lens = new Lens({ ...h.deps, hotspots: store })
    await lens.runWindow()
    expect(store.get('pluginA')).toBeNull()
    lens.setDeep(true)
    await lens.runWindow()
    expect(store.get('pluginA')).not.toBeNull()
    lens.setDeep(false)
    await lens.runWindow()
    expect(store.get('pluginA')).toBeNull()
  })

  test('carries exact fs operation counts and the window length', async () => {
    const h = makeHarness()
    const lens = new Lens(h.deps)
    const snapshot = await lens.runWindow()
    const rowA = snapshot.plugins.find(row => row.moduleName === 'pluginA')
    expect(rowA?.fsReadOps).toBe(2)
    expect(rowA?.fsWriteOps).toBe(1)
    expect(snapshot.global.sampleWindowMs).toBe(DEFAULT_LENS_OPTIONS.windowMs)
    expect(h.sleeps).toContain(DEFAULT_LENS_OPTIONS.windowMs)
  })

  test('continuous mode uses the short window', async () => {
    const h = makeHarness()
    const lens = new Lens(h.deps)
    lens.setMode('continuous')
    await lens.runWindow()
    expect(h.sleeps).toContain(DEFAULT_LENS_OPTIONS.continuousWindowMs)
    expect(lens.snapshot().mode).toBe('continuous')
  })

  test('idle samples are separated and excluded from the share denominator', async () => {
    const h = makeHarness()
    h.sampler.stopCpu.mockResolvedValue({
      nodes: [
        { id: 1, callFrame: { functionName: '(idle)', url: '' }, children: [] },
        { id: 2, callFrame: { functionName: '(root)', url: '' }, children: [1] },
        { id: 3, callFrame: { url: '/plugins/pluginA/index.mjs' }, children: [4] },
        { id: 4, callFrame: { url: '/shared/dep.mjs' }, children: [] },
      ],
      samples: [...Array<number>(100).fill(1), ...Array<number>(200).fill(4)],
    })
    const lens = new Lens(h.deps)
    const snapshot = await lens.runWindow()
    expect(snapshot.global.sampleCount).toBe(300)
    expect(snapshot.global.idleSamples).toBe(100)
    // 200 active samples, all pluginA: a 100% share, not 200/300.
    expect(snapshot.plugins.find(row => row.moduleName === 'pluginA')?.cpuShare).toBe(1)
    expect(snapshot.plugins.find(row => row.moduleName === 'idle')).toBeUndefined()
  })

  test('deep mode samples the heap as well', async () => {
    const h = makeHarness()
    const lens = new Lens(h.deps)
    lens.setDeep(true)
    await lens.runWindow()
    expect(h.sampler.startHeap).toHaveBeenCalledTimes(1)
    expect(h.sampler.stopHeap).toHaveBeenCalledTimes(1)
  })

  test('always disables the io tracker, even on failure', async () => {
    const h = makeHarness()
    h.sampler.stopCpu.mockRejectedValueOnce(new Error('boom'))
    const lens = new Lens(h.deps)
    await expect(lens.runWindow()).rejects.toThrow('boom')
    expect(h.io.disable).toHaveBeenCalled()
  })
})

describe('diagnostics', () => {
  test('reports the window, tally keys and owner rules', async () => {
    const h = makeHarness()
    const lens = new Lens(h.deps)
    await lens.runWindow()
    const diagnostics = lens.diagnostics()
    expect(diagnostics.sampleCount).toBe(260)
    expect(diagnostics.ownerKeys).toContain('plugin:pluginA')
    expect(diagnostics.ownerRules).toHaveLength(2)
    expect(diagnostics.lastError).toBeNull()
  })

  test('the duty loop records a swallowed window error', async () => {
    const h = makeHarness()
    h.sampler.startCpu.mockRejectedValue(new Error('profiler exploded'))
    // The window fails before it sleeps, so the loop reaches the idle sleep
    // immediately; stopping there keeps this test to exactly one iteration
    // instead of spinning a microtask loop that starves the event loop.
    let lens: Lens | undefined
    const clock = {
      sleep: async (): Promise<void> => {
        lens?.stop()
        await new Promise<void>(resolve => { setTimeout(resolve, 0) })
      },
      now: () => 0,
    }
    lens = new Lens({ ...h.deps, clock })
    lens.start()
    await new Promise<void>(resolve => { setTimeout(resolve, 20) })
    lens.stop()
    expect(lens.diagnostics().lastError).toContain('profiler exploded')
  })
})

describe('loop safety', () => {
  test('setMode wakes the idle sleep so controls take effect immediately', async () => {
    const h = makeHarness()
    const clock = {
      sleep: (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) }),
      now: () => Date.now(),
    }
    const lens = new Lens(
      { ...h.deps, clock },
      { ...DEFAULT_LENS_OPTIONS, windowMs: 20, idleMs: 10_000, continuousWindowMs: 20 },
    )
    lens.start()
    await new Promise<void>(resolve => { setTimeout(resolve, 60) })
    const first = lens.diagnostics().windowStartedAt
    lens.setMode('continuous')
    await new Promise<void>(resolve => { setTimeout(resolve, 80) })
    lens.stop()
    // Without the wake, the loop would still be inside the 10s idle sleep.
    expect(lens.diagnostics().windowStartedAt).toBeGreaterThan(first)
  })

  test('a synchronously failing window in continuous mode does not starve the event loop', async () => {
    const h = makeHarness()
    // Real timers: a continuous-mode loop that fails before its first await must
    // still yield a macrotask per iteration, or it starves the host process.
    const clock = {
      sleep: (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) }),
      now: () => Date.now(),
    }
    const lens = new Lens({
      ...h.deps,
      clock,
      ownerIndex: () => { throw new Error('owner index exploded') },
    })
    lens.setMode('continuous')
    lens.start()
    const macrotaskRan = await new Promise<boolean>(resolve => {
      setTimeout(() => { resolve(true) }, 20)
      setTimeout(() => { resolve(false) }, 2000)
    })
    lens.stop()
    expect(macrotaskRan).toBe(true)
    expect(lens.diagnostics().lastError).toContain('owner index exploded')
  })
})

describe('idle backoff', () => {
  test('stretches the duty sleep after a mostly-idle window', () => {
    // 30s * factor 4 = 120s, the cap.
    expect(nextIdleWait('duty', 30_000, 0.99)).toBe(120_000)
    expect(nextIdleWait('duty', 30_000, 0.1)).toBe(30_000)
  })

  test('never backs off continuous mode', () => {
    expect(nextIdleWait('continuous', 30_000, 0.99)).toBe(0)
  })
})

describe('continuous mode budget', () => {
  test('a failing window backs off instead of hammering', async () => {
    const h = makeHarness()
    const sleeps: number[] = []
    const clock = {
      sleep: async (ms: number) => { sleeps.push(ms); await new Promise<void>(resolve => { setTimeout(resolve, 0) }) },
      now: () => Date.now(),
    }
    const lens = new Lens({ ...h.deps, clock, ownerIndex: () => { throw new Error('boom') } })
    lens.setMode('continuous')
    lens.start()
    await new Promise<void>(resolve => { setTimeout(resolve, 30) })
    lens.stop()
    expect(sleeps.some(ms => ms >= 30_000)).toBe(true)
  })

  test('expires only after the configured maximum', () => {
    expect(continuousExpired('continuous', 1000, 0, 600_000)).toBe(false)
    expect(continuousExpired('continuous', 600_001, 0, 600_000)).toBe(true)
    expect(continuousExpired('duty', 999_999, 0, 600_000)).toBe(false)
  })
})

describe('Lens lifecycle', () => {
  test('dispose stops sampling and instrumentation', async () => {
    const h = makeHarness()
    const lens = new Lens(h.deps)
    await lens.dispose()
    expect(h.io.disable).toHaveBeenCalled()
    expect(h.metrics.stop).toHaveBeenCalled()
    expect(h.sampler.dispose).toHaveBeenCalled()
    expect(lens.running).toBe(false)
  })
})
