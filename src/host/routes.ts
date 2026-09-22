// HTTP surface of the lens, registered on the optional webServer service.
//
// Handler shape mirrors dsh-chat-import's panel routes: Node's own
// (req, res) with res.writeHead/res.end. Registration returns a disposer, so the
// caller ties route lifetime to the plugin via a cordis effect.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PerfControlRequest, PerfDiagnostics, PerfHistoryQuery, PerfSnapshot, PerfStats } from '../shared/contract'
import type { Hotspot } from '../shared/contract'

/** The route registrar the harness webServer service exposes. */
export interface RouteRegistrar {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** What the routes read from and command. */
export interface PerfService {
  snapshot(): PerfSnapshot
  control(body: PerfControlRequest): PerfSnapshot
  history(query: PerfHistoryQuery): readonly PerfSnapshot[]
  /** Range aggregation over recorded windows; range is 1h | 24h | 7d. */
  stats(range: string): PerfStats
  /**
   * Hot functions for one plugin. In-memory only and available only after a
   * deep-mode window; null when nothing was collected.
   */
  hotspots(plugin: string): readonly Hotspot[] | null
  diagnostics(): PerfDiagnostics
}

/** Extract the plugin query from the request URL. */
export function hotspotsQueryOf(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://localhost')
  return url.searchParams.get('plugin') ?? ''
}

/** Extract the range query from the request URL. */
export function statsRangeOf(req: IncomingMessage): string {
  const url = new URL(req.url ?? '/', 'http://localhost')
  return url.searchParams.get('range') ?? '24h'
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Read and parse a JSON request body; an empty body is an empty object. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const value: unknown = JSON.parse(text)
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** Extract the history query from the request URL. */
export function historyQueryOf(req: IncomingMessage): PerfHistoryQuery {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const plugin = url.searchParams.get('plugin')
  const sinceRaw = url.searchParams.get('since')
  const since = sinceRaw === null ? undefined : Number(sinceRaw)
  return {
    ...(plugin === null ? {} : { plugin }),
    ...(since !== undefined && Number.isFinite(since) ? { since } : {}),
  }
}

/**
 * Register the /api-perf/* routes. Returns a disposer that unregisters them all.
 */
export function registerPerfRoutes(ws: RouteRegistrar, service: PerfService): () => void {
  const disposers = [
    ws.register({
      kind: 'exact',
      path: '/api-perf/snapshot',
      handler: (_req, res) => { respond(res, 200, service.snapshot()) },
    }),
    ws.register({
      kind: 'exact',
      path: '/api-perf/control',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          respond(res, 200, service.control(body as PerfControlRequest))
        } catch (error) {
          respond(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    ws.register({
      kind: 'exact',
      path: '/api-perf/diagnostics',
      handler: (_req, res) => {
        try {
          respond(res, 200, service.diagnostics())
        } catch (error) {
          respond(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    ws.register({
      kind: 'exact',
      path: '/api-perf/history',
      handler: (req, res) => {
        try {
          respond(res, 200, { snapshots: service.history(historyQueryOf(req)) })
        } catch (error) {
          respond(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    ws.register({
      kind: 'exact',
      path: '/api-perf/stats',
      handler: (req, res) => {
        try {
          respond(res, 200, service.stats(statsRangeOf(req)))
        } catch (error) {
          respond(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    ws.register({
      kind: 'exact',
      path: '/api-perf/hotspots',
      handler: (req, res) => {
        try {
          const plugin = hotspotsQueryOf(req)
          respond(res, 200, { plugin, hotspots: service.hotspots(plugin) })
        } catch (error) {
          respond(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}
