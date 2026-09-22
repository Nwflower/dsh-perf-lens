// Foreground vitals received from the browser panel: a small ring of reports
// used to show "the UI is stuttering" next to host CPU. The host does not
// interpret them beyond retention; correlation is computed where the current
// plugin snapshot is also available.

import type { ClientVitals, VitalsView } from '../shared/contract'

/** Fixed-capacity newest-first ring of client vitals reports. */
export class VitalsStore {
  readonly #capacity: number
  #items: ClientVitals[] = []

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer')
    this.#capacity = capacity
  }

  record(report: ClientVitals): VitalsView {
    this.#items.push(report)
    if (this.#items.length > this.#capacity) this.#items.splice(0, this.#items.length - this.#capacity)
    return this.view()
  }

  view(): VitalsView {
    const recent = [...this.#items].reverse()
    return { latest: recent[0] ?? null, recent }
  }
}

/** Narrow an untrusted POST body to a ClientVitals, or null. */
export function parseVitals(body: Record<string, unknown>): ClientVitals | null {
  const numbers = ['longTaskCount', 'longTaskTotalMs', 'rafGapP95Ms', 'windowMs', 'at'] as const
  for (const key of numbers) {
    if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) return null
  }
  return {
    longTaskCount: body.longTaskCount as number,
    longTaskTotalMs: body.longTaskTotalMs as number,
    rafGapP95Ms: body.rafGapP95Ms as number,
    windowMs: body.windowMs as number,
    at: body.at as number,
  }
}
