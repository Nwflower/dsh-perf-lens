// Foreground vitals received from the browser panel: a small ring of reports
// used to show "the UI is stuttering" next to host CPU. Reports carrying Long
// Animation Frame script data are resolved to per-owner jank rows at record
// time, so the ring never holds anything the view cannot show resolved.

import type {
  ClientVitals,
  JankView,
  LoafReport,
  RawLoafScript,
  RawScheduleSite,
  RawSourcePosition,
  ScheduleReport,
  ScheduleView,
  VitalsView,
} from '../shared/contract'

/** Resolve one report's loaf field to its jank view; null when it carried none. */
export type JankResolve = (report: ClientVitals) => JankView | null

/** Resolve one report's schedule field to its schedule view; null when absent. */
export type ScheduleResolve = (report: ClientVitals) => ScheduleView | null

/** Every per-report resolution the ring applies before storing. */
export interface VitalsResolvers {
  readonly jank?: JankResolve
  /**
   * Built from the same resolver the jank path uses, so both views speak the
   * owner vocabulary the board does. Defaults to the shared folding function
   * when the caller supplies only the two position resolvers.
   */
  readonly schedule?: ScheduleResolve
}

interface StoredVitals {
  readonly report: ClientVitals
  readonly jank: JankView | null
  readonly schedule: ScheduleView | null
}

/** Fixed-capacity newest-first ring of client vitals reports. */
export class VitalsStore {
  readonly #capacity: number
  readonly #resolvers: VitalsResolvers
  #items: StoredVitals[] = []

  constructor(capacity: number, resolvers: VitalsResolvers = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer')
    this.#capacity = capacity
    this.#resolvers = resolvers
  }

  record(report: ClientVitals): VitalsView {
    const jank = this.#resolvers.jank?.(report) ?? null
    const schedule = this.#resolvers.schedule?.(report) ?? null
    this.#items.push({ report, jank, schedule })
    if (this.#items.length > this.#capacity) this.#items.splice(0, this.#items.length - this.#capacity)
    return this.view()
  }

  view(): VitalsView {
    const recent = [...this.#items].reverse()
    return {
      latest: recent[0]?.report ?? null,
      recent: recent.map(item => item.report),
      jank: recent[0]?.jank ?? null,
      schedule: recent[0]?.schedule ?? null,
    }
  }
}

/** Narrow one untrusted loaf field, or null; undefined when the field is absent. */
function parseLoaf(value: unknown): LoafReport | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.supported !== 'boolean') return null
  if (typeof record.otherCount !== 'number' || !Number.isFinite(record.otherCount)) return null
  if (typeof record.otherMs !== 'number' || !Number.isFinite(record.otherMs)) return null
  if (!Array.isArray(record.scripts)) return null
  const scripts: RawLoafScript[] = []
  for (const item of record.scripts) {
    if (typeof item !== 'object' || item === null) return null
    const script = item as Record<string, unknown>
    if (typeof script.url !== 'string') return null
    if (typeof script.charPosition !== 'number' || !Number.isFinite(script.charPosition)) return null
    if (typeof script.functionName !== 'string') return null
    if (typeof script.invokerType !== 'string') return null
    if (typeof script.durationMs !== 'number' || !Number.isFinite(script.durationMs)) return null
    if (typeof script.forcedLayoutMs !== 'number' || !Number.isFinite(script.forcedLayoutMs)) return null
    scripts.push({
      url: script.url,
      charPosition: script.charPosition,
      functionName: script.functionName,
      invokerType: script.invokerType,
      durationMs: script.durationMs,
      forcedLayoutMs: script.forcedLayoutMs,
    })
  }
  return {
    supported: record.supported,
    scripts,
    otherCount: record.otherCount,
    otherMs: record.otherMs,
  }
}

/** Narrow one untrusted source position, or null. */
function parsePosition(value: unknown): RawSourcePosition | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.url !== 'string') return null
  if (typeof record.line !== 'number' || !Number.isFinite(record.line)) return null
  if (typeof record.column !== 'number' || !Number.isFinite(record.column)) return null
  return { url: record.url, line: record.line, column: record.column }
}

/** Narrow one untrusted registration site, or null. */
function parseScheduleSite(value: unknown): RawScheduleSite | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const position = parsePosition(record)
  if (position === null) return null
  for (const key of ['calls', 'selfMs', 'maxMs'] as const) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) return null
  }
  return {
    ...position,
    calls: record.calls as number,
    selfMs: record.selfMs as number,
    maxMs: record.maxMs as number,
  }
}

/** Narrow one untrusted schedule field, or null; undefined when the field is absent. */
function parseSchedule(value: unknown): ScheduleReport | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.active !== 'boolean') return null
  if (typeof record.windowMs !== 'number' || !Number.isFinite(record.windowMs)) return null
  if (!Array.isArray(record.sites)) return null
  const sites: RawScheduleSite[] = []
  for (const item of record.sites) {
    const site = parseScheduleSite(item)
    if (site === null) return null
    sites.push(site)
  }
  let selfTest: RawSourcePosition | undefined
  if (record.selfTest !== undefined) {
    const position = parsePosition(record.selfTest)
    if (position === null) return null
    selfTest = position
  }
  return {
    active: record.active,
    sites,
    ...(selfTest === undefined ? {} : { selfTest }),
    windowMs: record.windowMs,
  }
}

/** Narrow an untrusted POST body to a ClientVitals, or null. */
export function parseVitals(body: Record<string, unknown>): ClientVitals | null {
  const numbers = ['longTaskCount', 'longTaskTotalMs', 'rafGapP95Ms', 'windowMs', 'at'] as const
  for (const key of numbers) {
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) return null
  }
  const loaf = parseLoaf(body.loaf)
  if (loaf === null) return null
  const schedule = parseSchedule(body.schedule)
  if (schedule === null) return null
  return {
    longTaskCount: body.longTaskCount as number,
    longTaskTotalMs: body.longTaskTotalMs as number,
    rafGapP95Ms: body.rafGapP95Ms as number,
    windowMs: body.windowMs as number,
    at: body.at as number,
    ...(loaf === undefined ? {} : { loaf }),
    ...(schedule === undefined ? {} : { schedule }),
  }
}
