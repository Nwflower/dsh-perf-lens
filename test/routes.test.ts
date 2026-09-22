// The /api-perf surface: JSON bodies, query parsing, and disposer semantics.

import { describe, expect, test, vi } from 'vitest'
import { historyQueryOf, readJsonBody, registerPerfRoutes, statsRangeOf, type RouteRegistrar } from '../src/host/routes'
import type { PerfSnapshot, PerfStats } from '../src/shared/contract'

const SNAPSHOT: PerfSnapshot = {
  windowStartedAt: 1, mode: 'duty',
  global: { rss: 1, heapUsed: 2, heapTotal: 3, external: 4, arrayBuffers: 5, eventLoopLagP99Ms: 6, gcPauseMs: 7, fsOpsTotal: 8, sampleWindowMs: 5000, sampleCount: 9, idleSamples: 0 },
  plugins: [], unattributedShare: 0, selfShare: 0,
}

type Handler = (req: unknown, res: unknown) => unknown

function fakeRes() {
  const captured = { status: 0, body: '' }
  const res = {
    writeHead(status: number) { captured.status = status },
    end(body: string) { captured.body = String(body) },
  }
  return { res, captured }
}

function fakeReq(url: string, body?: string) {
  return {
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

function harness() {
  const handlers = new Map<string, Handler>()
  const ws: RouteRegistrar = {
    register(route) {
      handlers.set(route.path, route.handler as unknown as Handler)
      return () => { handlers.delete(route.path) }
    },
  }
  const service = {
    snapshot: vi.fn(() => SNAPSHOT),
    control: vi.fn(() => SNAPSHOT),
    history: vi.fn(() => [SNAPSHOT]),
    stats: vi.fn((): PerfStats => ({
      range: '24h', since: 0, windowCount: 0, sampledWindowMs: 0, coverage: 0, plugins: [],
    })),
    diagnostics: vi.fn(() => ({
      lastError: null, windowStartedAt: 1, sampleCount: 9,
      ownerKeys: ['plugin:a'], ownerRules: [{ kind: 'plugin', name: 'a', prefix: '/a/' }],
    })),
  }
  const dispose = registerPerfRoutes(ws, service)
  return { handlers, service, dispose }
}

describe('registerPerfRoutes', () => {
  test('registers the routes and unregisters on dispose', () => {
    const h = harness()
    expect([...h.handlers.keys()].sort()).toEqual([
      '/api-perf/control',
      '/api-perf/diagnostics',
      '/api-perf/history',
      '/api-perf/snapshot',
      '/api-perf/stats',
    ])
    h.dispose()
    expect(h.handlers.size).toBe(0)
  })

  test('snapshot responds with the current snapshot', () => {
    const h = harness()
    const { res, captured } = fakeRes()
    h.handlers.get('/api-perf/snapshot')?.(fakeReq('/api-perf/snapshot'), res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toMatchObject({ windowStartedAt: 1 })
  })

  test('control parses the body and forwards it', async () => {
    const h = harness()
    const { res } = fakeRes()
    await h.handlers.get('/api-perf/control')?.(fakeReq('/api-perf/control', '{"action":"pause"}'), res)
    expect(h.service.control).toHaveBeenCalledWith({ action: 'pause' })
  })

  test('control answers 400 on a malformed body', async () => {
    const h = harness()
    const { res, captured } = fakeRes()
    await h.handlers.get('/api-perf/control')?.(fakeReq('/api-perf/control', '{oops'), res)
    expect(captured.status).toBe(400)
  })

  test('diagnostics responds with attribution facts', () => {
    const h = harness()
    const { res, captured } = fakeRes()
    h.handlers.get('/api-perf/diagnostics')?.(fakeReq('/api-perf/diagnostics'), res)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body).ownerKeys).toEqual(['plugin:a'])
  })

  test('history forwards plugin and since from the query', () => {
    const h = harness()
    const { res } = fakeRes()
    h.handlers.get('/api-perf/history')?.(fakeReq('/api-perf/history?plugin=dsh-context&since=100'), res)
    expect(h.service.history).toHaveBeenCalledWith({ plugin: 'dsh-context', since: 100 })
  })

  test('stats forwards the range query, defaulting to 24h', () => {
    const h = harness()
    const { res, captured } = fakeRes()
    h.handlers.get('/api-perf/stats')?.(fakeReq('/api-perf/stats?range=7d'), res)
    expect(h.service.stats).toHaveBeenCalledWith('7d')
    expect(captured.status).toBe(200)
    h.handlers.get('/api-perf/stats')?.(fakeReq('/api-perf/stats'), fakeRes().res)
    expect(h.service.stats).toHaveBeenLastCalledWith('24h')
  })
})

describe('request parsing helpers', () => {
  test('an empty body is an empty object', async () => {
    expect(await readJsonBody(fakeReq('/x') as never)).toEqual({})
  })

  test('a non-numeric since is ignored', () => {
    expect(historyQueryOf(fakeReq('/api-perf/history?since=abc') as never)).toEqual({})
  })

  test('stats range defaults to 24h', () => {
    expect(statsRangeOf(fakeReq('/api-perf/stats') as never)).toBe('24h')
    expect(statsRangeOf(fakeReq('/api-perf/stats?range=1h') as never)).toBe('1h')
  })
})
