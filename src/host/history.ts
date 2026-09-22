// Time-series retention: a short in-memory ring for the live panel plus one
// JSONL line per window on disk for "which plugin got worse last week".
//
// What is persisted is the aggregated snapshot only — never a raw profile tree
// or a call frame (size and privacy both forbid it).

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type { PerfSnapshot } from '../shared/contract'

/** Fixed-capacity FIFO that drops the oldest item on overflow. */
export class RingBuffer<T> {
  readonly #capacity: number
  #items: T[] = []

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer')
    this.#capacity = capacity
  }

  push(value: T): void {
    this.#items.push(value)
    if (this.#items.length > this.#capacity) this.#items.splice(0, this.#items.length - this.#capacity)
  }

  toArray(): T[] {
    return [...this.#items]
  }

  get size(): number {
    return this.#items.length
  }
}

/** Serialize one window as a JSONL record. */
export function serializeSnapshot(snapshot: PerfSnapshot): string {
  return JSON.stringify(snapshot)
}

/** Parse one JSONL record; returns null for blank or malformed lines. */
export function parseSnapshot(line: string): PerfSnapshot | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  try {
    const value: unknown = JSON.parse(trimmed)
    if (typeof value !== 'object' || value === null) return null
    return value as PerfSnapshot
  } catch {
    return null
  }
}

/** File operations history needs; injectable so retention is testable offline. */
export interface HistoryFs {
  mkdirSync(path: string): void
  appendFileSync(path: string, data: string): void
  readFileSync(path: string): string
  readdirSync(path: string): string[]
  statSync(path: string): { readonly size: number; readonly mtimeMs: number }
  unlinkSync(path: string): void
}

/** node:fs implementation. */
export const NODE_HISTORY_FS: HistoryFs = {
  mkdirSync: (path) => { mkdirSync(path, { recursive: true }) },
  appendFileSync: (path, data) => { appendFileSync(path, data) },
  readFileSync: (path) => readFileSync(path, 'utf8'),
  readdirSync: (path) => readdirSync(path),
  statSync: (path) => statSync(path),
  unlinkSync: (path) => { unlinkSync(path) },
}

const FILE_PREFIX = 'metrics-'
const FILE_SUFFIX = '.jsonl'
const DAY_MS = 24 * 60 * 60 * 1000

export interface HistoryOptions {
  readonly dir: string
  readonly retentionDays: number
  readonly maxBytes: number
  /** Ring capacity for the live panel; defaults to 1h at the default 30s cadence. */
  readonly ringCapacity?: number
}

/** Stable per-day file name, UTC so tests are timezone-independent. */
export function historyFileName(date: Date): string {
  return `${FILE_PREFIX}${date.toISOString().slice(0, 10).replace(/-/g, '')}${FILE_SUFFIX}`
}

/** Ring plus JSONL persistence. Every disk failure is best-effort and silent. */
export class HistoryStore {
  readonly #ring: RingBuffer<PerfSnapshot>
  readonly #fs: HistoryFs
  readonly #options: HistoryOptions
  #dirReady = false

  constructor(options: HistoryOptions, fs: HistoryFs = NODE_HISTORY_FS) {
    this.#options = options
    this.#fs = fs
    this.#ring = new RingBuffer<PerfSnapshot>(options.ringCapacity ?? 120)
  }

  /** Append a window to the ring and, if persistence is on, to today's file. */
  record(snapshot: PerfSnapshot, persist: boolean, now: Date = new Date()): void {
    this.#ring.push(snapshot)
    if (!persist) return
    try {
      if (!this.#dirReady) {
        this.#fs.mkdirSync(this.#options.dir)
        this.#dirReady = true
      }
      this.#fs.appendFileSync(join(this.#options.dir, historyFileName(now)), `${serializeSnapshot(snapshot)}\n`)
    } catch {
      // A failed history write must never disturb sampling.
    }
  }

  /** Recent windows held in memory, oldest first. */
  recent(): readonly PerfSnapshot[] {
    return this.#ring.toArray()
  }

  /** All persisted windows at or after `since`, oldest first. */
  read(since?: number): PerfSnapshot[] {
    const out: PerfSnapshot[] = []
    for (const file of this.#files()) {
      let text: string
      try { text = this.#fs.readFileSync(join(this.#options.dir, file)) } catch { continue }
      for (const line of text.split('\n')) {
        const snapshot = parseSnapshot(line)
        if (snapshot === null) continue
        if (since !== undefined && snapshot.windowStartedAt < since) continue
        out.push(snapshot)
      }
    }
    out.sort((a, b) => a.windowStartedAt - b.windowStartedAt)
    return out
  }

  /**
   * Delete history files past the retention window and, if still over the size
   * cap, the oldest of what remains. Returns the deleted paths.
   */
  prune(now: number = Date.now()): string[] {
    const files = this.#files()
    const entries: { path: string; size: number; mtimeMs: number }[] = []
    for (const file of files) {
      const path = join(this.#options.dir, file)
      try {
        const stat = this.#fs.statSync(path)
        entries.push({ path, size: stat.size, mtimeMs: stat.mtimeMs })
      } catch { /* vanished between listing and stat */ }
    }
    const deleted: string[] = []
    const cutoff = now - this.#options.retentionDays * DAY_MS
    const survivors: typeof entries = []
    for (const entry of entries) {
      if (entry.mtimeMs < cutoff) deleted.push(entry.path)
      else survivors.push(entry)
    }
    survivors.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    let total = survivors.reduce((sum, entry) => sum + entry.size, 0)
    while (total > this.#options.maxBytes && survivors.length > 0) {
      const oldest = survivors.shift()
      if (oldest === undefined) break
      deleted.push(oldest.path)
      total -= oldest.size
    }
    for (const path of deleted) {
      try { this.#fs.unlinkSync(path) } catch { /* already gone */ }
    }
    return deleted
  }

  #files(): string[] {
    try {
      return this.#fs.readdirSync(this.#options.dir)
        .filter(name => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
        .sort()
    } catch {
      return []
    }
  }
}
