// Main-column task-manager board. Polls the host snapshot at the cadence of the
// active sampling window (continuous mode polls faster), keeps a short local
// CPU series for the sparklines, and forwards control toggles to the host.
//
// The trend and scoreboard read the compact trend/stats endpoints, which are
// heavier (JSONL aggregation), so they refresh on their own slower cadence and
// on an explicit range change instead of every snapshot poll — and a slow tick
// only fetches when the host has recorded a window since the last fetch.
//
// Layout: a vertically scrolling card stack on .pl-root (the shell's main
// panel hands the occupant a full-height column; height:100% + overflow-y:auto
// is the built-in panels' own idiom). Order is deliberate: process-level truth
// (overview KPIs, composition bars) before the per-plugin detail, and the
// trend/scoreboard above the 200-row table that would otherwise push them
// thousands of pixels below the fold.

import { useEffect, useRef, useState } from 'react'
import type { Hotspot, JankRow, PerfRange, PerfSnapshot, PerfStats, PerfTrend, SampleMode, ScheduleRow, VitalsView } from '../shared/contract'
import { DEFAULTS } from '../shared/defaults'
import { samplingOf } from '../shared/sampling'
import { createPerfApi, type PerfApi } from './api'
import { Composition } from './composition'
import { PanelErrorBoundary } from './error-boundary'
import { ControlBar } from './control-bar'
import { GlobalBar } from './global-bar'
import { displayHarnessPackage, displayOwner, subscribeLocale, t, type MessageKey } from './i18n'
import { MetricsTable } from './metrics-table'
import { PluginCards } from './plugin-cards'
import { pageStorageOf, rememberProbeEnabled, scheduleProbe } from './schedule-probe'
import { Scoreboard } from './scoreboard'
import { hasAbsoluteSeries, TrendChart, type TrendMetric } from './trend-chart'

/** Fold harness sub-packages into one row for the jank table, like the board. */
function foldJankRows(rows: readonly JankRow[]): JankRow[] {
  const folded = new Map<string, { durationMs: number; forcedLayoutMs: number; count: number }>()
  for (const row of rows) {
    const owner = row.owner.startsWith('harness:') ? 'harness' : row.owner
    const bucket = folded.get(owner) ?? { durationMs: 0, forcedLayoutMs: 0, count: 0 }
    bucket.durationMs += row.durationMs
    bucket.forcedLayoutMs += row.forcedLayoutMs
    bucket.count += row.count
    folded.set(owner, bucket)
  }
  return [...folded.entries()]
    .map(([owner, row]) => ({ owner, ...row }))
    .sort((a, b) => b.durationMs - a.durationMs)
}

/** Human label for one jank owner key, in the board's vocabulary. */
function displayJankOwner(owner: string): string {
  if (owner === 'unresolved') return t('jankUnresolved')
  if (owner === 'other') return t('jankOther')
  if (owner.startsWith('plugin:')) return owner.slice('plugin:'.length)
  if (owner.startsWith('harness:')) return displayHarnessPackage(owner)
  return displayOwner(owner)
}

/** Fold harness sub-packages into one row for the scheduler table, like the board. */
function foldScheduleRows(rows: readonly ScheduleRow[]): ScheduleRow[] {
  const folded = new Map<string, { scheduledMs: number; calls: number; maxMs: number }>()
  for (const row of rows) {
    const owner = row.owner.startsWith('harness:') ? 'harness' : row.owner
    const bucket = folded.get(owner) ?? { scheduledMs: 0, calls: 0, maxMs: 0 }
    bucket.scheduledMs += row.scheduledMs
    bucket.calls += row.calls
    bucket.maxMs = Math.max(bucket.maxMs, row.maxMs)
    folded.set(owner, bucket)
  }
  return [...folded.entries()]
    .map(([owner, row]) => ({ owner, ...row }))
    .sort((a, b) => b.scheduledMs - a.scheduledMs)
}

/** Sparkline depth: enough to see a trend without retaining a profile. */
const SERIES_LENGTH = 30
/** Trend/scoreboard refresh cadence; JSONL aggregation is not free. */
const TREND_REFRESH_MS = 15_000
const RANGES: readonly PerfRange[] = ['1h', '24h', '7d']

/**
 * The chip beside the title reports the resolved sampling state, in the same
 * vocabulary as the intensity segment: with three independent controls, "which
 * buttons are lit" no longer answers "what is the sampler doing".
 */
const MODE_CHIP: Record<SampleMode, { readonly label: MessageKey; readonly hint: MessageKey }> = {
  continuous: { label: 'high', hint: 'highHint' },
  duty: { label: 'low', hint: 'lowHint' },
  background: { label: 'background', hint: 'backgroundHint' },
  paused: { label: 'stop', hint: 'stopHint' },
}

export interface PerfPanelProps {
  /** Injected by tests; the real panel builds the default client. */
  readonly api?: PerfApi
}

export function PerfPanel({ api }: PerfPanelProps) {
  const apiRef = useRef<PerfApi | null>(api ?? null)
  if (apiRef.current === null) apiRef.current = createPerfApi()
  const client = apiRef.current

  const [snapshot, setSnapshot] = useState<PerfSnapshot | null>(null)
  const [series, setSeries] = useState<Record<string, number[]>>({})
  const [range, setRange] = useState<PerfRange>('24h')
  const [stats, setStats] = useState<PerfStats | null>(null)
  const [trend, setTrend] = useState<PerfTrend | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [hotspots, setHotspots] = useState<Readonly<Record<string, readonly Hotspot[]>>>({})
  const [vitals, setVitals] = useState<VitalsView | null>(null)
  // The probe lives in this page, so its switch is local state; the report it
  // produces travels through the host only so the panel can render resolved rows.
  const [probeOn, setProbeOn] = useState(scheduleProbe.state.active)
  // Absolute is the default base: the share axis inflates on an idle host and
  // the chart is what people read the trend from (design-overnight-analyzer.md §6.5).
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('absolute')
  // `t()` reads the active dictionary at call time, so a language switch needs
  // only a re-render. Bumping a counter is the whole subscription.
  const [, setLocaleRevision] = useState(0)
  // The sparkline series used to live only in this component's state, so every
  // reload started blank. One seed from the host trend restores the recent past.
  const seeded = useRef(false)
  // Newest window the host has recorded, from the snapshot poll. The range
  // aggregates only change when this does (a duty window lands every 35s to
  // 2min), so a trend tick without a new window would re-aggregate the same
  // history for nothing.
  const latestWindow = useRef<number | null>(null)

  const pollMs = snapshot?.mode === 'continuous'
    ? DEFAULTS.continuousWindowMs
    : snapshot?.mode === 'background' ? DEFAULTS.backgroundIdleMs : DEFAULTS.windowMs

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const next = await client.snapshot()
        if (cancelled) return
        latestWindow.current = next.windowStartedAt
        setSnapshot(next)
        setError(null)
        setSeries(previous => {
          const updated: Record<string, number[]> = { ...previous }
          for (const row of next.plugins) {
            updated[row.moduleName] = [...(updated[row.moduleName] ?? []), row.cpuShare].slice(-SERIES_LENGTH)
          }
          return updated
        })
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, pollMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client, pollMs])

  useEffect(() => {
    let cancelled = false
    // Window the last fetch reflected; undefined forces the next tick to fetch
    // (mount, range change, or a failed read that should be retried).
    let loadedWindow: number | null | undefined
    const load = async (): Promise<void> => {
      const recorded = latestWindow.current
      if (loadedWindow !== undefined && recorded === loadedWindow) return
      loadedWindow = recorded
      try {
        const [nextStats, nextTrend] = await Promise.all([
          client.stats(range),
          client.trend(range),
        ])
        if (cancelled) return
        setStats(nextStats)
        setTrend(nextTrend)
        if (!seeded.current && nextTrend.times.length > 0) {
          seeded.current = true
          setSeries(previous => {
            const updated: Record<string, number[]> = { ...previous }
            for (const item of nextTrend.series) {
              if ((updated[item.moduleName] ?? []).length === 0) {
                updated[item.moduleName] = item.shares.slice(-SERIES_LENGTH)
              }
            }
            return updated
          })
        }
      } catch {
        // The trend is an enhancement; a failed read must not blank the live
        // board. Retry on the next tick even if no new window has landed.
        if (!cancelled) loadedWindow = undefined
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, TREND_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client, range])

  useEffect(() => subscribeLocale(() => { setLocaleRevision(revision => revision + 1) }), [])

  // The vitals reporter runs at the client entry (jank must be observed while
  // the panel is closed, too); the panel only polls the ring the host keeps.
  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void client.vitals().then(
        view => { if (!cancelled) setVitals(view) },
        () => { /* vitals are an enhancement */ },
      )
    }
    load()
    const timer = setInterval(load, DEFAULTS.vitalsWindowMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client])

  const toggleHotspots = (moduleName: string): void => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(moduleName)) {
        next.delete(moduleName)
        return next
      }
      next.add(moduleName)
      return next
    })
    // Fetch lazily; frame-level data is only available after a window collected
    // with memory sampling on.
    if (hotspots[moduleName] === undefined) {
      void client.hotspots(moduleName).then(
        response => { if (response.hotspots !== null) setHotspots(previous => ({ ...previous, [moduleName]: response.hotspots ?? [] })) },
        () => { /* the detail row already says data is unavailable */ },
      )
    }
  }

  const send = async (body: Parameters<PerfApi['control']>[0]): Promise<void> => {
    setBusy(true)
    try {
      setSnapshot(await client.control(body))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (snapshot === null) {
    return (
      <PanelErrorBoundary>
        <div className="pl-root"><div className="pl-empty">{error === null ? t('empty') : t('error') + ': ' + error}</div></div>
      </PanelErrorBoundary>
    )
  }

  // The controls render from what the host reports, not from local state: a page
  // reload (or a second tab) used to show every switch off while the host was
  // still sampling. `samplingOf` also covers a host too old to send the config.
  const sampling = samplingOf(snapshot)
  // A host that reports no config predates the three-block controls, so it also
  // does not know the fields they send: the buttons would look live and do
  // nothing. Say so instead of failing silently.
  const hostSkewed = snapshot.sampling === undefined
  // The chip is the resolved state: with three independent controls, "which
  // buttons are lit" no longer answers "what is the sampler doing", and this is
  // where the combination shows (stopped plus background sampling, for one).
  const chip = MODE_CHIP[snapshot.mode]

  // An older host answers /trend without the absolute basis; hide the switch
  // rather than offering a basis the data cannot support.
  const absoluteAvailable = trend !== null && hasAbsoluteSeries(trend)
  const latest = vitals?.latest ?? null
  const janky = latest !== null && (latest.longTaskTotalMs >= DEFAULTS.jankLongTaskMs || latest.rafGapP95Ms >= DEFAULTS.jankRafGapMs)
  const jank = vitals?.jank ?? null
  const schedule = vitals?.schedule ?? null
  // A mismatch means the table's offsets no longer describe the row the browser
  // runs, so every row is suspect: the switch stays on (a code change fixes it)
  // but the numbers are withheld.
  const scheduleTrustworthy = schedule !== null && schedule.contract !== 'mismatch'
  const toggleProbe = (): void => {
    const next = !scheduleProbe.state.active
    if (next) scheduleProbe.enable()
    else scheduleProbe.disable()
    // Remembered so the reload the switch asks for installs the probe before the
    // plugins register; without this the only path to the intended state would be
    // a manual on-then-reload cycle.
    rememberProbeEnabled(pageStorageOf(), next)
    setProbeOn(scheduleProbe.state.active)
    // Turning it on is only half the job: the plugins already registered their
    // callbacks with the unwrapped functions, so the intended state needs the
    // load-time install. Reloading here removes the manual on-then-reload step
    // the panel's hint used to ask for.
    if (next) window.location.reload()
  }

  return (
    <PanelErrorBoundary>
      <div className="pl-root">
        <div className="pl-head">
        <span className="pl-title">{t('title')}</span>
        <span className={snapshot.mode === 'continuous' ? 'pl-mode pl-mode-warn' : 'pl-mode'} title={t(chip.hint)}>{t(chip.label)}</span>
        <div className="pl-controls">
          <ControlBar
            sampling={sampling}
            busy={busy}
            unsupported={hostSkewed}
            onIntensity={(intensity) => { void send({ intensity }) }}
            onToggleBackground={() => { void send({ background: !sampling.background }) }}
            onToggleMemory={() => {
              const next = !sampling.memory
              if (!next) setHotspots({})
              void send({ memory: next })
            }}
            probeOn={probeOn}
            onToggleProbe={toggleProbe}
          />
          {hostSkewed ? <span className="pl-controls-warn">{t('hostSkew')}</span> : null}
        </div>
      </div>

      <GlobalBar snapshot={snapshot} />

      <Composition snapshot={snapshot} />

      <div className="pl-card">
        <div className="pl-card-title">{t('vitals')}</div>
        <div className="pl-vitals">
          {latest === null ? (
            <>
              <span className="pl-dot pl-dot-idle" />
              <span className="pl-vitals-dim">{t('noVitals')}</span>
            </>
          ) : (
            <>
              <span className={janky ? 'pl-dot pl-dot-jank' : 'pl-dot pl-dot-ok'} />
              <span>{janky ? t('janky') : t('smooth')}</span>
              <span className="pl-vitals-dim" title={t('longTasksHint')}>{t('longTasks')} {latest.longTaskCount} / {latest.longTaskTotalMs.toFixed(1)}ms</span>
              <span className="pl-vitals-dim" title={t('rafGapHint')}>{t('rafGap')} {latest.rafGapP95Ms.toFixed(1)}ms</span>
              {jank === null || jank.rows.length === 0 ? <span className="pl-vitals-dim">{t('correlation')}</span> : null}
            </>
          )}
        </div>
        {latest === null ? null : (
          <div className="pl-note" style={{ marginTop: '6px' }}>
            {[...snapshot.plugins].sort((a, b) => b.cpuShare - a.cpuShare).slice(0, 3)
              .map(row => row.moduleName + ' ' + (row.cpuShare * 100).toFixed(1) + '%')
              .join('  ·  ')}
          </div>
        )}
        {jank !== null && jank.rows.length > 0 ? (
          <>
            <table className="pl-table" title={t('jankTableHint')} style={{ marginTop: '8px' }}>
              <thead>
                <tr>
                  <th className="pl-th pl-th-left">{t('jankOwner')}</th>
                  <th className="pl-th">{t('jankScriptMs')}</th>
                  <th className="pl-th">{t('jankLayoutMs')}</th>
                  <th className="pl-th">{t('jankFrames')}</th>
                </tr>
              </thead>
              <tbody>
                {foldJankRows(jank.rows).map(row => (
                  <tr key={row.owner}>
                    <td className="pl-td pl-td-left pl-td-name">{displayJankOwner(row.owner)}</td>
                    <td className="pl-td">{row.durationMs.toFixed(1)}</td>
                    <td className="pl-td">{row.forcedLayoutMs.toFixed(1)}</td>
                    <td className="pl-td">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pl-note" style={{ marginTop: '6px' }}>
              {t('jankCoverage', { coverage: (jank.attributedShare * 100).toFixed(0) + '%' })}
            </div>
          </>
        ) : null}
        {schedule !== null ? (
          <>
            <div className="pl-note" style={{ marginTop: '10px', fontWeight: 600, color: 'inherit' }}>
              {t('scheduleTitle')}
            </div>
            {!scheduleTrustworthy ? (
              <div className="pl-note" style={{ marginTop: '4px' }}>{t('scheduleContractMismatch')}</div>
            ) : schedule.rows.length === 0 ? (
              <div className="pl-note" style={{ marginTop: '4px' }}>{t('probeOff')}</div>
            ) : (
              <>
                <table className="pl-table" title={t('scheduleBasis')} style={{ marginTop: '6px' }}>
                  <thead>
                    <tr>
                      <th className="pl-th pl-th-left">{t('scheduleOwner')}</th>
                      <th className="pl-th">{t('scheduleMs')}</th>
                      <th className="pl-th">{t('scheduleCalls')}</th>
                      <th className="pl-th">{t('scheduleMax')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {foldScheduleRows(schedule.rows).map(row => (
                      <tr key={row.owner}>
                        <td className="pl-td pl-td-left pl-td-name">{displayJankOwner(row.owner)}</td>
                        <td className="pl-td">{row.scheduledMs.toFixed(1)}</td>
                        <td className="pl-td">{row.calls}</td>
                        <td className="pl-td">{row.maxMs.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="pl-note" style={{ marginTop: '6px' }}>
                  {t('scheduleCoverage', { coverage: (schedule.attributedShare * 100).toFixed(0) + '%' })}
                </div>
              </>
            )}
          </>
        ) : null}
      </div>

      <div className="pl-card">
        <div className="pl-card-title">{t('topConsumers')}</div>
        <PluginCards rows={snapshot.plugins} series={series} stats={stats} sampleWindowMs={snapshot.global.sampleWindowMs} />
      </div>

      <div className="pl-card">
        <div className="pl-card-title">
          {t('trend')}
          <span className="pl-card-title-aside">
            {absoluteAvailable ? (
              <span className="pl-seg" role="group" aria-label={t('metricLabel')}>
                {(['share', 'absolute'] as const).map(item => (
                  <button
                    key={item}
                    className={trendMetric === item ? 'pl-seg-btn pl-seg-on' : 'pl-seg-btn'}
                    onClick={() => { setTrendMetric(item) }}
                  >
                    {item === 'share' ? t('metricShare') : t('metricAbsolute')}
                  </button>
                ))}
              </span>
            ) : null}
            <span className="pl-note">{t('range')}</span>
            <span className="pl-seg">
              {RANGES.map(item => (
                <button
                  key={item}
                  className={range === item ? 'pl-seg-btn pl-seg-on' : 'pl-seg-btn'}
                  onClick={() => { setRange(item) }}
                >
                  {item}
                </button>
              ))}
            </span>
          </span>
        </div>
        {trend === null
          ? <div className="pl-empty">{t('noTrend')}</div>
          : <TrendChart trend={trend} hideThreshold={DEFAULTS.trendHideThreshold} metric={trendMetric} />}
        {trendMetric === 'share' || !absoluteAvailable ? <div className="pl-note" style={{ marginTop: '6px' }}>{t('trendBasisHint')}</div> : null}
      </div>

      {stats !== null && stats.plugins.length > 0 ? (
        <div className="pl-card">
          <div className="pl-card-title">{t('scoreboard')}</div>
          <Scoreboard stats={stats} />
        </div>
      ) : null}

      <div className="pl-card">
        <div className="pl-card-title">{t('plugins')}</div>
        <MetricsTable
          rows={snapshot.plugins}
          series={series}
          sampleWindowMs={snapshot.global.sampleWindowMs}
          harnessBreakdown={snapshot.harnessBreakdown ?? []}
          expanded={expanded}
          hotspots={hotspots}
          onToggle={toggleHotspots}
          stats={stats}
        />
      </div>

        {error !== null ? <div className="pl-error">{error}</div> : null}
      </div>
    </PanelErrorBoundary>
  )
}
