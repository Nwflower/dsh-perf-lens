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
import type { Hotspot, PerfRange, PerfSnapshot, PerfStats, PerfTrend, VitalsView } from '../shared/contract'
import { DEFAULTS } from '../shared/defaults'
import { createPerfApi, type PerfApi } from './api'
import { Composition } from './composition'
import { PanelErrorBoundary } from './error-boundary'
import { ControlBar } from './control-bar'
import { GlobalBar } from './global-bar'
import { subscribeLocale, t } from './i18n'
import { MetricsTable } from './metrics-table'
import { PluginCards } from './plugin-cards'
import { Scoreboard } from './scoreboard'
import { hasAbsoluteSeries, TrendChart, type TrendMetric } from './trend-chart'
import { startVitalsReporter } from './vitals'

/** Sparkline depth: enough to see a trend without retaining a profile. */
const SERIES_LENGTH = 30
/** Trend/scoreboard refresh cadence; JSONL aggregation is not free. */
const TREND_REFRESH_MS = 15_000
const RANGES: readonly PerfRange[] = ['1h', '24h', '7d']

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
  const [deep, setDeep] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [hotspots, setHotspots] = useState<Readonly<Record<string, readonly Hotspot[]>>>({})
  const [vitals, setVitals] = useState<VitalsView | null>(null)
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

  useEffect(() => {
    let cancelled = false
    client.vitals().then(
      view => { if (!cancelled) setVitals(view) },
      () => { /* vitals are an enhancement */ },
    )
    const stop = startVitalsReporter({
      windowMs: DEFAULTS.vitalsWindowMs,
      onReport: report => {
        void client.postVitals(report).then(
          view => { if (!cancelled) setVitals(view) },
          () => { /* a dropped report must not disturb the board */ },
        )
      },
    })
    return () => {
      cancelled = true
      stop()
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
    // Fetch lazily; frame-level data is only available after a deep-mode window.
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

  const modeLabel = snapshot.mode === 'continuous'
    ? t('continuous')
    : snapshot.mode === 'background'
      ? t('background')
      : snapshot.mode === 'paused' ? t('paused') : t('duty')
  // The chip names the active tier; its hint says what that tier is doing, so a
  // reader does not have to infer it from which button looks lit.
  const modeHint = snapshot.mode === 'continuous'
    ? t('continuousHint')
    : snapshot.mode === 'background'
      ? t('backgroundHint')
      : snapshot.mode === 'paused' ? t('pausedHint') : t('dutyHint')

  // An older host answers /trend without the absolute basis; hide the switch
  // rather than offering a basis the data cannot support.
  const absoluteAvailable = trend !== null && hasAbsoluteSeries(trend)
  const latest = vitals?.latest ?? null
  const janky = latest !== null && (latest.longTaskTotalMs >= DEFAULTS.jankLongTaskMs || latest.rafGapP95Ms >= DEFAULTS.jankRafGapMs)

  return (
    <PanelErrorBoundary>
      <div className="pl-root">
        <div className="pl-head">
        <span className="pl-title">{t('title')}</span>
        <span className={snapshot.mode === 'continuous' ? 'pl-mode pl-mode-warn' : 'pl-mode'} title={modeHint}>{modeLabel}</span>
        <div className="pl-controls">
          <ControlBar
            mode={snapshot.mode}
            deep={deep}
            busy={busy}
            onPause={() => { void send({ action: 'pause' }) }}
            onResume={() => { void send({ action: 'resume' }) }}
            onToggleContinuous={() => { void send({ mode: snapshot.mode === 'continuous' ? 'duty' : 'continuous' }) }}
            onToggleBackground={() => { void send({ mode: snapshot.mode === 'background' ? 'duty' : 'background' }) }}
            onToggleDeep={() => {
              const next = !deep
              setDeep(next)
              if (!next) setHotspots({})
              void send({ deep: next })
            }}
          />
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
              <span className="pl-vitals-dim">{t('correlation')}</span>
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
