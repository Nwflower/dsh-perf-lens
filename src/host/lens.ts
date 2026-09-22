// Orchestrator: one duty-cycled sampling window at a time, each window turned
// into a snapshot that the panel polls and the history log appends.
//
// The duty cycle exists because sampling is not free (docs/evidence.md evidence
// 8: both samplers at once cost +15%..+26% on compute-bound load). Continuous
// mode trades that back only while the user is actually watching the board, and
// is bounded by continuousMaxMs so it cannot be left on by accident.

import type { GlobalMetricRow, PerfDiagnostics, PerfSnapshot, PluginMetricRow, SampleMode } from '../shared/contract'
import { DEFAULTS } from '../shared/defaults'
import { attributeFrameList, ownerKey, tallySamples, type OwnerIndex } from './attribute'
import type { HistoryStore } from './history'
import type { IoTracker } from './io-tracker'
import type { GlobalMetrics } from './metrics'
import type { HeapNode, Sampler } from './sampler'

/** The plugin facts a metric row carries, independent of any measurement. */
export interface PluginFacts {
  readonly moduleName: string
  readonly entryId: string
  readonly fiberPhase: string
}

export interface LensOptions {
  readonly cpuIntervalUs: number
  readonly windowMs: number
  readonly idleMs: number
  readonly continuousWindowMs: number
  readonly continuousMaxMs: number
  /** Deep mode enables heap sampling on top of CPU sampling. */
  readonly deep: boolean
  readonly heapIntervalBytes: number
  readonly persistHistory: boolean
}

/** Time source, injectable so the duty cycle is testable without waiting. */
export interface LensClock {
  sleep(ms: number): Promise<void>
  now(): number
}

export const SYSTEM_CLOCK: LensClock = {
  sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }),
  now: () => Date.now(),
}

export interface LensDeps {
  readonly sampler: Sampler
  readonly io: IoTracker
  readonly metrics: GlobalMetrics
  readonly history: HistoryStore
  /** Installed plugins, from ctx.loader.entries(). */
  readonly plugins: () => readonly PluginFacts[]
  /** Current path-prefix owner index. */
  readonly ownerIndex: () => OwnerIndex
  readonly clock?: LensClock
}

export const DEFAULT_LENS_OPTIONS: LensOptions = {
  cpuIntervalUs: DEFAULTS.cpuIntervalUs,
  windowMs: DEFAULTS.windowMs,
  idleMs: DEFAULTS.idleMs,
  continuousWindowMs: DEFAULTS.continuousWindowMs,
  continuousMaxMs: DEFAULTS.continuousMaxMs,
  deep: false,
  heapIntervalBytes: 32 * 1024,
  persistHistory: true,
}

function zeroGlobal(): GlobalMetricRow {
  return {
    rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0,
    eventLoopLagP99Ms: 0, gcPauseMs: 0, fsOpsTotal: 0, sampleWindowMs: 0, sampleCount: 0, idleSamples: 0,
  }
}

/** Aggregate heap-sampling selfSize by owner, walking the tree once. */
export function tallyHeap(root: HeapNode, index: OwnerIndex): Map<string, number> {
  const counts = new Map<string, number>()
  const walk = (node: HeapNode, parents: (string | undefined)[]): void => {
    const urls = [node.callFrame?.url, ...parents]
    if (node.selfSize > 0) {
      const key = ownerKey(attributeFrameList(urls, index))
      counts.set(key, (counts.get(key) ?? 0) + node.selfSize)
    }
    const childParents = [node.callFrame?.url, ...parents]
    for (const child of node.children ?? []) walk(child, childParents)
  }
  walk(root, [])
  return counts
}

/**
 * Whether a continuous-mode budget has run out. Continuous mode must never be
 * left on by accident (design risk table), so the loop checks this every window
 * and falls back to the duty cycle.
 */
export function continuousExpired(mode: SampleMode, now: number, continuousSince: number, maxMs: number): boolean {
  return mode === 'continuous' && now - continuousSince > maxMs
}

/**
 * Duty-cycle sleep after a window. A mostly-idle window is evidence that the
 * next one is likely idle too, and idle windows cost CPU without adding
 * attribution, so back off geometrically up to a cap. Continuous mode is never
 * backed off: the user is watching.
 */
export function nextIdleWait(mode: SampleMode, idleMs: number, idleShare: number): number {
  if (mode === 'continuous') return 0
  if (idleShare < DEFAULTS.idleBackoffThreshold) return idleMs
  return Math.min(idleMs * DEFAULTS.idleBackoffFactor, DEFAULTS.idleBackoffMaxMs)
}

/** Duty-cycled sampler orchestrator. */
export class Lens {
  readonly #deps: LensDeps
  readonly #options: LensOptions
  #mode: SampleMode = 'duty'
  #deep: boolean
  #running = false
  #generation = 0
  #continuousSince = 0
  #last: PerfSnapshot
  #lastError: string | null = null
  #lastOwnerKeys: string[] = []
  #lastIdleShare = 0
  /** Resolver of the in-flight interruptible sleep, if any. */
  #wake: (() => void) | null = null

  constructor(deps: LensDeps, options: LensOptions = DEFAULT_LENS_OPTIONS) {
    this.#deps = deps
    this.#options = options
    this.#deep = options.deep
    this.#last = {
      windowStartedAt: 0, mode: 'duty', global: zeroGlobal(), plugins: [], unattributedShare: 0, selfShare: 0,
    }
  }

  get mode(): SampleMode { return this.#mode }
  get running(): boolean { return this.#running }
  get options(): LensOptions { return this.#options }

  /** Start the duty-cycle loop. */
  start(): void {
    if (this.#running) return
    this.#running = true
    const generation = ++this.#generation
    void this.#loop(generation)
  }

  /** Stop the loop. An in-flight window finishes, then nothing new starts. */
  stop(): void {
    this.#running = false
    this.#generation += 1
  }

  /** Switch mode immediately; entering continuous mode starts its budget. */
  setMode(mode: SampleMode): void {
    this.#mode = mode
    if (mode === 'continuous') this.#continuousSince = this.#clock().now()
    // Controls must take effect now, not after the current idle sleep: without
    // this, switching to continuous would appear dead for up to idleMs.
    this.#wake?.()
  }

  /** Update deep mode for the next window. */
  setDeep(deep: boolean): void {
    this.#deep = deep
    this.#wake?.()
  }

  snapshot(): PerfSnapshot { return this.#last }

  /**
   * Attribution and health facts for troubleshooting. Exists because the duty
   * loop must swallow window errors to stay alive, which would otherwise make a
   * broken profiler look exactly like an idle one.
   */
  diagnostics(): PerfDiagnostics {
    // Diagnostics must never throw: a broken owner index is exactly the case
    // they exist to explain.
    let ownerRules: PerfDiagnostics['ownerRules'] = []
    try {
      ownerRules = this.#deps.ownerIndex().rules.map(rule => ({ kind: rule.kind, name: rule.name, prefix: rule.prefix }))
    } catch {
      ownerRules = []
    }
    return {
      lastError: this.#lastError,
      windowStartedAt: this.#last.windowStartedAt,
      sampleCount: this.#last.global.sampleCount,
      ownerKeys: [...this.#lastOwnerKeys],
      ownerRules,
    }
  }

  /** Run exactly one window and publish the snapshot. */
  async runWindow(): Promise<PerfSnapshot> {
    const clock = this.#clock()
    const deep = this.#deep
    const windowMs = this.#mode === 'continuous' ? this.#options.continuousWindowMs : this.#options.windowMs
    const startedAt = clock.now()
    try {
      // Inside the try: a throw while resolving the owner index must still run
      // the finally (io cleanup) instead of escaping before it.
      this.#deps.metrics.start()
      this.#deps.io.setOwnerIndex(this.#deps.ownerIndex())
      this.#deps.io.enable()
      await this.#deps.sampler.startCpu()
      if (deep) await this.#deps.sampler.startHeap()
      await clock.sleep(windowMs)
      const cpu = await this.#deps.sampler.stopCpu()
      const heap = deep ? await this.#deps.sampler.stopHeap() : null
      const snapshot = this.#build(startedAt, windowMs, cpu, heap)
      this.#last = snapshot
      this.#deps.history.record(snapshot, this.#options.persistHistory)
      return snapshot
    } finally {
      this.#deps.io.disable()
    }
  }

  /** Stop sampling and release the inspector session. */
  async dispose(): Promise<void> {
    this.stop()
    this.#deps.io.disable()
    this.#deps.metrics.stop()
    await this.#deps.sampler.dispose()
  }

  #clock(): LensClock { return this.#deps.clock ?? SYSTEM_CLOCK }

  /**
   * Sleep that a control change can cut short. `wait <= 0` still goes through the
   * clock so the loop always yields a macrotask.
   */
  #sleepInterruptible(ms: number): Promise<void> {
    const clock = this.#clock()
    if (ms <= 0) return clock.sleep(0)
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        this.#wake = null
        resolve()
      }
      this.#wake = finish
      void clock.sleep(ms).then(finish)
    })
  }

  #build(
    startedAt: number,
    windowMs: number,
    cpu: { nodes: readonly import('./attribute').ProfileNode[]; samples: readonly number[] } | null,
    heap: { head: HeapNode } | null,
  ): PerfSnapshot {
    const index = this.#deps.ownerIndex()
    const samples = cpu?.samples ?? []
    const cpuCounts = cpu === null ? new Map<string, number>() : tallySamples(samples, cpu.nodes, index)
    const heapCounts = heap === null ? new Map<string, number>() : tallyHeap(heap.head, index)
    const io = this.#deps.io.take()
    const sampleCount = samples.length
    const idleSamples = cpuCounts.get('idle') ?? 0
    // Shares are over active samples: idle wall time is not cost, and including
    // it made every plugin look like ~0% on an idle host.
    const activeSamples = Math.max(0, sampleCount - idleSamples)
    const global = { ...this.#deps.metrics.read(windowMs, sampleCount), idleSamples }
    this.#lastIdleShare = sampleCount === 0 ? 0 : idleSamples / sampleCount
    const rows: PluginMetricRow[] = []
    const seen = new Set<string>()
    for (const fact of this.#deps.plugins()) {
      const key = `plugin:${fact.moduleName}`
      seen.add(key)
      rows.push(this.#row(key, fact.moduleName, fact.entryId, fact.fiberPhase, cpuCounts, heapCounts, io, activeSamples))
    }
    for (const key of cpuCounts.keys()) {
      if (key === 'idle' || key.startsWith('plugin:') || seen.has(key)) continue
      seen.add(key)
      rows.push(this.#row(key, key, '', '', cpuCounts, heapCounts, io, activeSamples))
    }
    // Owners with file activity but no CPU samples still deserve a row.
    for (const key of io.perOwner.keys()) {
      if (key.startsWith('plugin:') || seen.has(key)) continue
      seen.add(key)
      rows.push(this.#row(key, key, '', '', cpuCounts, heapCounts, io, activeSamples))
    }
    this.#lastOwnerKeys = [...cpuCounts.keys()]
    const denominator = activeSamples === 0 ? 1 : activeSamples
    return {
      windowStartedAt: startedAt,
      mode: this.#mode,
      global,
      plugins: rows,
      unattributedShare: (cpuCounts.get('unattributed') ?? 0) / denominator,
      selfShare: (cpuCounts.get('self') ?? 0) / denominator,
    }
  }

  #row(
    key: string,
    moduleName: string,
    entryId: string,
    fiberPhase: string,
    cpuCounts: ReadonlyMap<string, number>,
    heapCounts: ReadonlyMap<string, number>,
    io: { perOwner: ReadonlyMap<string, { read: number; write: number }> },
    activeSamples: number,
  ): PluginMetricRow {
    const cpuSamples = cpuCounts.get(key) ?? 0
    const ioCounts = io.perOwner.get(key)
    const sampleCount = activeSamples
    return {
      moduleName,
      entryId,
      fiberPhase,
      cpuShare: sampleCount === 0 ? 0 : cpuSamples / sampleCount,
      cpuSelfMs: cpuSamples * (this.#options.cpuIntervalUs / 1000),
      liveHeapBytes: heapCounts.get(key) ?? 0,
      allocBytesPerSec: 0,
      fsReadOps: ioCounts?.read ?? 0,
      fsWriteOps: ioCounts?.write ?? 0,
      fsReadBytes: 0,
      fsWriteBytes: 0,
      coverage: 0,
      timers: 0,
      listeners: 0,
      handles: 0,
      diskFootprintBytes: 0,
    }
  }

  async #loop(generation: number): Promise<void> {
    while (this.#running && generation === this.#generation) {
      if (this.#mode === 'paused') {
        await this.#clock().sleep(500)
        continue
      }
      try {
        await this.runWindow()
        this.#lastError = null
      } catch (error) {
        // A failed window must never kill the loop; the next window retries.
        // The reason is kept for /api-perf/diagnostics.
        this.#lastError = error instanceof Error ? error.message : String(error)
      }
      if (!this.#running || generation !== this.#generation) break
      if (continuousExpired(this.#mode, this.#clock().now(), this.#continuousSince, this.#options.continuousMaxMs)) {
        this.#mode = 'duty'
      }
      // Always await, even for 0: in continuous mode a window that throws
      // synchronously would otherwise loop entirely on microtasks and starve
      // the host event loop (observed as dsh hanging). A macrotask yield per
      // iteration is the safety valve.
      const nominal = nextIdleWait(this.#mode, this.#options.idleMs, this.#lastIdleShare)
      // After a failed window, never retry faster than 30s: a broken profiler or
      // owner index must not turn continuous mode into a hammering loop.
      const wait = this.#lastError === null ? nominal : Math.max(nominal, 30_000)
      await this.#sleepInterruptible(wait)
    }
  }
}
