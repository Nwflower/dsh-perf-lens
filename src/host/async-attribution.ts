// Async-context CPU re-attribution: "mechanism C" in
// docs/design-overnight-analyzer.md (§6.5 describes it, §13.8 the implementation).
//
// The ancestor-stack rule attributes a sample to the nearest plugin frame on
// the JS stack. When a plugin hands work to a harness timer/callback, that
// frame is gone by the time the callback runs, so the cost lands on harness.
// This module records, per async resource, which plugin created it and when its
// callbacks executed; CPU samples are then time-correlated to those windows so
// plugin-initiated work can be moved back to the plugin.
//
// Deep mode only. async_hooks before/after fire on every async callback and the
// init hook captures a stack per resource, which is far too expensive to leave
// on (the same reasoning as hard constraint 3). The probe that validated the correlation is
// probes/19-mechanism-c.mjs; the clock handling is what makes it work at all
// (V8's profile clock is boot-monotonic, not performance.now()).

import { createHook, type AsyncHook } from 'node:async_hooks'
import {
  attributeFrameList,
  attributeNode,
  buildNodeMap,
  buildParentMap,
  frameUrlsOfStack,
  ownerKey,
  type OwnerIndex,
  type ProfileNode,
} from './attribute'

/** One execution window of an async resource, on the recorder's clock. */
export interface AsyncWindow {
  readonly asyncId: number
  readonly startUs: number
  readonly endUs: number
}

export interface AsyncWindowRecorderOptions {
  /** Monotonic microsecond clock; injectable so correlation is testable. */
  readonly nowUs?: () => number
}

/** Drained windows plus the asyncId -> plugin owner map they refer to. */
export interface AsyncWindowSample {
  readonly windows: readonly AsyncWindow[]
  readonly ownerOf: ReadonlyMap<number, string>
}

/**
 * Watches async resources created inside a plugin's async context and records
 * when their callbacks execute. Only plugin-owned resources are kept: work
 * already owned by harness or the runtime needs no correction.
 */
export class AsyncWindowRecorder {
  #hook: AsyncHook | undefined
  #index: OwnerIndex = { rules: [] }
  #ownerOf = new Map<number, string>()
  #windows: AsyncWindow[] = []
  #open = new Map<number, number[]>()
  readonly #nowUs: () => number

  constructor(options: AsyncWindowRecorderOptions = {}) {
    this.#nowUs = options.nowUs ?? (() => performance.now() * 1000)
  }

  get enabled(): boolean {
    return this.#hook !== undefined
  }

  setOwnerIndex(index: OwnerIndex): void {
    this.#index = index
  }

  enable(): void {
    if (this.#hook !== undefined) return
    this.#hook = createHook({
      init: (asyncId) => { this.#onInit(asyncId) },
      before: (asyncId) => { this.#onBefore(asyncId) },
      after: (asyncId) => { this.#onAfter(asyncId) },
    })
    this.#hook.enable()
  }

  disable(): void {
    this.#hook?.disable()
    this.#hook = undefined
    this.#ownerOf = new Map()
    this.#windows = []
    this.#open.clear()
  }

  /** Drain the windows recorded since the previous call. */
  take(): AsyncWindowSample {
    const sample: AsyncWindowSample = { windows: this.#windows, ownerOf: this.#ownerOf }
    this.#windows = []
    this.#ownerOf = new Map()
    this.#open.clear()
    return sample
  }

  #onInit(asyncId: number): void {
    // The innermost frames are this hook's own plumbing; a genuine perf-lens
    // async resource is skipped, exactly like IoTracker's fs attribution.
    const owner = attributeFrameList(frameUrlsOfStack(new Error().stack ?? ''), this.#index, { skipSelf: true })
    const key = ownerKey(owner)
    if (key.startsWith('plugin:')) this.#ownerOf.set(asyncId, key)
  }

  #onBefore(asyncId: number): void {
    if (!this.#ownerOf.has(asyncId)) return
    const stack = this.#open.get(asyncId)
    if (stack === undefined) this.#open.set(asyncId, [this.#nowUs()])
    else stack.push(this.#nowUs())
  }

  #onAfter(asyncId: number): void {
    if (!this.#ownerOf.has(asyncId)) return
    const startUs = this.#open.get(asyncId)?.pop()
    if (startUs === undefined) return
    this.#windows.push({ asyncId, startUs, endUs: this.#nowUs() })
  }
}

/**
 * Absolute timestamps for V8's sample list, on the recorder's clock.
 *
 * V8's timeDeltas are measured from the profile's own boot-monotonic
 * startTime, which shares no origin with performance.now(). The sampler
 * records its wall clock just after start and just after stop; scaling the
 * deltas by the measured duration removes both the constant offset and any
 * clock-rate drift (measured ~0.8% over 1.1s in probes/19-mechanism-c.mjs).
 */
export function sampleTimesUs(
  startedAtUs: number,
  endedAtUs: number,
  profileStartUs: number,
  profileEndUs: number,
  timeDeltas: readonly number[],
): number[] {
  const profileUs = profileEndUs - profileStartUs
  const scale = profileUs > 0 ? (endedAtUs - startedAtUs) / profileUs : 1
  const out: number[] = []
  let time = startedAtUs
  for (const delta of timeDeltas) {
    time += delta * scale
    out.push(time)
  }
  return out
}

/** Result of correlating samples with async execution windows. */
export interface AsyncCorrelation {
  /** Sample index -> plugin owner key to use instead of the stack owner. */
  readonly override: ReadonlyMap<number, string>
  /** Samples that fell inside a plugin-owned async window. */
  readonly windowedSamples: number
}

/**
 * Re-attribute samples that fall inside a plugin-owned async window.
 *
 * A plugin already on the JS stack is more specific than the async context, so
 * those samples are left alone; idle samples are never in a plugin's callback.
 * This is the correction for mechanism C: a harness frame executing work the
 * plugin scheduled.
 */
export function correlateSamples(
  samples: readonly number[],
  times: readonly number[],
  windows: readonly AsyncWindow[],
  ownerOfAsyncId: ReadonlyMap<number, string>,
  nodes: readonly ProfileNode[],
  index: OwnerIndex,
): AsyncCorrelation {
  const nodesById = buildNodeMap(nodes)
  const parentOf = buildParentMap(nodes)
  const ownerOfNode = new Map<number, string>()
  const stackOwner = (nodeId: number): string => {
    let key = ownerOfNode.get(nodeId)
    if (key === undefined) {
      key = ownerKey(attributeNode(nodeId, nodesById, parentOf, index))
      ownerOfNode.set(nodeId, key)
    }
    return key
  }
  const ordered = [...windows].sort((a, b) => a.startUs - b.startUs)
  // Prefix maximum of end times, computed once: it lets the backward search
  // stop as soon as no earlier window can still cover the sample time.
  const prefixMaxEnd: number[] = []
  let maxEnd = 0
  for (const window of ordered) {
    if (window.endUs > maxEnd) maxEnd = window.endUs
    prefixMaxEnd.push(maxEnd)
  }
  const override = new Map<number, string>()
  let windowedSamples = 0
  for (let i = 0; i < samples.length; i++) {
    const time = times[i]
    const nodeId = samples[i]
    if (time === undefined || nodeId === undefined) continue
    const stackKey = stackOwner(nodeId)
    if (stackKey === 'idle' || stackKey.startsWith('plugin:')) continue
    const window = innermostWindowAt(ordered, prefixMaxEnd, time)
    if (window === null) continue
    const owner = ownerOfAsyncId.get(window.asyncId)
    if (owner === undefined) continue
    windowedSamples += 1
    override.set(i, owner)
  }
  return { override, windowedSamples }
}

/**
 * The innermost window containing the time, or null.
 *
 * Windows are sorted by start. A prefix maximum of end times lets the backward
 * walk stop as soon as no earlier window can still cover the time, so the cost
 * is bounded by the nesting depth rather than the window count.
 */
function innermostWindowAt(
  windows: readonly AsyncWindow[],
  prefixMaxEnd: readonly number[],
  time: number,
): AsyncWindow | null {
  let low = 0
  let high = windows.length - 1
  let candidate = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    const window = windows[mid]
    if (window !== undefined && window.startUs <= time) {
      candidate = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  for (let i = candidate; i >= 0; i--) {
    const window = windows[i]
    if (window === undefined) break
    if (window.endUs >= time) return window
    if ((prefixMaxEnd[i] ?? 0) < time) break
  }
  return null
}
