// Orchestrator: one duty-cycled sampling window at a time, each window turned
// into a snapshot that the panel polls and the history log appends.
//
// The duty cycle exists because sampling is not free (docs/evidence.md,
// evidence 8: both samplers at once cost +15% to +26% on a compute-bound load).
// The panel's three controls — intensity, background sampling, memory sampling —
// are resolved into the single profile the loop runs by shared/sampling.ts.
// The high tier gives that saving up only while someone is watching the panel,
// and continuousMaxMs ends it so it cannot be left on by accident.

import type { DiskFootprintReading, GlobalMetricRow, HarnessBreakdownRow, PerfDiagnostics, PerfSnapshot, PluginMetricRow, ProcessTreeReading, SampleMode, SamplingConfig } from '../shared/contract'
import { DEFAULTS, DEFAULT_SAMPLING } from '../shared/defaults'
import { effectiveMode } from '../shared/sampling'
import { attributeFrameList, ownerKey, tallySamples, type OwnerIndex } from './attribute'
import { correlateSamples, sampleTimesUs, type AsyncCorrelation, type AsyncWindowRecorder, type AsyncWindowSample } from './async-attribution'
import type { HistoryStore } from './history'
import type { IoTracker } from './io-tracker'
import { aggregateHotspots, type HotspotStore } from './hotspots'
import type { GlobalMetrics } from './metrics'
import type { CpuProfileResult, HeapNode, Sampler } from './sampler'

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
  /** Background profile: coarser interval, short window, long sleep. */
  readonly backgroundCpuIntervalUs: number
  readonly backgroundWindowMs: number
  readonly backgroundIdleMs: number
  /**
   * Sentinel activity probing during the duty idle backoff: a cheap coarse
   * window that cuts a long sleep short when the host starts working again.
   */
  readonly sentinelEnabled: boolean
  readonly sentinelCpuIntervalUs: number
  readonly sentinelWindowMs: number
  readonly sentinelIdleMs: number
  readonly sentinelActivityThreshold: number
  /** Initial memory sampling (heap on top of CPU); the panel can change it. */
  readonly deep: boolean
  readonly heapIntervalBytes: number
  readonly persistHistory: boolean
  /**
   * Deep-mode only: re-attribute CPU samples that ran inside a plugin-owned
   * async callback back to that plugin (mechanism C). Expensive, so it never
   * runs outside deep mode.
   */
  readonly asyncAttribution: boolean
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
  /**
   * In-memory hot-function table. Optional so attribution-only tests can skip
   * it; never persisted (docs/design.md §7).
   */
  readonly hotspots?: HotspotStore
  /**
   * Deep-mode async-context recorder for mechanism-C re-attribution. Optional:
   * without it, attribution is stack-only exactly as before.
   */
  readonly asyncAttribution?: AsyncWindowRecorder
  /** Installed plugins, from ctx.loader.entries(). */
  readonly plugins: () => readonly PluginFacts[]
  /** Current path-prefix owner index. */
  readonly ownerIndex: () => OwnerIndex
  /**
   * Registered event listeners per owner key (roadmap item 3). Returns null when
   * the cordis event registry could not be read, in which case the column is
   * left absent rather than reported as zero.
   */
  readonly listenerCounts?: () => ReadonlyMap<string, number> | null
  /**
   * Per-owner on-disk bytes from the latest footprint scan (roadmap item 4).
   * Optional, and empty until the first scan completes.
   */
  readonly diskFootprint?: () => ReadonlyMap<string, number>
  /** Metadata of the latest footprint scan, published on the snapshot. */
  readonly diskFootprintReading?: () => DiskFootprintReading | null
  /**
   * The host's descendant process tree (roadmap item 1a). Read at snapshot time
   * rather than per window: the tree is polled far more slowly than the host is
   * sampled, so a window-scoped copy would only be staler.
   */
  readonly processTree?: () => ProcessTreeReading | null
  readonly clock?: LensClock
}

export const DEFAULT_LENS_OPTIONS: LensOptions = {
  cpuIntervalUs: DEFAULTS.cpuIntervalUs,
  windowMs: DEFAULTS.windowMs,
  idleMs: DEFAULTS.idleMs,
  continuousWindowMs: DEFAULTS.continuousWindowMs,
  continuousMaxMs: DEFAULTS.continuousMaxMs,
  backgroundCpuIntervalUs: DEFAULTS.backgroundCpuIntervalUs,
  backgroundWindowMs: DEFAULTS.backgroundWindowMs,
  backgroundIdleMs: DEFAULTS.backgroundIdleMs,
  sentinelEnabled: DEFAULTS.sentinelEnabled,
  sentinelCpuIntervalUs: DEFAULTS.sentinelCpuIntervalUs,
  sentinelWindowMs: DEFAULTS.sentinelWindowMs,
  sentinelIdleMs: DEFAULTS.sentinelIdleMs,
  sentinelActivityThreshold: DEFAULTS.sentinelActivityThreshold,
  deep: false,
  heapIntervalBytes: 32 * 1024,
  persistHistory: true,
  asyncAttribution: DEFAULTS.asyncAttribution,
}

function zeroGlobal(): GlobalMetricRow {
  return {
    rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0,
    eventLoopLagP99Ms: 0, gcPauseMs: 0, fsOpsTotal: 0, sampleWindowMs: 0, sampleCount: 0, idleSamples: 0,
    sampleIntervalMs: 0,
  }
}

/**
 * Milliseconds of CPU one sample stands for in this window.
 *
 * The configured interval is a request, not a promise: on Windows the profiler
 * tick floors at ~0.54ms whatever is asked for (probe 16), so charging each
 * sample at the configured 0.25ms understated every absolute cost about 2.2x
 * (evidence 13). The profile's own span divided by its sample count is the
 * interval actually achieved. Without V8 timing the window length stands in
 * for the span; with no samples there is nothing to charge, and the configured
 * interval is returned only so the figure is never 0 or NaN.
 */
export function sampleIntervalMs(cpu: CpuProfileResult | null, windowMs: number, configuredUs: number): number {
  const count = cpu?.samples.length ?? 0
  if (cpu === null || count === 0) return configuredUs / 1000
  const spanUs = cpu.startTime !== undefined && cpu.endTime !== undefined ? cpu.endTime - cpu.startTime : 0
  const spanMs = spanUs > 0 ? spanUs / 1000 : windowMs
  return spanMs / count
}

/** Sum heap-sampling selfSize by owner, walking the tree once. */
export function tallyHeap(root: HeapNode, index: OwnerIndex): Map<string, number> {
  const counts = new Map<string, number>()
  // `stack` is this node's URL followed by its ancestors', innermost first:
  // the order attributeFrameList walks when it looks for the nearest owner.
  const walk = (node: HeapNode, ancestors: readonly (string | undefined)[]): void => {
    const stack = [node.callFrame?.url, ...ancestors]
    if (node.selfSize > 0) {
      const key = ownerKey(attributeFrameList(stack, index))
      counts.set(key, (counts.get(key) ?? 0) + node.selfSize)
    }
    for (const child of node.children ?? []) walk(child, stack)
  }
  walk(root, [])
  return counts
}

/**
 * Fold every `harness:<subpackage>` owner into one `harness` row.
 *
 * The design always said harness folds to a single line; without this the
 * board listed each internal dsh-* package separately and a 200-plugin host
 * buried the actual consumers in harness internals.
 */
export function collapseOwnerCounts(counts: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [key, value] of counts) {
    const target = key.startsWith('harness:') ? 'harness' : key
    out.set(target, (out.get(target) ?? 0) + value)
  }
  return out
}

/** Same fold for the async_hooks file-operation counts. */
export function collapseIoCounts(
  counts: ReadonlyMap<string, { readonly read: number; readonly write: number }>,
): Map<string, { read: number; write: number }> {
  const out = new Map<string, { read: number; write: number }>()
  for (const [key, value] of counts) {
    const target = key.startsWith('harness:') ? 'harness' : key
    const existing = out.get(target) ?? { read: 0, write: 0 }
    out.set(target, { read: existing.read + value.read, write: existing.write + value.write })
  }
  return out
}

/** Fold `harness:<subpackage>` keys into one `harness` key, merging the values. */
export function collapseByHarness<T>(
  counts: ReadonlyMap<string, T>,
  merge: (left: T, right: T) => T,
): Map<string, T> {
  const out = new Map<string, T>()
  for (const [key, value] of counts) {
    const target = key.startsWith('harness:') ? 'harness' : key
    const existing = out.get(target)
    out.set(target, existing === undefined ? value : merge(existing, value))
  }
  return out
}

const EMPTY_LISTENERS: ReadonlyMap<string, number> = new Map()
const EMPTY_BYTES: ReadonlyMap<string, number> = new Map()

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
export function nextIdleWait(mode: SampleMode, idleMs: number, idleShare: number, backgroundIdleMs = idleMs): number {
  if (mode === 'continuous') return 0
  if (mode === 'background') return backgroundIdleMs
  if (idleShare < DEFAULTS.idleBackoffThreshold) return idleMs
  return Math.min(idleMs * DEFAULTS.idleBackoffFactor, DEFAULTS.idleBackoffMaxMs)
}

/**
 * Whether the loop should probe for activity during this idle wait.
 *
 * Only the duty profile backs off far enough to lose a spike (up to
 * idleBackoffMaxMs). Probing in any other mode would be pointless (continuous)
 * or would change a cadence the user explicitly chose (background), and a
 * window that just failed must not add more profiler traffic.
 */
export function probesForActivity(
  mode: SampleMode,
  enabled: boolean,
  lastIdleShare: number,
  lastError: string | null,
): boolean {
  return enabled
    && mode === 'duty'
    && lastError === null
    && lastIdleShare >= DEFAULTS.idleBackoffThreshold
}

/** Runs the sampling loop and publishes one snapshot per window. */
export class Lens {
  readonly #deps: LensDeps
  readonly #options: LensOptions
  /**
   * The three control blocks in force. `mode` is derived from them rather than
   * stored, so the panel can never see a mode that disagrees with the controls
   * it is rendering.
   */
  #sampling: SamplingConfig
  #running = false
  #generation = 0
  #continuousSince = 0
  #last: PerfSnapshot
  #lastError: string | null = null
  #lastOwnerKeys: string[] = []
  #lastIdleShare = 0
  /** Samples correlated to a plugin-owned async window in the last deep window. */
  #lastAsyncWindowed = 0
  /** Of those, samples moved from harness/runtime to a plugin. */
  #lastAsyncReattributed = 0
  /** Resolver of the in-flight interruptible sleep, if any. */
  #wake: (() => void) | null = null

  constructor(deps: LensDeps, options: LensOptions = DEFAULT_LENS_OPTIONS) {
    this.#deps = deps
    this.#options = options
    this.#sampling = { ...DEFAULT_SAMPLING, memory: options.deep }
    this.#last = {
      windowStartedAt: 0, mode: 'duty', global: zeroGlobal(), plugins: [], unattributedShare: 0, selfShare: 0,
    }
  }

  /** The mode the loop runs: the three control blocks resolved to one profile. */
  get mode(): SampleMode { return effectiveMode(this.#sampling) }
  /** The control blocks in force, for the panel's controls. */
  get sampling(): SamplingConfig { return this.#sampling }
  get running(): boolean { return this.#running }
  get options(): LensOptions { return this.#options }

  /** Start the sampling loop. */
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

  /**
   * Apply a control change. Only the fields given change, so the panel can send
   * one block at a time, and entering the high tier restarts its time budget.
   */
  setSampling(next: Partial<SamplingConfig>): void {
    const merged: SamplingConfig = { ...this.#sampling, ...next }
    // Entering high (re)starts the budget; leaving it clears the deadline so a
    // later entry cannot inherit a stale one.
    if (merged.intensity === 'high' && this.#sampling.intensity !== 'high') {
      this.#continuousSince = this.#clock().now()
    }
    this.#sampling = merged
    // Controls must take effect now, not after the current idle sleep: without
    // this, switching to high would appear dead for up to idleMs.
    this.#wake?.()
  }

  /**
   * The last window, with the live control state overlaid. A control change has
   * to be visible to the panel at once, but the window itself is only rebuilt
   * when one closes — up to two minutes apart in background mode.
   */
  snapshot(): PerfSnapshot {
    const base = { ...this.#last, mode: this.mode, sampling: { ...this.#sampling } }
    // The tree and footprint readings are gauges on their own slow timers, so
    // they are attached here rather than baked into the window: a control change
    // or a fresh poll must be visible without waiting for the next window.
    const processTree = this.#deps.processTree?.()
    const diskFootprint = this.#deps.diskFootprintReading?.()
    return {
      ...base,
      ...(processTree === null || processTree === undefined ? {} : { processTree }),
      ...(diskFootprint === null || diskFootprint === undefined ? {} : { diskFootprint }),
    }
  }

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
    let listenerRegistryReadable = false
    try {
      // `?.()` yields undefined when the collector is absent, which is "not
      // measured" exactly like an explicit null.
      listenerRegistryReadable = (this.#deps.listenerCounts?.() ?? null) !== null
    } catch {
      listenerRegistryReadable = false
    }
    const tree = this.#deps.processTree?.() ?? null
    const disk = this.#deps.diskFootprintReading?.() ?? null
    return {
      lastError: this.#lastError,
      windowStartedAt: this.#last.windowStartedAt,
      sampleCount: this.#last.global.sampleCount,
      ownerKeys: [...this.#lastOwnerKeys],
      ownerRules,
      asyncWindowedSamples: this.#lastAsyncWindowed,
      asyncReattributedSamples: this.#lastAsyncReattributed,
      // Health of the 0.2.0 collectors. Without these, "the host has no child
      // processes" and "the process table cannot be read here" look identical
      // from the outside, which is the failure mode diagnostics exist to remove.
      processTree: {
        available: tree !== null,
        at: tree?.at ?? 0,
        count: tree?.count ?? 0,
        coverage: tree?.coverage ?? 0,
      },
      diskFootprint: disk === null
        ? null
        : {
            scannedAt: disk.scannedAt,
            scannedFiles: disk.scannedFiles,
            ownedBytes: disk.ownedBytes,
            truncated: disk.truncated,
          },
      listenersMeasured: listenerRegistryReadable,
    }
  }

  /** Run exactly one window and publish the snapshot. */
  async runWindow(): Promise<PerfSnapshot> {
    const clock = this.#clock()
    const deep = this.#sampling.memory
    const windowMs = this.#windowMs()
    const startedAt = clock.now()
    // The async recorder is the most expensive instrumentation in the plugin,
    // so it exists only while a deep window is open.
    const asyncRecorder = deep && this.#options.asyncAttribution ? this.#deps.asyncAttribution : undefined
    try {
      // Inside the try: a throw while resolving the owner index must still run
      // the finally (io cleanup) instead of escaping before it.
      this.#deps.metrics.start()
      this.#deps.io.setOwnerIndex(this.#deps.ownerIndex())
      this.#deps.io.enable()
      if (asyncRecorder !== undefined) {
        asyncRecorder.setOwnerIndex(this.#deps.ownerIndex())
        asyncRecorder.enable()
      }
      await this.#deps.sampler.startCpu(this.#cpuIntervalUs())
      if (deep) await this.#deps.sampler.startHeap()
      await clock.sleep(windowMs)
      const cpu = await this.#deps.sampler.stopCpu()
      const heap = deep ? await this.#deps.sampler.stopHeap() : null
      const asyncSample = asyncRecorder?.take()
      const snapshot = this.#build(startedAt, windowMs, cpu, heap, asyncSample)
      this.#last = snapshot
      this.#deps.history.record(snapshot, this.#options.persistHistory)
      // Return the same shape the routes serve: the gauges that live on their
      // own timers are overlaid here too, so the two paths cannot disagree.
      return this.snapshot()
    } finally {
      this.#deps.io.disable()
      asyncRecorder?.disable()
    }
  }

  /**
   * One cheap activity probe: a short, coarse-interval CPU window.
   *
   * Returns the idle share (0..1), or 1 when no samples arrived. It deliberately
   * does NOT record a snapshot: a coarse window holds only a handful of samples,
   * so its per-plugin shares are noise (five samples reads as 100%) and would
   * pollute the scoreboard. Its only consumer is the duty loop's decision to
   * take a real window now instead of sleeping out the idle backoff.
   */
  async runSentinel(): Promise<number> {
    await this.#deps.sampler.startCpu(this.#options.sentinelCpuIntervalUs)
    await this.#clock().sleep(this.#options.sentinelWindowMs)
    const cpu = await this.#deps.sampler.stopCpu()
    if (cpu === null) return 1
    const samples = cpu.samples
    if (samples.length === 0) return 1
    const counts = tallySamples(samples, cpu.nodes, this.#deps.ownerIndex())
    return (counts.get('idle') ?? 0) / samples.length
  }

  /** Stop sampling and release the inspector session. */
  async dispose(): Promise<void> {
    this.stop()
    this.#deps.io.disable()
    this.#deps.metrics.stop()
    await this.#deps.sampler.dispose()
  }

  #clock(): LensClock { return this.#deps.clock ?? SYSTEM_CLOCK }

  /** Window length for the active profile. */
  #windowMs(): number {
    const mode = this.mode
    if (mode === 'continuous') return this.#options.continuousWindowMs
    if (mode === 'background') return this.#options.backgroundWindowMs
    return this.#options.windowMs
  }

  /** CPU sampling interval for the active profile. */
  #cpuIntervalUs(): number {
    return this.mode === 'background' ? this.#options.backgroundCpuIntervalUs : this.#options.cpuIntervalUs
  }

  /**
   * Sleep that a control change can cut short. `wait <= 0` still goes through the
   * clock so the loop always yields a macrotask. Returns why it ended so the
   * sentinel loop can tell an elapsed slice from a wake caused by a control.
   */
  #sleepInterruptible(ms: number): Promise<'slept' | 'woken'> {
    const clock = this.#clock()
    if (ms <= 0) return clock.sleep(0).then(() => 'slept' as const)
    return new Promise<'slept' | 'woken'>((resolve) => {
      let settled = false
      const finish = (result: 'slept' | 'woken'): void => {
        if (settled) return
        settled = true
        this.#wake = null
        resolve(result)
      }
      this.#wake = () => { finish('woken') }
      void clock.sleep(ms).then(() => { finish('slept') })
    })
  }

  /**
   * Idle wait with optional sentinel probing.
   *
   * A plain long sleep is what makes a spike invisible for up to two minutes.
   * When the last window was mostly idle, the wait is sliced and each slice is
   * followed by a cheap probe; a probe that finds activity ends the wait so the
   * loop takes a real window immediately. A control change still ends the wait
   * at once, exactly like the unprobed sleep.
   */
  async #sleepWithSentinel(ms: number): Promise<void> {
    if (!probesForActivity(this.mode, this.#options.sentinelEnabled, this.#lastIdleShare, this.#lastError)) {
      await this.#sleepInterruptible(ms)
      return
    }
    let remaining = ms
    while (remaining > 0) {
      const slice = Math.min(this.#options.sentinelIdleMs, remaining)
      const result = await this.#sleepInterruptible(slice)
      if (result === 'woken') return
      remaining -= slice
      if (remaining <= 0 || !this.#running) return
      let idleShare: number
      try {
        idleShare = await this.runSentinel()
      } catch (error) {
        // A broken probe is itself a reason to stop sleeping: return, and let
        // the loop take a window so the failure surfaces through the normal path.
        this.#lastError = error instanceof Error ? error.message : String(error)
        return
      }
      if (idleShare < this.#options.sentinelActivityThreshold) return
    }
  }

  #build(
    startedAt: number,
    windowMs: number,
    cpu: CpuProfileResult | null,
    heap: { head: HeapNode } | null,
    asyncSample?: AsyncWindowSample,
  ): PerfSnapshot {
    const index = this.#deps.ownerIndex()
    const samples = cpu?.samples ?? []
    // Mechanism-C correction: samples that ran inside a plugin-owned async
    // callback but whose JS stack only shows harness frames move back to the
    // plugin. Empty (and therefore a no-op) unless deep mode collected windows.
    const asyncCorrelation = this.#asyncCorrelation(cpu, asyncSample, index)
    this.#lastAsyncWindowed = asyncCorrelation.windowedSamples
    this.#lastAsyncReattributed = asyncCorrelation.override.size
    const rawCpuCounts = cpu === null
      ? new Map<string, number>()
      : tallySamples(samples, cpu.nodes, index, asyncCorrelation.override)
    const rawHeapCounts = heap === null ? new Map<string, number>() : tallyHeap(heap.head, index)
    // Rows use the folded view; diagnostics keep the raw keys so a specific
    // harness subpackage can still be found when attribution looks wrong.
    const cpuCounts = collapseOwnerCounts(rawCpuCounts)
    const heapCounts = collapseOwnerCounts(rawHeapCounts)
    const io = this.#deps.io.take()
    const ioPerOwner = collapseIoCounts(io.perOwner)
    const sampleCount = samples.length
    const intervalMs = sampleIntervalMs(cpu, windowMs, this.#cpuIntervalUs())
    const idleSamples = cpuCounts.get('idle') ?? 0
    // Shares are over active samples: idle wall time is not cost, and including
    // it made every plugin look like ~0% on an idle host.
    const activeSamples = Math.max(0, sampleCount - idleSamples)
    const metricsRow = this.#deps.metrics.read(windowMs, sampleCount)
    const global = {
      ...metricsRow,
      idleSamples,
      sampleIntervalMs: intervalMs,
      // The residual that keeps the shares honest: CPU the process actually
      // burned minus the CPU the profile accounts for. Non-zero means work ran
      // where the in-process sampler cannot see it (a worker thread, or native
      // code off the main thread) — evidence 14. It is not a plugin's cost and
      // must never be folded into one.
      unexplainedCpuMs: Math.max(0, (metricsRow.processCpuMs ?? 0) - sampleCount * intervalMs),
    }
    this.#lastIdleShare = sampleCount === 0 ? 0 : idleSamples / sampleCount
    const rows: PluginMetricRow[] = []
    const seen = new Set<string>()
    // Live gauges from their own collectors: registered listeners (item 3) and
    // on-disk bytes (item 4). Both are state, not window sums. A collector that
    // throws is treated as unmeasured: an optional extra must never cost the
    // window, which is the thing the whole plugin exists to produce.
    let listenerCounts: ReadonlyMap<string, number> | null = null
    try {
      listenerCounts = this.#deps.listenerCounts?.() ?? null
    } catch {
      listenerCounts = null
    }
    const listeners = listenerCounts === null
      ? null
      : collapseByHarness(listenerCounts, (left, right) => left + right)
    let footprintCounts: ReadonlyMap<string, number> = EMPTY_BYTES
    try {
      footprintCounts = this.#deps.diskFootprint?.() ?? EMPTY_BYTES
    } catch {
      footprintCounts = EMPTY_BYTES
    }
    const footprint = collapseByHarness(footprintCounts, (left, right) => left + right)
    const push = (key: string, moduleName: string, entryId: string, fiberPhase: string): void => {
      if (seen.has(key)) return
      seen.add(key)
      rows.push(this.#row(key, moduleName, entryId, fiberPhase, cpuCounts, heapCounts, ioPerOwner, listeners, footprint, activeSamples, intervalMs))
    }
    // Installed plugins first, so the board lists every one of them even when
    // idle; then every other owner that showed any activity at all.
    for (const fact of this.#deps.plugins()) push(`plugin:${fact.moduleName}`, fact.moduleName, fact.entryId, fact.fiberPhase)
    for (const key of cpuCounts.keys()) {
      if (key === 'idle') continue
      push(key, key, '', '')
    }
    // An owner with file activity, a live handle or bytes on disk but no CPU
    // samples still deserves a row.
    for (const key of ioPerOwner.keys()) push(key, key, '', '')
    for (const key of listeners?.keys() ?? EMPTY_LISTENERS.keys()) push(key, key, '', '')
    for (const key of footprint.keys()) push(key, key, '', '')
    this.#lastOwnerKeys = [...rawCpuCounts.keys()]
    // Hot functions are a deep-mode extra and frame-level data: they go to the
    // in-memory store only, never into the snapshot that history persists.
    if (this.#sampling.memory && cpu !== null) {
      this.#deps.hotspots?.replace(
        aggregateHotspots(cpu.samples, cpu.nodes, index, intervalMs, undefined, asyncCorrelation.override),
      )
    } else {
      this.#deps.hotspots?.clear()
    }
    const denominator = activeSamples === 0 ? 1 : activeSamples
    return {
      windowStartedAt: startedAt,
      mode: this.mode,
      sampling: { ...this.#sampling },
      global,
      plugins: rows,
      unattributedShare: (cpuCounts.get('unattributed') ?? 0) / denominator,
      selfShare: (cpuCounts.get('self') ?? 0) / denominator,
      harnessBreakdown: this.#harnessBreakdown(rawCpuCounts, rawHeapCounts, ioPerOwner, activeSamples, intervalMs),
    }
  }

  /**
   * Correlate this window's samples with plugin-owned async execution windows.
   *
   * Returns an empty correlation (stack-only attribution) when the recorder did
   * not run, when no window was collected, or when the profile lacks the V8
   * timing fields — a degraded path must never throw or guess.
   */
  #asyncCorrelation(
    cpu: CpuProfileResult | null,
    asyncSample: AsyncWindowSample | undefined,
    index: OwnerIndex,
  ): AsyncCorrelation {
    if (cpu === null || asyncSample === undefined || asyncSample.windows.length === 0) {
      return { override: new Map(), windowedSamples: 0 }
    }
    const { timeDeltas, startTime, endTime, startedAtUs, endedAtUs } = cpu
    if (timeDeltas === undefined || startTime === undefined || endTime === undefined
      || startedAtUs === undefined || endedAtUs === undefined) {
      return { override: new Map(), windowedSamples: 0 }
    }
    const times = sampleTimesUs(startedAtUs, endedAtUs, startTime, endTime, timeDeltas)
    return correlateSamples(cpu.samples, times, asyncSample.windows, asyncSample.ownerOf, cpu.nodes, index)
  }

  /**
   * The harness ranking the fold would otherwise delete.
   *
   * Built from the RAW owner counts (the folded maps have already merged every
   * `harness:<pkg>` into one key), sorted by absolute CPU so the line the user
   * should act on is first, and capped so a 200-package install cannot grow the
   * snapshot without bound.
   */
  #harnessBreakdown(
    cpuCounts: ReadonlyMap<string, number>,
    heapCounts: ReadonlyMap<string, number>,
    ioPerOwner: ReadonlyMap<string, { readonly read: number; readonly write: number }>,
    activeSamples: number,
    intervalMs: number,
  ): HarnessBreakdownRow[] {
    const keys = new Set<string>()
    for (const key of cpuCounts.keys()) if (key.startsWith('harness:')) keys.add(key)
    for (const key of heapCounts.keys()) if (key.startsWith('harness:')) keys.add(key)
    for (const key of ioPerOwner.keys()) if (key.startsWith('harness:')) keys.add(key)
    const rows: HarnessBreakdownRow[] = []
    for (const key of keys) {
      const cpuSamples = cpuCounts.get(key) ?? 0
      const io = ioPerOwner.get(key)
      rows.push({
        moduleName: key,
        cpuShare: activeSamples === 0 ? 0 : cpuSamples / activeSamples,
        cpuSelfMs: cpuSamples * intervalMs,
        liveHeapBytes: heapCounts.get(key) ?? 0,
        fsReadOps: io?.read ?? 0,
        fsWriteOps: io?.write ?? 0,
      })
    }
    rows.sort((left, right) => right.cpuSelfMs - left.cpuSelfMs || right.liveHeapBytes - left.liveHeapBytes)
    return rows.slice(0, DEFAULTS.harnessBreakdownLimit)
  }

  #row(
    key: string,
    moduleName: string,
    entryId: string,
    fiberPhase: string,
    cpuCounts: ReadonlyMap<string, number>,
    heapCounts: ReadonlyMap<string, number>,
    ioPerOwner: ReadonlyMap<string, { readonly read: number; readonly write: number }>,
    listeners: ReadonlyMap<string, number> | null,
    footprint: ReadonlyMap<string, number>,
    activeSamples: number,
    intervalMs: number,
  ): PluginMetricRow {
    const cpuSamples = cpuCounts.get(key) ?? 0
    const ioCounts = ioPerOwner.get(key)
    const listenerCount = listeners?.get(key)
    return {
      moduleName,
      entryId,
      fiberPhase,
      cpuShare: activeSamples === 0 ? 0 : cpuSamples / activeSamples,
      cpuSelfMs: cpuSamples * intervalMs,
      liveHeapBytes: heapCounts.get(key) ?? 0,
      allocBytesPerSec: 0,
      fsReadOps: ioCounts?.read ?? 0,
      fsWriteOps: ioCounts?.write ?? 0,
      fsReadBytes: 0,
      fsWriteBytes: 0,
      coverage: 0,
      // Absent, not zero: neither has a mechanism that is cheap enough to be
      // always true (evidence 15), and a false zero reads as "none".
      listeners: listenerCount,
      diskFootprintBytes: footprint.get(key) ?? 0,
    }
  }

  async #loop(generation: number): Promise<void> {
    while (this.#running && generation === this.#generation) {
      if (this.mode === 'paused') {
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
      if (continuousExpired(this.mode, this.#clock().now(), this.#continuousSince, this.#options.continuousMaxMs)) {
        // The high tier is a bounded boost, not a setting: drop back to low and
        // let the panel's segment show it, rather than silently sampling on.
        this.#sampling = { ...this.#sampling, intensity: 'low' }
      }
      // Always await, even for 0: in continuous mode a window that throws
      // synchronously would otherwise loop entirely on microtasks and starve
      // the host event loop (observed as dsh hanging). A macrotask yield per
      // iteration is the safety valve.
      const nominal = nextIdleWait(this.mode, this.#options.idleMs, this.#lastIdleShare, this.#options.backgroundIdleMs)
      // After a failed window, never retry faster than 30s: a broken profiler or
      // owner index must not turn continuous mode into a hammering loop.
      const wait = this.#lastError === null ? nominal : Math.max(nominal, 30_000)
      await this.#sleepWithSentinel(wait)
    }
  }
}
