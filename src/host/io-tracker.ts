// Per-plugin file-operation counting with zero patching.
//
// Hard constraint (docs/evidence.md evidence 3): monkey-patching node:fs is
// silently bypassed by ESM named imports, so it can never be trusted for
// attribution. async_hooks needs no patch: every async fs resource is created
// with the caller still on the stack, and that stack is what we attribute.
//
// Known limits (evidence 7): synchronous fs calls create no async resource and
// are therefore NOT counted here; the CPU profiler's node:fs frames cover them
// approximately, with correct ownership. The read/write split below is a
// heuristic over the call site — the per-owner TOTAL is exact, the split is not.

import { createHook, type AsyncHook } from 'node:async_hooks'
import {
  attributeFrameList,
  classifyFrameUrl,
  frameUrlsOfStack,
  ownerKey,
  type FrameOwner,
  type OwnerIndex,
} from './attribute'

/** Async-resource types the Node fs implementation creates. */
export const FS_ASYNC_TYPES: ReadonlySet<string> = new Set([
  'FSREQPROMISE',
  'FSREQCALLBACK',
  'FILEHANDLECLOSEREQ',
  'FSEVENTWRAP',
])

/** True when an async-resource type is one file operation. */
export function isFsAsyncType(type: string): boolean {
  return FS_ASYNC_TYPES.has(type)
}

// Mutating fs entry points. Anything else (readFile, stat, readdir, open …) is
// counted as a read. The total is exact either way; only this split is a guess.
const WRITE_CALL = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|writeSync|writev|truncate|mkdir|rmdir|rm\b|unlink|rename|copyFile|chmod|chown|utimes|ftruncate)\b/

/** Coarse read/write direction of one fs call site. */
export function classifyFsOperation(stack: string): 'read' | 'write' {
  return WRITE_CALL.test(stack) ? 'write' : 'read'
}

/**
 * Attribute one async fs resource to an owner from its creation stack.
 *
 * The innermost frames belong to this plugin's own hook plumbing, so they are
 * dropped before the walk; any remaining self frame is a genuine perf-lens file
 * operation and is reported as self.
 */
export function ownerOfFsInit(stack: string, index: OwnerIndex): FrameOwner {
  const urls = frameUrlsOfStack(stack)
  let first = 0
  while (first < urls.length && classifyFrameUrl(urls[first], index).kind === 'self') first += 1
  return attributeFrameList(urls.slice(first), index)
}

/** Read/write operation counts for one owner. */
export interface IoCounts {
  readonly read: number
  readonly write: number
}

/** Counters drained from one sampling window. */
export interface IoSample {
  readonly perOwner: ReadonlyMap<string, IoCounts>
  readonly total: number
}

export interface IoTrackerOptions {
  /**
   * Capture a stack per fs resource. Off keeps overhead to a bare counter but
   * loses per-plugin attribution (only the process total remains).
   */
  readonly captureStacks?: boolean
}

/** Watches async fs resources and tallies them per owner. */
export class IoTracker {
  #hook: AsyncHook | undefined
  #index: OwnerIndex = { rules: [] }
  #counts = new Map<string, { read: number; write: number }>()
  #total = 0
  readonly #captureStacks: boolean

  constructor(options: IoTrackerOptions = {}) {
    this.#captureStacks = options.captureStacks ?? true
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
      init: (_asyncId, type) => { this.#onInit(type) },
    })
    this.#hook.enable()
  }

  disable(): void {
    this.#hook?.disable()
    this.#hook = undefined
  }

  /** Drain the counters accumulated since the previous call. */
  take(): IoSample {
    const perOwner = new Map<string, IoCounts>()
    for (const [key, counts] of this.#counts) perOwner.set(key, { read: counts.read, write: counts.write })
    const sample: IoSample = { perOwner, total: this.#total }
    this.#counts.clear()
    this.#total = 0
    return sample
  }

  #onInit(type: string): void {
    if (!isFsAsyncType(type)) return
    this.#total += 1
    if (!this.#captureStacks) return
    const stack = new Error().stack ?? ''
    const key = ownerKey(ownerOfFsInit(stack, this.#index))
    const counts = this.#counts.get(key) ?? { read: 0, write: 0 }
    if (classifyFsOperation(stack) === 'write') counts.write += 1
    else counts.read += 1
    this.#counts.set(key, counts)
  }
}
