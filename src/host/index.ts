// dsh-perf-lens host half: the composition root.
//
// Every collaborator is built here and tied to the plugin's lifetime through
// cordis effects, so unloading always stops sampling (AGENTS.md hard
// constraint 6). The webServer service is optional and mounted late: routes are
// registered through ctx.inject rather than listed in `inject`, or a headless
// profile would fail to activate the whole plugin.

import { readFileSync } from 'node:fs'
import { Session } from 'node:inspector'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PerfControlRequest } from '../shared/contract'
import { DEFAULTS } from '../shared/defaults'
import { applyControl } from '../shared/sampling'
import { AsyncWindowRecorder } from './async-attribution'
import type { HostCtx, HostWebCtx } from './ctx'
import { DiskFootprintScanner, NODE_FOOTPRINT_FS } from './disk-footprint'
import { HistoryStore } from './history'
import { HotspotStore } from './hotspots'
import { IoTracker } from './io-tracker'
import { DEFAULT_LENS_OPTIONS, Lens, type PluginFacts } from './lens'
import { countListeners } from './listeners'
import { createClientSourceReader, LoafResolver, resolveJankView, resolveScheduleView } from './loaf-map'
import { GlobalMetrics } from './metrics'
import {
  buildOwnerIndex,
  directoryPrefixOf,
  fiberOwnerKeys,
  harnessNodeModulesPrefix,
  type LoaderEntryFacts,
} from './plugin-index'
import { ProcessTreeSampler, defaultListProcesses } from './process-tree'
import { registerPerfRoutes } from './routes'
import { Sampler } from './sampler'
import { aggregateStats, aggregateTrend, rangeToSince } from './stats'
import { VitalsStore } from './vitals'

export const name = 'perf-lens'

// The loader is the only hard dependency. webServer stays out of this list.
export const inject = ['loader']

/** The harness home directory: profiles, plugins, sessions and this plugin's log. */
export function dshHomeOf(env: Record<string, string | undefined> = process.env): string {
  return env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** History directory under the harness home. */
export function historyDirOf(env: Record<string, string | undefined> = process.env): string {
  return join(dshHomeOf(env), 'perf-lens')
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
        // The fiber is what attributes facts that carry no path (registered
        // event listeners) to the same owner key the path index produces.
        fiber: entry.fiber,
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
  // LoAF script entries resolve to owner keys at record time; the resolver
  // reads plugin client bundles lazily through the same loader facts the owner
  // index uses, so the ring only ever holds resolved rows.
  const loafFs = {
    readFile: (path: string): string | undefined => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
  }
  const loafResolver = new LoafResolver({
    clientSourceOf: createClientSourceReader(
      () => new Map(factsOf().map(facts => [facts.moduleName, directoryPrefixOf(facts.baseUrl)])),
      loafFs,
    ),
  })
  // Two resolutions, one vocabulary: LoAF script positions and scheduler
  // line/columns both resolve through the same segment tables, so a plugin name
  // means the same thing in the jank table and in the scheduler table.
  const vitals = new VitalsStore(DEFAULTS.vitalsRetain, {
    jank: report => report.loaf === undefined
      ? null
      : resolveJankView(report.loaf, (url, charPosition) => loafResolver.resolve(url, charPosition)),
    schedule: report => report.schedule === undefined
      ? null
      : resolveScheduleView(report.schedule, (url, line, column) => loafResolver.resolvePosition(url, line, column)),
  })
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
  // Roadmap item 1a: the descendant process tree. Its own low-rate timer, because
  // a process-table read costs a spawn and must never sit on the window path.
  const processTree = new ProcessTreeSampler({
    listProcesses: defaultListProcesses,
    now: () => Date.now(),
    rootPid: process.pid,
  })
  // Roadmap item 4: exact per-plugin on-disk bytes, on its own slow timer.
  const footprint = new DiskFootprintScanner({
    fs: NODE_FOOTPRINT_FS,
    now: () => Date.now(),
    ownerIndex: () => buildOwnerIndex(factsOf(), { harnessPrefix }),
  })
  /**
   * Registered event listeners per owner key (roadmap item 3).
   *
   * Read from the cordis event service's registry, where each stored hook keeps
   * the context that registered it. `ctx.events` is the service; a host that
   * does not expose it, or a cordis that renamed the field, yields null and the
   * panel shows a gap rather than a false zero.
   */
  const listenerCounts = (): ReadonlyMap<string, number> | null => {
    const registry = (ctx as unknown as { events?: unknown }).events
    const owners = fiberOwnerKeys(factsOf())
    return countListeners(registry as never, fiber => {
      const key = owners.get(fiber)
      return key === undefined ? null : key
    })
  }
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
      listenerCounts,
      diskFootprint: () => footprint.perOwner,
      diskFootprintReading: () => footprint.reading,
      processTree: () => processTree.reading,
    },
    DEFAULT_LENS_OPTIONS,
  )
  lens.start()
  processTree.start()
  // The harness home covers everything a plugin installs into its profile; the
  // plugins' own resolved directories cover the ones installed with `link:` or
  // any other symlink, which live outside the home and which the walk (never
  // following symlinks) would otherwise report as zero bytes.
  footprint.start(() => [dshHomeOf(), ...factsOf().map(facts => facts.baseUrl).filter(base => base !== '')])

  // Retention sweep, unref'd so it never holds the process open.
  const pruneTimer = setInterval(() => { history.prune() }, 6 * 60 * 60 * 1000)
  pruneTimer.unref()
  ctx.effect(() => () => { clearInterval(pruneTimer) })

  ctx.inject(['webServer'], (webCtx) => {
    const ws = (webCtx as unknown as HostWebCtx).webServer
    const dispose = registerPerfRoutes(ws, {
      snapshot: () => {
        // Someone is looking at the panel: refresh the tree if the last poll is
        // stale, so the answer to "why is the machine busy" is current rather
        // than up to a full cadence old. The poll is async and refuses to
        // overlap itself, so a burst of polls costs one process-table read.
        const reading = processTree.reading
        if (reading === null || Date.now() - reading.at >= 5_000) void processTree.poll()
        return lens.snapshot()
      },
      control: (body: PerfControlRequest) => {
        // One request may change one block or all three; shared/sampling.ts owns
        // how they combine, so the route never has to know.
        lens.setSampling(applyControl(lens.sampling, body))
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
    // Every timer this plugin owns stops here: sampling, the process-tree poll
    // and the footprint scan (AGENTS.md hard constraint 6).
    processTree.stop()
    footprint.stop()
    void lens.dispose().finally(() => { session.disconnect() })
  })
}
