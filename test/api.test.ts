// The browser API client: URL shape and body forwarding.

import { describe, expect, test, vi } from 'vitest'
import { createPerfApi } from '../src/client/api'
import type { PerfSnapshot } from '../src/shared/contract'

const SNAPSHOT: PerfSnapshot = {
  windowStartedAt: 1, mode: 'duty',
  global: { rss: 1, heapUsed: 2, heapTotal: 3, external: 4, arrayBuffers: 5, eventLoopLagP99Ms: 6, gcPauseMs: 7, fsOpsTotal: 8, sampleWindowMs: 5000, sampleCount: 9, idleSamples: 0 },
  plugins: [], unattributedShare: 0, selfShare: 0,
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response
}

describe('createPerfApi', () => {
  test('reads the snapshot endpoint', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SNAPSHOT))
    const api = createPerfApi(fetchImpl as unknown as typeof fetch)
    expect(await api.snapshot()).toEqual(SNAPSHOT)
    expect(fetchImpl).toHaveBeenCalledWith('/api-perf/snapshot')
  })

  test('posts control bodies as JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SNAPSHOT))
    const api = createPerfApi(fetchImpl as unknown as typeof fetch)
    await api.control({ action: 'pause', deep: true })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api-perf/control')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ action: 'pause', deep: true })
  })

  test('encodes the history query', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ snapshots: [SNAPSHOT] }))
    const api = createPerfApi(fetchImpl as unknown as typeof fetch)
    expect(await api.history({ plugin: 'dsh-context', since: 100 })).toEqual([SNAPSHOT])
    expect(fetchImpl).toHaveBeenCalledWith('/api-perf/history?plugin=dsh-context&since=100')
  })

  test('reads the stats endpoint with the range', async () => {
    const stats = { range: '7d', since: 0, windowCount: 0, sampledWindowMs: 0, coverage: 0, plugins: [] }
    const fetchImpl = vi.fn(async () => jsonResponse(stats))
    const api = createPerfApi(fetchImpl as unknown as typeof fetch)
    expect(await api.stats('7d')).toEqual(stats)
    expect(fetchImpl).toHaveBeenCalledWith('/api-perf/stats?range=7d')
  })

  test('throws on a failed response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' }) as Response)
    const api = createPerfApi(fetchImpl as unknown as typeof fetch)
    await expect(api.snapshot()).rejects.toThrow('500')
  })
})
