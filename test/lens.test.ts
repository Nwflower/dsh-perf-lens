// Orchestrator behavior: window length per mode, attribution into rows, history
// recording, deep mode, and the continuous-mode budget that must never leak.

import { describe, expect, test, vi } from 'vitest'
import { createOwnerIndex, type ProfileNode } from '../src/host/attribute'
import { HotspotStore } from '../src/host/hotspots'
import { collapseIoCounts, collapseOwnerCounts, continuousExpired, DEFAULT_LENS_OPTIONS, Lens, nextIdleWait, probesForActivity, type LensDeps } from '../src/host/lens'
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

function makeHarness(index = INDEX) {
  const sleeps: number[] = []
  const records: PerfSnapshot[] = []
  let nowValue = 0
  const sampler = {
    startCpu: vi.fn(async (_intervalUs?: number) => {}),
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
    ownerIndex: () => index,
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

describe('background profile', () => {
  test('uses the coarse interval and the short window', async () => {
    const h = makeHarness()
    const lens = new Lens(h.deps)
    lens.setMode('background')
    await lens.runWindow()
    expect(h.sleeps).toContain(DEFAULT_LENS_OPTIONS.backgroundWindowMs)
    expect(h.sampler.startCpu).toHaveBeenCalledWith(DEFAULT_LENS_OPTIONS.backgroundCpuIntervalUs)
    expect(lens.snapshot().mode).toBe('background')
  })

  test('sleeps the background interval regardless of how idle the window was', () => {
    expect(nextIdleWait('background', 30_000, 0, 120_000)).toBe(120_000)
    expect(nextIdleWait('background', 30_000, 0.99, 120_000)).toBe(120_000)
    expect(nextIdleWait('duty', 30_000, 0.99)).toBe(120_000)
    expect(nextIdleWait('duty', 30_000, 0.1)).toBe(30_000)
  })
})

describe('sentinel activity probing', () => {
  // A recorded window is all idle; a probe sees real work. The loop must stop
  // sleeping and take a fine window as soon as the probe says so.
  const IDLE_RESULT = {
    nodes: [{ id: 1, callFrame: { functionName: '(idle)', url: '' }, children: [] }],
    samples: Array<number>(50).fill(1),
  }
  const ACTIVE_RESULT = {
    nodes: [
      { id: 1, callFrame: { url: '/plugins/pluginA/index.mjs' }, children: [2] },
      { id: 2, callFrame: { url: '/shared/dep.mjs' }, children: [] },
    ],
    samples: Array<number>(50).fill(2),
  }

  test('reports the idle share without recording a window', async () => {
    const h = makeHarness()
    h.sampler.stopCpu.mockResolvedValue({
      nodes: [
        { id: 1, callFrame: { functionName: '(idle)', url: '' }, children: [] },
        { id: 2, callFrame: { url: '/plugins/pluginA/index.mjs' }, children: [] },
      ],
      samples: [...Array<number>(95).fill(1), ...Array<number>(5).fill(2)],
    })
    const lens = new Lens(h.deps)
    const idleShare = await lens.runSentinel()
    expect(idleShare).toBeCloseTo(0.95, 5)
    // A coarse window's shares are noise, so it must never reach the history.
    expect(h.records).toHaveLength(0)
    expect(h.sampler.startCpu).toHaveBeenCalledWith(DEFAULT_LENS_OPTIONS.sentinelCpuIntervalUs)
    expect(h.sleeps).toContain(DEFAULT_LENS_OPTIONS.sentinelWindowMs)
  })

  test('probes only when duty has backed off after an idle window', () => {
    expect(probesForActivity('duty', true, 0.99, null)).toBe(true)
    expect(probesForActivity('duty', true, 0.1, null)).toBe(false)
    expect(probesForActivity('background', true, 0.99, null)).toBe(false)
    expect(probesForActivity('continuous', true, 0.99, null)).toBe(false)
    expect(probesForActivity('duty', false, 0.99, null)).toBe(false)
    expect(probesForActivity('duty', true, 0.99, 'boom')).toBe(false)
  })

  test('the duty loop takes a real window as soon as a probe finds activity', async () => {
    const h = makeHarness()
    const intervals: number[] = []
    let lastInterval = 0
    h.sampler.startCpu = vi.fn(async (intervalUs?: number) => {
      lastInterval = intervalUs ?? 0
      intervals.push(intervalUs ?? 0)
    })
    h.sampler.stopCpu = vi.fn(async () => (
      lastInterval === DEFAULT_LENS_OPTIONS.sentinelCpuIntervalUs ? ACTIVE_RESULT : IDLE_RESULT
    ))
    const clock = {
      sleep: async (): Promise<void> => { await new Promise<void>(resolve => { setTimeout(resolve, 0) }) },
      now: () => 0,
    }
    const lens = new Lens({ ...h.deps, clock }, { ...DEFAULT_LENS_OPTIONS, sentinelIdleMs: 5 })
    lens.start()
    await new Promise<void>(resolve => { setTimeout(resolve, 40) })
    lens.stop()
    const probeAt = intervals.indexOf(DEFAULT_LENS_OPTIONS.sentinelCpuIntervalUs)
    expect(probeAt).toBeGreaterThan(-1)
    expect(intervals[probeAt + 1]).toBe(DEFAULT_LENS_OPTIONS.cpuIntervalUs)
  })
})

describe('async re-attribution (mechanism C)', () => {
  const ASYNC_INDEX = createOwnerIndex([
    { kind: 'plugin', name: 'pluginA', prefix: '/plugins/pluginA/' },
    { kind: 'harness', name: '@deepseek-ai/dsh', prefix: '/dsh/' },
  ])
  // Every sample is a harness frame, but all of them fall inside a window
  // owned by pluginA: the work the plugin scheduled.
  const HARNESS_ONLY = {
    nodes: [{ id: 10, callFrame: { url: '/dsh/scheduler.js' }, children: [] }],
    samples: Array<number>(10).fill(10),
    timeDeltas: Array<number>(10).fill(1000),
    startTime: 0,
    endTime: 10_000,
    startedAtUs: 0,
    endedAtUs: 10_000,
  }
  const recorder = () => ({
    enabled: false,
    setOwnerIndex: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    take: vi.fn(() => ({
      windows: [{ asyncId: 5, startUs: 0, endUs: 100_000 }],
      ownerOf: new Map<number, string>([[5, 'plugin:pluginA']]),
    })),
  })

  test('deep mode moves plugin-scheduled harness frames back to the plugin', async () => {
    const h = makeHarness(ASYNC_INDEX)
    h.sampler.stopCpu = vi.fn(async () => HARNESS_ONLY)
    const lens = new Lens(
      { ...h.deps, ownerIndex: () => ASYNC_INDEX, asyncAttribution: recorder() as unknown as LensDeps['asyncAttribution'] },
      { ...DEFAULT_LENS_OPTIONS, deep: true },
    )
    const snapshot = await lens.runWindow()
    expect(snapshot.plugins.find(row => row.moduleName === 'pluginA')?.cpuShare).toBe(1)
    expect(snapshot.plugins.find(row => row.moduleName === 'harness')).toBeUndefined()
    expect(lens.diagnostics().asyncWindowedSamples).toBe(10)
    expect(lens.diagnostics().asyncReattributedSamples).toBe(10)
  })

  test('without deep mode the same window stays on harness', async () => {
    const h = makeHarness(ASYNC_INDEX)
    h.sampler.stopCpu = vi.fn(async () => HARNESS_ONLY)
    const lens = new Lens({ ...h.deps, ownerIndex: () => ASYNC_INDEX })
    const snapshot = await lens.runWindow()
    expect(snapshot.plugins.find(row => row.moduleName === 'harness')?.cpuShare).toBe(1)
    expect(lens.diagnostics().asyncReattributedSamples).toBe(0)
  })

  test('a profile without V8 timing fields degrades to stack attribution', async () => {
    const h = makeHarness(ASYNC_INDEX)
    h.sampler.stopCpu = vi.fn(async () => ({ nodes: HARNESS_ONLY.nodes, samples: HARNESS_ONLY.samples }))
    const lens = new Lens(
      { ...h.deps, ownerIndex: () => ASYNC_INDEX, asyncAttribution: recorder() as unknown as LensDeps['asyncAttribution'] },
      { ...DEFAULT_LENS_OPTIONS, deep: true },
    )
    const snapshot = await lens.runWindow()
    expect(snapshot.plugins.find(row => row.moduleName === 'harness')?.cpuShare).toBe(1)
  })
})

describe('harness folding', () => {
  test('collapseOwnerCounts sums every harness subpackage into one owner', () => {
    const folded = collapseOwnerCounts(new Map([
      ['harness:@deepseek-ai/dsh-a', 3],
      ['harness:@deepseek-ai/dsh-b', 4],
      ['plugin:x', 5],
      ['runtime', 1],
    ]))
    expect(folded.get('harness')).toBe(7)
    expect(folded.get('plugin:x')).toBe(5)
    expect(folded.get('runtime')).toBe(1)
  })

  test('collapseIoCounts folds read and write counts additively', () => {
    const folded = collapseIoCounts(new Map([
      ['harness:a', { read: 1, write: 2 }],
      ['harness:b', { read: 3, write: 4 }],
    ]))
    expect(folded.get('harness')).toEqual({ read: 4, write: 6 })
  })

  test('a window with two harness owners yields one harness row', async () => {
    const h = makeHarness()
    h.sampler.stopCpu.mockResolvedValue({
      nodes: [
        { id: 1, callFrame: { url: '/dsh/a/x.js' }, children: [] },
        { id: 2, callFrame: { url: '/dsh/b/y.js' }, children: [] },
      ],
      samples: [1, 2, 2],
    })
    const lens = new Lens({
      ...h.deps,
      ownerIndex: () => createOwnerIndex([
        { kind: 'harness', name: 'dsh-a', prefix: '/dsh/a/' },
        { kind: 'harness', name: 'dsh-b', prefix: '/dsh/b/' },
      ]),
    })
    const snapshot = await lens.runWindow()
    const harnessRows = snapshot.plugins.filter(row => row.moduleName.startsWith('harness'))
    expect(harnessRows).toHaveLength(1)
    expect(harnessRows[0]?.moduleName).toBe('harness')
    expect(harnessRows[0]?.cpuShare).toBe(1)
  })
})


describe('harness breakdown (the ranking the fold hides)', () => {
  const HARNESS_INDEX = createOwnerIndex([
    { kind: 'harness', name: '@deepseek-ai/dsh-client-hmr', prefix: '/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-hmr/' },
    { kind: 'harness', name: '@deepseek-ai/dsh-subprocess-local', prefix: '/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/' },
    { kind: 'harness', name: '@deepseek-ai/dsh', prefix: '/npm/node_modules/@deepseek-ai/dsh/' },
    { kind: 'plugin', name: 'pluginA', prefix: '/plugins/pluginA/' },
  ])
  const HARNESS_NODES: ProfileNode[] = [
    { id: 1, callFrame: { url: '/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-hmr/lib/index.js' } },
    { id: 2, callFrame: { url: '/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js' } },
    { id: 3, callFrame: { url: '/npm/node_modules/@deepseek-ai/dsh/lib/bin.js' } },
    { id: 4, callFrame: { url: '/plugins/pluginA/index.mjs' } },
  ]
  const HARNESS_SAMPLES = [
    ...Array<number>(30).fill(1),
    ...Array<number>(20).fill(2),
    ...Array<number>(10).fill(3),
    ...Array<number>(40).fill(4),
  ]

  test('keeps the sub-package ranking beside the folded harness row', async () => {
    const h = makeHarness(HARNESS_INDEX)
    h.sampler.stopCpu = vi.fn(async () => ({ nodes: HARNESS_NODES, samples: HARNESS_SAMPLES }))
    const snapshot = await new Lens(h.deps).runWindow()
    // The board still sees ONE folded harness row (60 of 100 active samples).
    const folded = snapshot.plugins.find(row => row.moduleName === 'harness')
    expect(folded?.cpuShare).toBeCloseTo(0.6, 5)
    expect(snapshot.plugins.some(row => row.moduleName.startsWith('harness:'))).toBe(false)
    // ...and the breakdown names the packages behind it, biggest first.
    const names = (snapshot.harnessBreakdown ?? []).map(row => row.moduleName)
    expect(names).toEqual([
      'harness:@deepseek-ai/dsh-client-hmr',
      'harness:@deepseek-ai/dsh-subprocess-local',
      'harness:@deepseek-ai/dsh',
    ])
    const top = snapshot.harnessBreakdown?.[0]
    expect(top?.cpuSelfMs).toBeCloseTo(30 * (DEFAULT_LENS_OPTIONS.cpuIntervalUs / 1000), 5)
    expect(top?.cpuShare).toBeCloseTo(0.3, 5)
  })

  test('an owner with no harness cost produces no breakdown rows', async () => {
    const h = makeHarness()
    const snapshot = await new Lens(h.deps).runWindow()
    expect(snapshot.harnessBreakdown).toEqual([])
  })
})