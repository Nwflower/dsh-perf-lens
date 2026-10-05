// Time-series retention: a short in-memory ring for the live panel plus one
// JSONL line per window on disk for "which plugin got worse last week".
//
// What is persisted is the aggregated snapshot only — never a raw profile tree
// or a call frame (size and privacy both forbid it).
//
// The range endpoints read through an incremental cache (summaries): each file
// is parsed once, then only from where the last read stopped, and only the
// fields the aggregators use are kept.

import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import type { PerfSnapshot, PluginMetricRow } from '../shared/contract'
import type { WindowSummary } from './stats'

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

/**
 * Whether a row carries any measured activity at all.
 *
 * Every field is a cost or a count, so a row with none of them is not a
 * measurement — it is the plugin inventory restated. Measured on a live host:
 * 214 of 220 rows per window were all-zero, because `ctx.loader.entries()`
 * enumerates every harness internal package and each one only ever shows up
 * under its `harness:` owner key, never as its own `plugin:` row.
 */
export function rowHasActivity(row: PluginMetricRow): boolean {
  return row.cpuShare > 0
    || row.cpuSelfMs > 0
    || row.liveHeapBytes > 0
    || row.allocBytesPerSec > 0
    || row.fsReadOps > 0
    || row.fsWriteOps > 0
    || row.fsReadBytes > 0
    || row.fsWriteBytes > 0
}

/**
 * The per-row live gauges added in 0.2.0 (timers, listeners, handles, disk
 * footprint). They are state, not window cost: persisting them would make every
 * plugin with one idle timer an "active" row in every record, multiplying the
 * log by the plugin count for a figure no range aggregator reads. They are
 * stripped before writing, so the log's shape is unchanged.
 */
export const LIVE_GAUGE_FIELDS = ['timers', 'listeners', 'handles', 'diskFootprintBytes'] as const

/**
 * Serialize one window as a JSONL record.
 *
 * The harness breakdown is a live-view extra: the log keeps the folded
 * `harness` row and drops the sub-package rows, so a 200-package install does
 * not multiply every persisted window by ten.
 *
 * All-zero rows are dropped too. They are the inventory, not a reading: the
 * live snapshot still carries every plugin so the board can list idle ones, but
 * persisting them cost ~68 KB per window on a real host (measured 2026-09-23)
 * for no history value. Absence from a persisted window means "zero activity in
 * that window", which is exactly what the range aggregators already assume.
 */
export function serializeSnapshot(snapshot: PerfSnapshot): string {
  // Spread into a mutable record so the optional field can be dropped without
  // tripping the contract's readonly modifiers.
  const persisted: Record<string, unknown> = { ...snapshot }
  delete persisted.harnessBreakdown
  // Derivable from `mode` (shared/sampling.ts configFromMode) and the log is
  // size-sensitive: one record per window per day.
  delete persisted.sampling
  // Live gauges on their own slow timers: a window record cannot say when they
  // were taken, so they are not persisted at all (see LIVE_GAUGE_FIELDS).
  delete persisted.processTree
  delete persisted.diskFootprint
  persisted.plugins = snapshot.plugins
    .filter(rowHasActivity)
    .map(row => {
      const copy: Record<string, unknown> = { ...row }
      for (const field of LIVE_GAUGE_FIELDS) delete copy[field]
      return copy
    })
  return JSON.stringify(persisted)
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
  /** Bytes from `position` to the current end of the file. */
  readTailSync(path: string, position: number): Buffer
  readdirSync(path: string): string[]
  statSync(path: string): { readonly size: number; readonly mtimeMs: number }
  unlinkSync(path: string): void
}

/** node:fs implementation. */
export const NODE_HISTORY_FS: HistoryFs = {
  mkdirSync: (path) => { mkdirSync(path, { recursive: true }) },
  appendFileSync: (path, data) => { appendFileSync(path, data) },
  readFileSync: (path) => readFileSync(path, 'utf8'),
  readTailSync: (path, position) => {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(Math.max(0, fstatSync(fd).size - position))
      let filled = 0
      while (filled < buffer.length) {
        const read = readSync(fd, buffer, filled, buffer.length - filled, position + filled)
        if (read === 0) break
        filled += read
      }
      return buffer.subarray(0, filled)
    } finally {
      closeSync(fd)
    }
  },
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

/**
 * Whether a day file can only hold windows that started before `since`.
 *
 * A window is appended when it ends, so file D holds windows that started
 * before the end of UTC day D. One more day of slack absorbs a wall-clock
 * adjustment between a window's start and its write. A name that does not
 * parse is never skipped.
 */
function fileEndsBefore(file: string, since: number): boolean {
  const digits = file.slice(FILE_PREFIX.length, FILE_PREFIX.length + 8)
  const dayStart = Date.UTC(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)) - 1, Number(digits.slice(6, 8)))
  return Number.isFinite(dayStart) && dayStart + 2 * DAY_MS <= since
}

/** One day file's parsed windows, up to its last complete line. */
interface FileSummaries {
  /** Bytes consumed so far; always at a line boundary. */
  offset: number
  readonly windows: WindowSummary[]
}

/** Ring plus JSONL persistence. Every disk failure is best-effort and silent. */
export class HistoryStore {
  readonly #ring: RingBuffer<PerfSnapshot>
  readonly #fs: HistoryFs
  readonly #options: HistoryOptions
  #dirReady = false
  /** Parsed windows per day file, for the range endpoints. */
  readonly #summaries = new Map<string, FileSummaries>()
  /** One string per module name across every cached window. */
  readonly #names = new Map<string, string>()

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
   * Persisted windows at or after `since`, reduced to the fields the range
   * aggregators read, oldest first.
   *
   * This is the panel's hot path (/stats and /trend on every refresh), so it
   * never parses a line twice: each file is read on from where the last call
   * stopped, and a day file that ended before `since` is not opened at all.
   * Before this, every call re-read and re-parsed the whole log on the event
   * loop — about 200ms per call against a 39MB day file, two calls per refresh.
   */
  summaries(since?: number): WindowSummary[] {
    const files = this.#files()
    const listed = new Set(files)
    for (const file of this.#summaries.keys()) {
      if (!listed.has(file)) this.#summaries.delete(file)
    }
    const out: WindowSummary[] = []
    for (const file of files) {
      if (since !== undefined && fileEndsBefore(file, since)) continue
      for (const window of this.#refresh(file)) {
        if (since === undefined || window.windowStartedAt >= since) out.push(window)
      }
    }
    out.sort((a, b) => a.windowStartedAt - b.windowStartedAt)
    return out
  }

  /** Bring one file's cached windows up to its current end. */
  #refresh(file: string): readonly WindowSummary[] {
    const path = join(this.#options.dir, file)
    let cached = this.#summaries.get(file)
    let size: number
    try { size = this.#fs.statSync(path).size } catch { return cached?.windows ?? [] }
    // Shorter than what was already consumed: the file was replaced (pruned
    // and recreated, or edited by hand). Start over rather than misparse.
    if (cached === undefined || size < cached.offset) {
      cached = { offset: 0, windows: [] }
      this.#summaries.set(file, cached)
    }
    if (size === cached.offset) return cached.windows
    let bytes: Buffer
    try { bytes = this.#fs.readTailSync(path, cached.offset) } catch { return cached.windows }
    // Whole lines only: a line still being appended is picked up next time.
    const end = bytes.lastIndexOf(0x0a)
    if (end < 0) return cached.windows
    for (const line of bytes.toString('utf8', 0, end + 1).split('\n')) {
      const snapshot = parseSnapshot(line)
      const summary = snapshot === null ? null : this.#summarize(snapshot)
      if (summary !== null) cached.windows.push(summary)
    }
    cached.offset += end + 1
    return cached.windows
  }

  /**
   * Keep what the aggregators read. All-zero rows are dropped the same way the
   * writer drops them (rowHasActivity), so windows written before the writer
   * learned to — ~66KB each on a real host — cost no more to hold than new ones.
   */
  #summarize(snapshot: PerfSnapshot): WindowSummary | null {
    // parseSnapshot casts rather than validates; a line of the wrong shape is
    // skipped here instead of throwing on every later read of the same file.
    const shape = snapshot as Partial<PerfSnapshot>
    if (
      typeof shape.windowStartedAt !== 'number'
      || !Array.isArray(shape.plugins)
      || typeof shape.global?.sampleWindowMs !== 'number'
    ) return null
    const plugins: WindowSummary['plugins'][number][] = []
    for (const row of snapshot.plugins) {
      if (!rowHasActivity(row)) continue
      let moduleName = this.#names.get(row.moduleName)
      if (moduleName === undefined) {
        moduleName = row.moduleName
        this.#names.set(moduleName, moduleName)
      }
      plugins.push({ moduleName, cpuShare: row.cpuShare, cpuSelfMs: row.cpuSelfMs })
    }
    return {
      windowStartedAt: snapshot.windowStartedAt,
      global: { sampleWindowMs: snapshot.global.sampleWindowMs },
      plugins,
    }
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
      // A day file recreated after this could regrow past the cached offset
      // before the next read notices it was replaced.
      this.#summaries.delete(basename(path))
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
