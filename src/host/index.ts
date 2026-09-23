// dsh-perf-lens host half: the composition root.
//
// Every collaborator is built here and tied to the plugin's lifetime through
// cordis effects, so unloading always stops sampling (AGENTS.md hard
// constraint 6). The webServer service is optional and mounted late: routes are
// registered through ctx.inject rather than listed in `inject`, or a headless
// profile would fail to activate the whole plugin.

import { Session } from 'node:inspector'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PerfControlRequest } from '../shared/contract'
import { DEFAULTS } from '../shared/defaults'
import { AsyncWindowRecorder } from './async-attribution'
import type { HostCtx, HostWebCtx } from './ctx'
import { HistoryStore } from './history'
import { HotspotStore } from './hotspots'
import { IoTracker } from './io-tracker'
import { DEFAULT_LENS_OPTIONS, Lens, type PluginFacts } from './lens'
import { GlobalMetrics } from './metrics'
import { buildOwnerIndex, harnessNodeModulesPrefix, type LoaderEntryFacts } from './plugin-index'
import { registerPerfRoutes } from './routes'
import { Sampler } from './sampler'
import { aggregateStats, aggregateTrend, rangeToSince } from './stats'
import { VitalsStore } from './vitals'

export const name = 'perf-lens'

// The loader is the only hard dependency. webServer stays out of this list.
export const inject = ['loader']

/** History directory under the harness home. */
export function historyDirOf(env: Record<string, string | undefined> = process.env): string {
  return join(env.DSH_HOME ?? join(homedir(), '.dsh'), 'perf-lens')
}

/**
 * Resolve a plugin's own module directory from the loader's resolution anchor.
 *
 * The loader's `baseUrl` is the include root it anchors at the profile
 * directory (see dsh/lib/types/profile-boot.d.ts), NOT the plugin's own path, so
 * it cannot be used as an owner prefix directly. The module name must be
 * resolved against it.
 *
 * `import.meta.resolve` cannot do this: Node ignores its second `parent`
 * argument and always resolves against the importing module, so it would only
 * ever find packages that happen to sit next to this plugin. `createRequire`
 * honours the anchor, which is what the loader itself resolves through.
 *
 * Returns '' when the name cannot be resolved, which makes the entry
 * unattributable instead of matching every frame.
 */
export function resolveEntryDir(moduleName: string, base: string | undefined): string {
  if (base === undefined || base === '') return ''
  try {
    // The loader anchors baseUrl as a DIRECTORY FILE URL
    // (`ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'`), so it must be
    // converted to a real path before anchoring require resolution. Joining a
    // file URL with a filename yields an invalid path that makes createRequire
    // throw, which is what emptied the plugin list.
    const dir = base.startsWith('file:')
      ? fileURLToPath(base.endsWith('/') ? base : `${base}/`)
      : base
    const require = createRequire(join(dir, 'package.json'))
    try {
      return dirname(require.resolve(moduleName))
    } catch {
      // ESM-only packages may not expose a require condition; their package.json
      // still names the directory the loader resolved.
      try {
        return dirname(require.resolve(`${moduleName}/package.json`))
      } catch {
        return ''
      }
    }
  } catch {
    // An unusable anchor must degrade to "unattributable", never throw: one bad
    // entry would otherwise abort the whole loader scan and empty the panel.
    return ''
  }
}

/** Convert loader entries to the facts attribution needs. */
function loaderFacts(ctx: HostCtx): LoaderEntryFacts[] {
  const facts: LoaderEntryFacts[] = []
  for (const entry of ctx.loader.entries()) {
    try {
      const base = entry.parent.tree.ctx.baseUrl
      facts.push({
        moduleName: entry.options.name,
        entryId: entry.id,
        baseUrl: resolveEntryDir(entry.options.name, base),
      })
    } catch {
      // A single unreadable entry must not empty the whole list.
    }
  }
  return facts
}

export function apply(rawCtx: Context): void {
  const ctx = rawCtx as unknown as HostCtx
  const session = new Session()
  session.connect()
  const sampler = new Sampler(session, {
    cpuIntervalUs: DEFAULTS.cpuIntervalUs,
    heapIntervalBytes: 32 * 1024,
  })
  const io = new IoTracker()
  // Deep-mode only: async-context CPU re-attribution (mechanism C).
  const asyncAttribution = new AsyncWindowRecorder()
  const metrics = new GlobalMetrics()
  // Frame-level, in-memory only: this table has no persistence path by design.
  const hotspots = new HotspotStore()
  // Browser vitals: short-lived, in-memory only, and never persisted either.
  const vitals = new VitalsStore(DEFAULTS.vitalsRetain)
  const history = new HistoryStore({
    dir: historyDirOf(),
    retentionDays: 14,
    maxBytes: 200 * 1024 * 1024,
  })
  // Resolving every plugin's directory is synchronous filesystem work. Cache it
  // and refresh slowly: resolving hundreds of packages on every window (and
  // twice per window) would block the host event loop.
  let cachedFacts: LoaderEntryFacts[] | undefined
  let cachedAt = 0
  const factsOf = (): LoaderEntryFacts[] => {
    const now = Date.now()
    if (cachedFacts === undefined || now - cachedAt >= 30_000) {
      cachedFacts = loaderFacts(ctx)
      cachedAt = now
    }
    return cachedFacts
  }
  const harnessPrefix = harnessNodeModulesPrefix(process.argv[1])
  const plugins = (): PluginFacts[] =>
    factsOf().map(facts => ({
      moduleName: facts.moduleName,
      entryId: facts.entryId,
      fiberPhase: 'active',
    }))
  const lens = new Lens(
    {
      sampler,
      io,
      metrics,
      history,
      hotspots,
      asyncAttribution,
      plugins,
      ownerIndex: () => buildOwnerIndex(factsOf(), { harnessPrefix }),
    },
    DEFAULT_LENS_OPTIONS,
  )
  lens.start()

  // Retention sweep, unref'd so it never holds the process open.
  const pruneTimer = setInterval(() => { history.prune() }, 6 * 60 * 60 * 1000)
  pruneTimer.unref()
  ctx.effect(() => () => { clearInterval(pruneTimer) })

  ctx.inject(['webServer'], (webCtx) => {
    const ws = (webCtx as unknown as HostWebCtx).webServer
    const dispose = registerPerfRoutes(ws, {
      snapshot: () => lens.snapshot(),
      control: (body: PerfControlRequest) => {
        if (body.action === 'pause') lens.setMode('paused')
        if (body.action === 'resume') lens.setMode('duty')
        if (body.mode !== undefined) lens.setMode(body.mode)
        if (body.deep !== undefined) lens.setDeep(body.deep)
        return lens.snapshot()
      },
      history: (query) => history.read(query.since),
      stats: (range) => {
        const now = Date.now()
        const resolved = rangeToSince(range, now)
        return aggregateStats(history.summaries(resolved.since), resolved.range, resolved.since, now)
      },
      trend: (range) => {
        const now = Date.now()
        const resolved = rangeToSince(range, now)
        return aggregateTrend(history.summaries(resolved.since), resolved.range, resolved.since, DEFAULTS.trendMaxPoints)
      },
      hotspots: (plugin) => hotspots.get(plugin),
      vitals: () => vitals.view(),
      recordVitals: (report) => vitals.record(report),
      diagnostics: () => lens.diagnostics(),
    })
    ctx.effect(() => dispose)
  })

  // Unconditional stop: the disposer runs whatever tears the plugin down.
  // The inspector session is disconnected too, so a reload leaves no connected
  // session behind.
  ctx.effect(() => () => {
    void lens.dispose().finally(() => { session.disconnect() })
  })
}
