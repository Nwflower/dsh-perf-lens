// LoAF script-entry resolution: map a long-animation-frame script reference
// (script URL + UTF-16 char position) to the plugin that owns the code.
//
// Plugin bundles reach the page in three URL forms (deepseek-harness
// packages/client/modules/src/index.ts):
//   batch combo  plugins/??<id1>/client.js,<id2>/client.js&rev=<rev>
//   one-resource plugins/??<id>/client.js&rev=<rev>
//   chunk        plugins/<id>/client.<name>.js?rev=<rev>
// A batch concatenates each part as prepareSource(source) + ";\n" in URL
// order with no per-part sourceURL trailer, so a char position resolves by
// accumulating deterministic segment offsets. Everything here is a pure
// function of the URL and the parts' bytes; filesystem access is injected.

import { ownerKeyOfModule } from './plugin-index'
import type {
  JankRow,
  JankView,
  LoafReport,
  RawSourcePosition,
  ScheduleReport,
  ScheduleRow,
  ScheduleView,
} from '../shared/contract'

/** How a script URL sits in the plugin route namespace. */
export type PluginUrl =
  | { readonly kind: 'single'; readonly id: string }
  | { readonly kind: 'batch'; readonly ids: readonly string[] }
  | { readonly kind: 'chunk'; readonly id: string }
  | { readonly kind: 'other' }

/** Package-local chunk names the modules package serves (index.ts CLIENT_CHUNK). */
const CHUNK_PATH = /^(.*)\/(client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js)$/

const CLIENT_SUFFIX = '/client.js'

/** Classify one script URL against the /plugins/ route namespace. */
export function parsePluginUrl(url: string): PluginUrl {
  const hay = url.startsWith('plugins/') ? `/${url}` : url
  const marker = '/plugins/'
  const at = hay.indexOf(marker)
  if (at === -1) return { kind: 'other' }
  const rest = hay.slice(at + marker.length)
  if (rest.startsWith('??')) {
    // The combo resource list ends at the &rev= query, never a '?'.
    const list = rest.slice(2).split('&', 1)[0] ?? ''
    if (list === '') return { kind: 'other' }
    const ids: string[] = []
    for (const part of list.split(',')) {
      if (!part.endsWith(CLIENT_SUFFIX) || part.length <= CLIENT_SUFFIX.length) return { kind: 'other' }
      ids.push(part.slice(0, -CLIENT_SUFFIX.length))
    }
    const [only] = ids
    return ids.length === 1 && only !== undefined
      ? { kind: 'single', id: only }
      : { kind: 'batch', ids }
  }
  const path = rest.split(/[?#&]/, 1)[0] ?? ''
  const chunk = CHUNK_PATH.exec(path)
  if (chunk !== null && chunk[1] !== undefined && chunk[1] !== '') return { kind: 'chunk', id: chunk[1] }
  return { kind: 'other' }
}

// prepareSource replicas (modules index.ts:188-190, 305-314). Kept byte-for-byte:
// a segment table that drifts from the server's concatenation misattributes
// every frame after the drift, which is worse than no attribution.
const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/
const SOURCE_URL_TRAILER = /(?:\r?\n)?\/\/# sourceURL=[^\r\n]+(?:\r?\n)?$/

/** Replicate the modules package's prepareSource on one bundle's bytes. */
export function prepareComboSource(input: string): string {
  let source = input.replace(SOURCE_URL_TRAILER, '').replace(SOURCE_MAP_TRAILER, '')
  if (!source.endsWith('\n')) source += '\n'
  return source
}

/** One plugin's extent inside a batch combo script, in UTF-16 offsets. */
export interface PluginSegment {
  readonly id: string
  readonly start: number
  /** One past the last offset of this part (its own bytes plus the ";\n" joiner). */
  readonly end: number
  /** False when the bytes were unreadable; every later segment is unknown too. */
  readonly known: boolean
}

export interface SegmentTable {
  readonly segments: readonly PluginSegment[]
  /** True when every part resolved; the whole table is then exact. */
  readonly complete: boolean
  /**
   * UTF-16 offset of the first character of each generated line of the
   * concatenated row; index 0 is offset 0. A captured stack reports a line and
   * a column, while segments speak in offsets, so the two need this bridge:
   * `offset = lineStarts[line - 1] + column - 1`.
   */
  readonly lineStarts: readonly number[]
}

/**
 * Build the segment table for one batch combo. A part whose bytes cannot be
 * read makes its own and every later extent unknowable (offsets accumulate),
 * so those segments are marked unknown rather than guessed.
 */
export function buildSegmentTable(
  ids: readonly string[],
  sourceOf: (id: string) => string | undefined,
): SegmentTable {
  const segments: PluginSegment[] = []
  // The concatenated row is assembled here only to index its newlines, so it is
  // released with this frame. Its bytes are the server's by construction
  // (prepareSource + ";\n"), which is what makes a line/column resolvable.
  let row = ''
  let offset = 0
  let known = true
  for (const id of ids) {
    const raw = known ? sourceOf(id) : undefined
    if (raw === undefined) {
      known = false
      segments.push({ id, start: offset, end: offset, known: false })
      continue
    }
    const prepared = prepareComboSource(raw)
    const end = offset + prepared.length + 2
    segments.push({ id, start: offset, end, known: true })
    row += `${prepared};\n`
    offset = end
  }
  return { segments, complete: known, lineStarts: lineStartsOf(row) }
}

/** Offset of the first character of every line in one concatenated row. */
function lineStartsOf(row: string): number[] {
  const starts: number[] = [0]
  for (let index = 0; index < row.length; index += 1) {
    if (row.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return starts
}

/**
 * The plugin id owning one line/column pair inside a batch combo, or undefined
 * when the position is outside the row or its segment is unknown.
 *
 * This is the stack-capture form of {@link segmentOwnerOf}: an `Error` reports
 * the position already resolved against the whole concatenated row, so a line
 * and column are one array lookup plus the segment walk.
 */
export function segmentOwnerOfPosition(
  table: SegmentTable,
  line: number,
  column: number,
): string | undefined {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) return undefined
  const lineStart = table.lineStarts[line - 1]
  if (lineStart === undefined) return undefined
  return segmentOwnerOf(table, lineStart + column - 1)
}

/** The plugin id owning one char position, or undefined when it is unknowable. */
export function segmentOwnerOf(table: SegmentTable, charPosition: number): string | undefined {
  for (const segment of table.segments) {
    if (!segment.known) return undefined
    if (charPosition < segment.start) return undefined
    if (charPosition < segment.end) return segment.id
  }
  return undefined
}

/** Minimal filesystem the client-source reader needs; trivially fakeable. */
export interface LoafFs {
  readonly readFile: (path: string) => string | undefined
}

/**
 * Strip the leading slash normalizePath stamps before a Windows drive
 * (`/D:/x` → `D:/x`); node:fs cannot open the slash form.
 */
export function pathOnDisk(path: string): string {
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
}

function joinPath(dir: string, entry: string): string {
  return dir.endsWith('/') ? `${dir}${entry}` : `${dir}/${entry}`
}

/** The modules package's clientExportOf: exports["./client"] as string or { default }. */
export function clientExportOf(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null) return undefined
  const exportsField = (manifest as Record<string, unknown>).exports
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  return undefined
}

/**
 * Read one plugin's client bundle through its package manifest's
 * exports["./client"].
 *
 * The loader's baseUrl is the resolved ENTRY directory, which for a published
 * package is its `lib/` (measured: `…/dsh-client-ui-open-in-app/lib/`), not the
 * package root. The manifest is therefore located by walking up from that
 * directory, the way Node's own resolver walks up, and the first manifest whose
 * `name` matches the plugin id owns the bundle. A directory with no matching
 * ancestor manifest yields undefined — unattributable, never a guess.
 *
 * No cache: the resolver's URL-keyed table cache bounds reads already, and a rev
 * bump must see fresh bytes.
 */
export function createClientSourceReader(
  dirsOf: () => ReadonlyMap<string, string>,
  fs: LoafFs,
): (pluginId: string) => string | undefined {
  return (pluginId) => {
    const dir = dirsOf().get(pluginId)
    if (dir === undefined) return undefined
    let disk = pathOnDisk(dir)
    // The directory may carry no trailing slash; normalize so the walk can rely
    // on the last segment being empty.
    if (!disk.endsWith('/')) disk += '/'
    for (let depth = 0; depth < MANIFEST_WALK_DEPTH; depth += 1) {
      const manifestText = fs.readFile(joinPath(disk, 'package.json'))
      const root = disk.slice(0, disk.lastIndexOf('/', disk.length - 2) + 1)
      if (manifestText !== undefined) {
        let manifest: unknown
        try {
          manifest = JSON.parse(manifestText)
        } catch {
          return undefined
        }
        const name = typeof manifest === 'object' && manifest !== null
          ? (manifest as Record<string, unknown>).name
          : undefined
        if (name === pluginId) {
          const entry = clientExportOf(manifest)
          if (entry === undefined) return undefined
          // exports strings conventionally start with './'; keep the join literal.
          const relative = entry.startsWith('./') ? entry.slice(2) : entry
          return fs.readFile(joinPath(disk, relative))
        }
      }
      if (root === '' || root === disk) return undefined
      disk = root
    }
    return undefined
  }
}

/**
 * How far up from the entry directory the manifest search may climb.
 *
 * A package root sits one to three levels above its entry file
 * (`lib/`, `dist/entry/`), and a scoped package adds nothing above the root.
 * The bound stops a pathological path (a filesystem root) from walking forever.
 */
const MANIFEST_WALK_DEPTH = 6

export interface LoafResolverOptions {
  /** Bytes of one plugin's client bundle, or undefined when unreadable. */
  readonly clientSourceOf: (pluginId: string) => string | undefined
  /** Owner key for a plugin id; defaults to the host owner vocabulary. */
  readonly ownerKeyOf?: (pluginId: string) => string
  /** Bound on cached batch tables; oldest evicted first. Default 16. */
  readonly maxTables?: number
}

/**
 * Resolve LoAF script references to owner keys. Batch tables are cached per
 * exact URL — the rev lives in the URL, so a new build is a new key and no
 * invalidation bookkeeping exists by construction.
 */
export class LoafResolver {
  readonly #clientSourceOf: (pluginId: string) => string | undefined
  readonly #ownerKeyOf: (pluginId: string) => string
  readonly #maxTables: number
  readonly #tables = new Map<string, SegmentTable>()

  constructor(options: LoafResolverOptions) {
    this.#clientSourceOf = options.clientSourceOf
    this.#ownerKeyOf = options.ownerKeyOf ?? ((id) => ownerKeyOfModule(id))
    this.#maxTables = options.maxTables ?? 16
  }

  /** Owner key of one script reference; undefined when it cannot be resolved. */
  resolve(url: string, charPosition: number): string | undefined {
    const direct = this.#directOwner(url)
    if (direct !== DIRECT_BATCH) return direct
    const parsed = parsePluginUrl(url)
    if (parsed.kind !== 'batch') return undefined
    const id = segmentOwnerOf(this.#tableFor(url, parsed.ids), charPosition)
    return id === undefined ? undefined : this.#ownerKeyOf(id)
  }

  /**
   * Owner key of one line/column position inside a batch combo.
   *
   * The scheduler probe captures a stack instead of a char position, and a
   * stack resolves its position against the whole concatenated row. The segment
   * table built for {@link resolve} already concatenates those same bytes, so
   * the only extra work is the newline index it keeps.
   */
  resolvePosition(url: string, line: number, column: number): string | undefined {
    const direct = this.#directOwner(url)
    if (direct !== DIRECT_BATCH) return direct
    const parsed = parsePluginUrl(url)
    if (parsed.kind !== 'batch') return undefined
    const id = segmentOwnerOfPosition(this.#tableFor(url, parsed.ids), line, column)
    return id === undefined ? undefined : this.#ownerKeyOf(id)
  }

  /**
   * Single and chunk rows name their owner in the URL, so they resolve without
   * reading any file; a batch row needs the table, signalled by DIRECT_BATCH.
   */
  #directOwner(url: string): string | undefined | typeof DIRECT_BATCH {
    const parsed = parsePluginUrl(url)
    if (parsed.kind === 'other') return undefined
    if (parsed.kind === 'single' || parsed.kind === 'chunk') return this.#ownerKeyOf(parsed.id)
    return DIRECT_BATCH
  }

  #tableFor(url: string, ids: readonly string[]): SegmentTable {
    const cached = this.#tables.get(url)
    if (cached !== undefined) return cached
    const table = buildSegmentTable(ids, this.#clientSourceOf)
    this.#tables.set(url, table)
    if (this.#tables.size > this.#maxTables) {
      const oldest = this.#tables.keys().next().value
      if (oldest !== undefined) this.#tables.delete(oldest)
    }
    return table
  }

  /** Test/diagnostic handle: how many batch tables are cached. */
  get cachedTables(): number {
    return this.#tables.size
  }
}

/**
 * Sentinel returned by the resolver's direct-owner path: the URL names a batch,
 * so its owner requires the segment table.
 */
const DIRECT_BATCH = Symbol('batch')

/** Owner key for script entries the client cap folded away without a URL. */
export const OTHER_OWNER = 'other'
/** Owner key for entries whose owner could not be resolved. */
export const UNRESOLVED_OWNER = 'unresolved'
/** Owner key this plugin's own frames resolve to (ownerKeyOfModule's self rule). */
const SELF_OWNER = 'self'

/**
 * Fold one window's LoAF report into per-owner rows. Inexact by construction:
 * the coverage ratio counts every script millisecond, including cap-folded
 * ones, so an honest share always accompanies the rows.
 */
export function resolveJankView(
  loaf: LoafReport,
  ownerOf: (url: string, charPosition: number) => string | undefined,
): JankView {
  const rows = new Map<string, { durationMs: number; forcedLayoutMs: number; count: number }>()
  const add = (owner: string, durationMs: number, forcedLayoutMs: number, count: number): void => {
    const row = rows.get(owner) ?? { durationMs: 0, forcedLayoutMs: 0, count: 0 }
    row.durationMs += durationMs
    row.forcedLayoutMs += forcedLayoutMs
    row.count += count
    rows.set(owner, row)
  }
  let total = loaf.otherMs
  let covered = 0
  for (const script of loaf.scripts) {
    total += script.durationMs
    const owner = ownerOf(script.url, script.charPosition)
    if (owner === undefined) {
      add(UNRESOLVED_OWNER, script.durationMs, script.forcedLayoutMs, 1)
      continue
    }
    covered += script.durationMs
    add(owner, script.durationMs, script.forcedLayoutMs, 1)
  }
  if (loaf.otherCount > 0 || loaf.otherMs > 0) add(OTHER_OWNER, loaf.otherMs, 0, loaf.otherCount)
  const sorted: JankRow[] = [...rows.entries()]
    .map(([owner, row]) => ({ owner, ...row }))
    .sort((a, b) => b.durationMs - a.durationMs)
  return { rows: sorted, attributedShare: total === 0 ? 1 : covered / total }
}

/** One owner's running totals while a ScheduleReport folds. */
interface ScheduleBucket {
  scheduledMs: number
  calls: number
  maxMs: number
}

/**
 * Fold one window's scheduler report into per-owner rows (the registrar view).
 *
 * Every registration site charges its callbacks' total main-thread time to the
 * plugin whose bundle contains that position, plus its call count and longest
 * single callback. Inexact by construction — a nested wrapped callback is
 * charged at every level, an unreadable segment resolves to no owner, and time
 * inside a callback that belongs to another bundle is not separated — so
 * `attributedShare` always accompanies the rows.
 *
 * `contract` compares the report's own self-test position against its resolved
 * owner: the probe registered one callback from perf-lens's bundle, so anything
 * other than `self` (or an unresolved position) means the concatenation rule
 * the table assumes has changed, and the panel must show no rows.
 */
export function resolveScheduleView(
  report: ScheduleReport,
  ownerOf: (url: string, line: number, column: number) => string | undefined,
): ScheduleView {
  const rows = new Map<string, ScheduleBucket>()
  const bucketOf = (owner: string): ScheduleBucket => {
    const existing = rows.get(owner)
    if (existing !== undefined) return existing
    const created: ScheduleBucket = { scheduledMs: 0, calls: 0, maxMs: 0 }
    rows.set(owner, created)
    return created
  }

  let total = 0
  let covered = 0
  for (const site of report.sites) {
    total += site.selfMs
    const owner = ownerOf(site.url, site.line, site.column)
    if (owner !== undefined) covered += site.selfMs
    const row = bucketOf(owner ?? UNRESOLVED_OWNER)
    row.scheduledMs += site.selfMs
    row.calls += site.calls
    row.maxMs = Math.max(row.maxMs, site.maxMs)
  }

  let contract: ScheduleView['contract'] = 'untested'
  const selfTest: RawSourcePosition | undefined = report.selfTest
  if (selfTest !== undefined) {
    const owner = ownerOf(selfTest.url, selfTest.line, selfTest.column)
    contract = owner === SELF_OWNER ? 'ok' : 'mismatch'
  }

  const sorted: ScheduleRow[] = [...rows.entries()]
    .map(([owner, row]) => ({ owner, ...row }))
    .sort((a, b) => b.scheduledMs - a.scheduledMs || b.maxMs - a.maxMs)
  return { rows: sorted, attributedShare: total === 0 ? 1 : covered / total, contract }
}
