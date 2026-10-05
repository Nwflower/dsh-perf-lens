// Per-plugin on-disk bytes (roadmap item 4).
//
// The README promises a panel that shows which plugin is using CPU, memory and
// disk. Disk so far meant file-operation counts, which answer "who is hammering
// the disk" but not "who is holding two gigabytes". Footprint is the one disk
// metric that is exact, cheap and needs no interception: walk the harness home,
// map every path to its owning plugin through the same prefix index attribution
// already uses, and sum bytes.
//
// It is deliberately NOT part of the sampling window. A directory walk is orders
// of magnitude more expensive than a sampling window, so it runs on its own slow
// timer, off the hot path, with an entry and time budget. The figures it produces
// are live-only: they are stripped before a window is persisted, because writing
// a slow-moving byte count into every record would multiply the log by the plugin
// count for no history value.

import { opendir, lstat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import type { DiskFootprintReading } from '../shared/contract'
import { normalizePath, ownerKey, type OwnerIndex } from './attribute'

/**
 * Longest-prefix owner of one absolute path, or null when nothing owns it.
 *
 * The index is already sorted longest-prefix-first by createOwnerIndex, so the
 * first match is the most specific one. Paths are normalized the same way frame
 * URLs are, or every Windows comparison would silently miss.
 */
export function ownerKeyOfPath(path: string, index: OwnerIndex): string | null {
  const normalized = normalizePath(path)
  for (const rule of index.rules) {
    if (normalized.startsWith(rule.prefix)) return ownerKey({ kind: rule.kind, name: rule.name })
  }
  return null
}

/** Filesystem surface the walk needs; injectable so the scanner is testable. */
export interface FootprintFs {
  openDir(path: string): Promise<AsyncIterable<Dirent>>
  /** Size and kind of one entry. Symbolic links are never followed. */
  lstat(path: string): Promise<{ readonly size: number; isDirectory(): boolean; isFile(): boolean }>
}

export const NODE_FOOTPRINT_FS: FootprintFs = {
  openDir: (path) => opendir(path),
  lstat: (path) => lstat(path),
}

export interface DiskFootprintOptions {
  /** Ceiling on directory entries visited per scan. */
  readonly maxEntries?: number
  /** Ceiling on wall time per scan. */
  readonly maxMs?: number
}

export const DEFAULT_FOOTPRINT_OPTIONS: Required<DiskFootprintOptions> = {
  maxEntries: 200_000,
  maxMs: 4_000,
}

/** Result of one walk: the reading plus the per-owner byte totals it produced. */
export interface FootprintScan {
  readonly reading: DiskFootprintReading
  readonly perOwner: ReadonlyMap<string, number>
}

export interface DiskFootprintDeps {
  readonly fs: FootprintFs
  readonly now: () => number
  /** Owner index in force at scan time. */
  readonly ownerIndex: () => OwnerIndex
}

/**
 * Walks a set of roots and totals bytes per owner.
 *
 * Roots are usually the harness home, but they must also include each plugin's
 * own resolved directory: a plugin installed with `link:` (or any symlink) lives
 * outside the home, and the walk never follows symlinks, so the home walk alone
 * would report 0 bytes for exactly the plugins a developer cares about. The
 * caller supplies them through a provider because the owner index is rebuilt.
 *
 * Directories are visited at most once, so a plugin directory that is also
 * inside the home cannot be counted twice.
 */
export class DiskFootprintScanner {
  readonly #deps: DiskFootprintDeps
  readonly #options: Required<DiskFootprintOptions>
  #last: FootprintScan | null = null
  #timer: ReturnType<typeof setInterval> | undefined
  #inFlight = false

  constructor(deps: DiskFootprintDeps, options: DiskFootprintOptions = {}) {
    this.#deps = deps
    this.#options = { ...DEFAULT_FOOTPRINT_OPTIONS, ...options }
  }

  get reading(): DiskFootprintReading | null { return this.#last?.reading ?? null }
  get perOwner(): ReadonlyMap<string, number> { return this.#last?.perOwner ?? EMPTY_BYTES }

  /** Run scans on a slow timer. The first scan is delayed, not immediate. */
  start(roots: () => readonly string[], intervalMs = 600_000): void {
    if (this.#timer !== undefined) return
    const timer = setInterval(() => { void this.scan(roots) }, intervalMs)
    timer.unref?.()
    this.#timer = timer
  }

  stop(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  /** One full walk. Never throws: an unreadable tree degrades to a partial scan. */
  async scan(roots: readonly string[] | (() => readonly string[])): Promise<FootprintScan> {
    if (this.#inFlight) return this.#last ?? emptyScan(this.#deps.now())
    this.#inFlight = true
    const startedAt = this.#deps.now()
    const deadline = startedAt + this.#options.maxMs
    const index = this.#deps.ownerIndex()
    const perOwner = new Map<string, number>()
    let scannedFiles = 0
    let scannedBytes = 0
    let ownedBytes = 0
    let truncated = false
    // Keyed by normalized path: a plugin directory inside the home must not be
    // walked a second time through its own root.
    const visited = new Set<string>()
    try {
      const resolvedRoots = typeof roots === 'function' ? roots() : roots
      // Roots carry a flag so an unreadable one can be reported: a root that
      // cannot be opened would otherwise leave an empty scan that reads as
      // "nothing on disk" instead of "the walk never started".
      const queue: { path: string; isRoot: boolean }[] = resolvedRoots.map(path => ({ path, isRoot: true }))
      let entries = 0
      while (queue.length > 0) {
        if (entries >= this.#options.maxEntries || this.#deps.now() > deadline) {
          truncated = true
          break
        }
        const current = queue.shift() as { path: string; isRoot: boolean }
        const dir = current.path
        const visitKey = normalizePath(dir)
        if (visited.has(visitKey)) continue
        visited.add(visitKey)
        let handle: AsyncIterable<Dirent>
        try {
          handle = await this.#deps.fs.openDir(dir)
        } catch {
          if (current.isRoot) truncated = true
          continue
        }
        try {
          for await (const entry of handle) {
            entries += 1
            if (entries >= this.#options.maxEntries || this.#deps.now() > deadline) {
              truncated = true
              break
            }
            const child = `${dir}${dir.endsWith('/') || dir.endsWith('\\') ? '' : '/'}${entry.name}`
            // lstat, never stat: a symlinked directory would either loop or
            // walk outside the harness home entirely.
            let stats: { readonly size: number; isDirectory(): boolean; isFile(): boolean }
            try {
              stats = await this.#deps.fs.lstat(child)
            } catch {
              continue
            }
            if (stats.isDirectory()) {
              queue.push({ path: child, isRoot: false })
              continue
            }
            if (!stats.isFile()) continue
            scannedFiles += 1
            scannedBytes += stats.size
            const key = ownerKeyOfPath(child, index)
            if (key === null) continue
            ownedBytes += stats.size
            perOwner.set(key, (perOwner.get(key) ?? 0) + stats.size)
          }
        } catch {
          // A directory that fails mid-iteration is skipped, not fatal.
        }
      }
    } finally {
      this.#inFlight = false
    }
    const scan: FootprintScan = {
      reading: {
        scannedAt: this.#deps.now(),
        scannedFiles,
        scannedBytes,
        ownedBytes,
        truncated,
      },
      perOwner,
    }
    this.#last = scan
    return scan
  }
}

const EMPTY_BYTES: ReadonlyMap<string, number> = new Map()

function emptyScan(at: number): FootprintScan {
  return {
    reading: { scannedAt: at, scannedFiles: 0, scannedBytes: 0, ownedBytes: 0, truncated: true },
    perOwner: EMPTY_BYTES,
  }
}