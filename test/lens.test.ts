// Orchestrator behavior: window length per mode, attribution into rows, history
// recording, deep mode, and the continuous-mode budget that must never leak.

import { describe, expect, test, vi } from 'vitest'
import { createOwnerIndex, type ProfileNode } from '../src/host/attribute'
import { HotspotStore } from '../src/host/hotspots'
import { collapseIoCounts, collapseOwnerCounts, continuousExpired, DEFAULT_LENS_OPTIONS, Lens, nextIdleWait, probesForActivity, sampleIntervalMs, type LensDeps } from '../src/host/lens'
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
    lens.setSampling({ memory: true })
    await lens.runWindow()
    expect(store.get('pluginA')).not.toBeNull()
    lens.setSampling({ memory: false })
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
    lens.setSampling({ intensity: 'high' })
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
    lens.setSampling({ memory: true })
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

  test('says which 0.2.0 collectors engaged, so an empty reading is not read as zero cost', async () => {
    const h = makeHarness()
    // No collectors wired at all: the harness used by every other test.
    const bare = new Lens(h.deps).diagnostics()
    expect(bare.processTree).toEqual({ available: false, at: 0, count: 0, coverage: 0 })
    expect(bare.diskFootprint).toBeNull()
    expect(bare.listenersMeasured).toBe(false)

    const wired = new Lens({
      ...h.deps,
      listenerCounts: () => new Map([['plugin:pluginA', 3]]),
      processTree: () => ({ at: 42, count: 2, rssBytes: 100, cpuCoreShare: 1.5, intervalMs: 30_000, coverage: 0.5, top: [] }),
      diskFootprintReading: () => ({ scannedAt: 7, scannedFiles: 9, scannedBytes: 100, ownedBytes: 60, truncated: true }),
    }).diagnostics()
    expect(wired.processTree).toEqual({ available: true, at: 42, count: 2, coverage: 0.5 })
    expect(wired.diskFootprint).toEqual({ scannedAt: 7, scannedFiles: 9, ownedBytes: 60, truncated: true })
    expect(wired.listenersMeasured).toBe(true)
  })

  test('a listener registry that throws is reported as unmeasured, not as zero listeners', async () => {
    const h = makeHarness()
    const lens = new Lens({
      ...h.deps,
      listenerCounts: () => { throw new Error('registry exploded') },
    })
    expect(lens.diagnostics().listenersMeasured).toBe(false)
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
  test('setSampling wakes the idle sleep so controls take effect immediately', async () => {
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
    lens.setSampling({ intensity: 'high' })
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
    lens.setSampling({ intensity: 'high' })
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
    lens.setSampling({ intensity: 'high' })
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
    lens.setSampling({ intensity: 'paused', background: true })
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
    // 100 samples over a 50ms profile span: 0.5ms of CPU per sample.
    h.sampler.stopCpu = vi.fn(async () => ({ nodes: HARNESS_NODES, samples: HARNESS_SAMPLES, startTime: 0, endTime: 50_000 }))
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
    expect(top?.cpuSelfMs).toBeCloseTo(30 * 0.5, 5)
    expect(top?.cpuShare).toBeCloseTo(0.3, 5)
  })

  test('an owner with no harness cost produces no breakdown rows', async () => {
    const h = makeHarness()
    const snapshot = await new Lens(h.deps).runWindow()
    expect(snapshot.harnessBreakdown).toEqual([])
  })
})

describe('sampleIntervalMs (what one sample is worth)', () => {
  test('divides the profile span by the sample count', () => {
    // Windows: 250us requested, ~540us achieved (probe 16).
    const cpu = { nodes: [], samples: Array<number>(1000).fill(1), startTime: 10_000, endTime: 550_000 }
    expect(sampleIntervalMs(cpu, 5000, 250)).toBeCloseTo(0.54, 5)
  })

  test('falls back to the window length when the profile has no timing', () => {
    expect(sampleIntervalMs({ nodes: [], samples: Array<number>(100).fill(1) }, 5000, 250)).toBe(50)
  })

  test('returns the configured interval when there is nothing to charge', () => {
    expect(sampleIntervalMs(null, 5000, 250)).toBe(0.25)
    expect(sampleIntervalMs({ nodes: [], samples: [] }, 5000, 250)).toBe(0.25)
  })

  test('the lens charges rows at the achieved interval, not the configured one', async () => {
    const h = makeHarness()
    // 260 samples over 140.4ms: 0.54ms each, while 0.25ms is configured.
    h.sampler.stopCpu = vi.fn(async () => ({ nodes: NODES, samples: SAMPLES, startTime: 0, endTime: 140_400 }))
    const snapshot = await new Lens(h.deps).runWindow()
    expect(DEFAULT_LENS_OPTIONS.cpuIntervalUs).toBe(250)
    expect(snapshot.global.sampleIntervalMs).toBeCloseTo(0.54, 5)
    expect(snapshot.plugins.find(row => row.moduleName === 'pluginA')?.cpuSelfMs).toBeCloseTo(200 * 0.54, 5)
    expect(snapshot.plugins.find(row => row.moduleName === 'pluginB')?.cpuSelfMs).toBeCloseTo(60 * 0.54, 5)
  })
})

describe('sampling controls (three blocks, one profile)', () => {
  test('a control change reaches the panel before the next window lands', async () => {
    const h = makeHarness()
    const lens = new Lens(h.deps)
    await lens.runWindow()
    lens.setSampling({ intensity: 'high', memory: true })
    const snapshot = lens.snapshot()
    // The panel polls /snapshot on its own cadence and reads the mode from
    // there; a mode only refreshed per window would leave the segment showing
    // the old tier for up to two minutes in the background profile.
    expect(snapshot.mode).toBe('continuous')
    expect(snapshot.sampling).toEqual({ intensity: 'high', background: false, memory: true })
    // The window already collected is untouched: controls change the next one.
    expect(snapshot.global.sampleWindowMs).toBe(DEFAULT_LENS_OPTIONS.windowMs)
  })

  test('stopping only stops when background sampling is off', async () => {
    const h = makeHarness()
    const lens = new Lens(h.deps)
    lens.setSampling({ intensity: 'paused' })
    expect(lens.mode).toBe('paused')
    lens.setSampling({ background: true })
    expect(lens.mode).toBe('background')
    await lens.runWindow()
    expect(h.sampler.startCpu).toHaveBeenCalledWith(DEFAULT_LENS_OPTIONS.backgroundCpuIntervalUs)
    lens.setSampling({ background: false })
    expect(lens.mode).toBe('paused')
  })

  test('memory sampling turns heap sampling on without changing the mode', async () => {
    const h = makeHarness()
    const lens = new Lens(h.deps)
    expect(lens.mode).toBe('duty')
    lens.setSampling({ memory: true })
    expect(lens.mode).toBe('duty')
    await lens.runWindow()
    expect(h.sampler.startHeap).toHaveBeenCalledTimes(1)
  })

  test('the high tier drops back to low when its budget runs out', async () => {
    const h = makeHarness()
    // A clock whose sleeps cost a macrotask: the harness clock resolves in a
    // microtask, which turns a loop test into an unbounded allocation run.
    let nowValue = 0
    const clock = { sleep: async (_ms: number) => { await new Promise<void>(resolve => { setTimeout(resolve, 1) }) }, now: () => nowValue }
    const lens = new Lens({ ...h.deps, clock }, { ...DEFAULT_LENS_OPTIONS, continuousMaxMs: 1000 })
    lens.setSampling({ intensity: 'high' })
    expect(lens.mode).toBe('continuous')
    // Past the budget: the first loop check must demote the tier, so the
    // segment cannot stay lit on "high" while the loop samples at the low rate.
    nowValue = 5000
    lens.start()
    await new Promise<void>(resolve => { setTimeout(resolve, 20) })
    lens.stop()
    expect(lens.sampling.intensity).toBe('low')
    expect(lens.mode).toBe('duty')
    expect(lens.snapshot().mode).toBe('duty')
  })

  test('re-entering the high tier restarts its budget', async () => {
    const h = makeHarness()
    let nowValue = 0
    const clock = { sleep: async (_ms: number) => { await new Promise<void>(resolve => { setTimeout(resolve, 1) }) }, now: () => nowValue }
    const lens = new Lens({ ...h.deps, clock }, { ...DEFAULT_LENS_OPTIONS, continuousMaxMs: 1000 })
    lens.setSampling({ intensity: 'high' })
    nowValue = 5000
    lens.setSampling({ intensity: 'low' })
    // A stale deadline would expire the new high tier on its first check.
    lens.setSampling({ intensity: 'high' })
    nowValue = 5500
    lens.start()
    await new Promise<void>(resolve => { setTimeout(resolve, 20) })
    lens.stop()
    expect(lens.sampling.intensity).toBe('high')
  })

  test('one block changes without disturbing the others', () => {
    const h = makeHarness()
    const lens = new Lens(h.deps)
    lens.setSampling({ intensity: 'high', background: true, memory: true })
    lens.setSampling({ memory: false })
    expect(lens.sampling).toEqual({ intensity: 'high', background: true, memory: false })
  })
})

describe('0.2.0 readings', () => {
  /** The default harness, with the process-CPU figure the residual is computed from. */
  function withProcessCpu(processCpuMs: number) {
    const h = makeHarness()
    const metrics = h.deps.metrics as unknown as { read: (windowMs: number, sampleCount: number) => Record<string, unknown> }
    const original = metrics.read
    metrics.read = (windowMs, sampleCount) => ({ ...original(windowMs, sampleCount), processCpuMs })
    return h
  }

  test('unexplained CPU is what the profile could not account for', async () => {
    // 260 samples over a 5000ms window: the profile accounts for 5000ms of CPU.
    const h = withProcessCpu(9_000)
    const snapshot = await new Lens(h.deps).runWindow()
    expect(snapshot.global.unexplainedCpuMs).toBeCloseTo(4_000, 6)
  })

  test('unexplained CPU never goes negative when the clocks disagree', async () => {
    // The platform CPU clock quantizes (~15.6ms on Windows), so a quiet window
    // can report slightly less process CPU than the samples account for.
    const h = withProcessCpu(4_900)
    const snapshot = await new Lens(h.deps).runWindow()
    expect(snapshot.global.unexplainedCpuMs).toBe(0)
  })

  test('listener counts land on the plugin row, and harness sub-packages fold', async () => {
    const h = makeHarness()
    const lens = new Lens({
      ...h.deps,
      listenerCounts: () => new Map([
        ['plugin:pluginA', 12],
        ['harness:@deepseek-ai/dsh-core', 5],
        ['harness:@deepseek-ai/dsh-web', 7],
      ]),
    })
    const snapshot = await lens.runWindow()
    expect(snapshot.plugins.find(row => row.moduleName === 'pluginA')?.listeners).toBe(12)
    expect(snapshot.plugins.find(row => row.moduleName === 'harness')?.listeners).toBe(12)
  })

  test('an unreadable listener registry leaves the column absent, not zero', async () => {
    const h = makeHarness()
    const lens = new Lens({ ...h.deps, listenerCounts: () => null })
    const snapshot = await lens.runWindow()
    expect(snapshot.plugins.find(row => row.moduleName === 'pluginA')?.listeners).toBeUndefined()
  })

  test('an owner with listeners but no sampled CPU still gets a row', async () => {
    const h = makeHarness()
    const lens = new Lens({ ...h.deps, listenerCounts: () => new Map([['plugin:quiet-plugin', 3]]) })
    const snapshot = await lens.runWindow()
    const row = snapshot.plugins.find(candidate => candidate.moduleName === 'plugin:quiet-plugin')
    expect(row?.listeners).toBe(3)
    expect(row?.cpuSelfMs).toBe(0)
  })

  test('on-disk bytes land on the plugin row and fold for harness packages', async () => {
    const h = makeHarness()
    const lens = new Lens({
      ...h.deps,
      diskFootprint: () => new Map([
        ['plugin:pluginB', 2048],
        ['harness:@deepseek-ai/dsh-core', 1024],
      ]),
    })
    const snapshot = await lens.runWindow()
    expect(snapshot.plugins.find(row => row.moduleName === 'pluginB')?.diskFootprintBytes).toBe(2048)
    expect(snapshot.plugins.find(row => row.moduleName === 'harness')?.diskFootprintBytes).toBe(1024)
  })

  test('the process tree and footprint readings are gauges on the snapshot, not the window', async () => {
    const h = makeHarness()
    const tree = { at: 5, count: 4, rssBytes: 4096, cpuCoreShare: 2.5, intervalMs: 30_000, coverage: 1, top: [] }
    const disk = { scannedAt: 7, scannedFiles: 9, scannedBytes: 100, ownedBytes: 60, truncated: false }
    const lens = new Lens({ ...h.deps, processTree: () => tree, diskFootprintReading: () => disk })
    // Before any window: a panel opened at boot must still see them.
    expect(lens.snapshot().processTree).toEqual(tree)
    expect(lens.snapshot().diskFootprint).toEqual(disk)
    const snapshot = await lens.runWindow()
    expect(snapshot.processTree).toEqual(tree)
    expect(snapshot.diskFootprint).toEqual(disk)
  })

  test('a host with no tree reading reports nothing rather than an empty tree', async () => {
    const h = makeHarness()
    const lens = new Lens({ ...h.deps, processTree: () => null })
    expect(lens.snapshot().processTree).toBeUndefined()
  })
})
