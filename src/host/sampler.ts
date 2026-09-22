// Inspector sampling state machine.
//
// Hard constraint (docs/AGENTS.md 5): Profiler.stop on a session that is not
// recording throws ERR_INSPECTOR_COMMAND, so start/stop must be paired and the
// active flags are the only authority for whether a stop is legal. Never call a
// stop "just in case".

import type { ProfileNode } from './attribute'

/** The subset of node:inspector Session this module needs. */
export interface InspectorSession {
  post(
    method: string,
    params: object | undefined,
    callback: (error: Error | null, result?: unknown) => void,
  ): void
}

/** One node of a heap-sampling tree. */
export interface HeapNode {
  readonly callFrame?: { readonly url?: string | undefined } | undefined
  readonly selfSize: number
  readonly children?: readonly HeapNode[] | undefined
}

/** Result of a CPU window. */
export interface CpuProfileResult {
  readonly nodes: readonly ProfileNode[]
  readonly samples: readonly number[]
}

/** Result of a heap-sampling window: the live sampled tree at stop time. */
export interface HeapProfileResult {
  readonly head: HeapNode
}

export interface SamplerOptions {
  /** CPU sampling interval in microseconds. */
  readonly cpuIntervalUs: number
  /** Heap sampling interval in bytes; only used in deep mode. */
  readonly heapIntervalBytes: number
}

function post<T>(session: InspectorSession, method: string, params?: object): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    session.post(method, params, (error, result) => {
      if (error !== null) reject(error)
      else resolve(result as T)
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseCpuProfile(result: unknown): CpuProfileResult {
  if (!isRecord(result)) throw new Error('Profiler.stop returned no profile')
  // CDP wraps the result: Profiler.stop -> { profile: { nodes, samples, ... } }.
  // Reading the top level silently yields zero samples (observed live: every
  // window reported sampleCount 0 while the process was busy), so accept the
  // wrapped shape first and tolerate a bare profile for other inspector versions.
  const profile = isRecord(result.profile) ? result.profile : result
  const nodes = Array.isArray(profile.nodes) ? profile.nodes as ProfileNode[] : []
  const samples = Array.isArray(profile.samples)
    ? profile.samples.filter((sample): sample is number => typeof sample === 'number')
    : []
  return { nodes, samples }
}

function parseHeapProfile(result: unknown): HeapProfileResult {
  if (!isRecord(result) || !isRecord(result.profile) || !isRecord(result.profile.head)) {
    throw new Error('HeapProfiler.stopSampling returned no profile')
  }
  return { head: result.profile.head as unknown as HeapNode }
}

/** CPU + heap sampling over one inspector session. */
export class Sampler {
  #cpuActive = false
  #heapActive = false
  #disposed = false

  constructor(
    private readonly session: InspectorSession,
    private readonly options: SamplerOptions,
  ) {}

  get cpuActive(): boolean { return this.#cpuActive }
  get heapActive(): boolean { return this.#heapActive }
  get disposed(): boolean { return this.#disposed }

  /**
   * Begin a CPU window. Idempotent while already recording.
   *
   * `intervalUs` overrides the configured interval for this window, which is
   * how the background profile samples more coarsely without rebuilding the
   * sampler.
   */
  async startCpu(intervalUs: number = this.options.cpuIntervalUs): Promise<void> {
    this.#assertLive()
    if (this.#cpuActive) return
    await post(this.session, 'Profiler.enable')
    await post(this.session, 'Profiler.setSamplingInterval', { interval: intervalUs })
    await post(this.session, 'Profiler.start')
    this.#cpuActive = true
  }

  /** End a CPU window. Returns null when no window is active; never blind-stops. */
  async stopCpu(): Promise<CpuProfileResult | null> {
    if (!this.#cpuActive) return null
    // Clear the flag first: a failed stop must not leave the machine believing a
    // window is open when the profiler already rejected the call.
    this.#cpuActive = false
    const result = await post(this.session, 'Profiler.stop')
    return parseCpuProfile(result)
  }

  /** Begin a heap-sampling window (deep mode). */
  async startHeap(): Promise<void> {
    this.#assertLive()
    if (this.#heapActive) return
    await post(this.session, 'HeapProfiler.enable')
    await post(this.session, 'HeapProfiler.startSampling', { samplingInterval: this.options.heapIntervalBytes })
    this.#heapActive = true
  }

  /**
   * End a heap-sampling window and release the tree. The tree grows for as long
   * as sampling runs, so every window must stop it; no unbounded accumulation.
   */
  async stopHeap(): Promise<HeapProfileResult | null> {
    if (!this.#heapActive) return null
    this.#heapActive = false
    const result = await post(this.session, 'HeapProfiler.stopSampling')
    return parseHeapProfile(result)
  }

  /** Stop whatever is active and disable both domains. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#cpuActive) {
      this.#cpuActive = false
      try { await post(this.session, 'Profiler.stop') } catch { /* teardown is best-effort */ }
    }
    if (this.#heapActive) {
      this.#heapActive = false
      try { await post(this.session, 'HeapProfiler.stopSampling') } catch { /* teardown is best-effort */ }
    }
    try { await post(this.session, 'Profiler.disable') } catch { /* domain may be off */ }
    try { await post(this.session, 'HeapProfiler.disable') } catch { /* domain may be off */ }
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('sampler disposed')
  }
}
