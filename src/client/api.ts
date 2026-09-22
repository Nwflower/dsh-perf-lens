// Browser side of the /api-perf contract. All response types come from
// src/shared/contract.ts, the same module the host collector writes.

import type { PerfControlRequest, PerfHistoryQuery, PerfSnapshot } from '../shared/contract'

export interface PerfApi {
  snapshot(): Promise<PerfSnapshot>
  control(body: PerfControlRequest): Promise<PerfSnapshot>
  history(query?: PerfHistoryQuery): Promise<readonly PerfSnapshot[]>
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return await response.json() as T
}

/** Build the API client. `fetchImpl` is injectable so the panel is testable. */
export function createPerfApi(fetchImpl: typeof fetch = fetch): PerfApi {
  return {
    async snapshot() {
      return await readJson<PerfSnapshot>(await fetchImpl('/api-perf/snapshot'))
    },
    async control(body) {
      return await readJson<PerfSnapshot>(await fetchImpl('/api-perf/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
    },
    async history(query = {}) {
      const params = new URLSearchParams()
      if (query.plugin !== undefined) params.set('plugin', query.plugin)
      if (query.since !== undefined) params.set('since', String(query.since))
      const suffix = params.size === 0 ? '' : `?${params.toString()}`
      const payload = await readJson<{ snapshots: PerfSnapshot[] }>(await fetchImpl(`/api-perf/history${suffix}`))
      return payload.snapshots
    },
  }
}
