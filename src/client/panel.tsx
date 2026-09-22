// Main-column task-manager board. Polls the host snapshot at the cadence of the
// active sampling window (continuous mode polls faster), keeps a short local
// CPU series for the sparklines, and forwards control toggles to the host.
//
// The trend and scoreboard read the recorded history/stats endpoints, which are
// heavier (JSONL aggregation), so they refresh on their own slower cadence and
// on an explicit range change instead of every snapshot poll.

import { useEffect, useRef, useState } from 'react'
import type { PerfRange, PerfSnapshot, PerfStats } from '../shared/contract'
import { DEFAULTS, RANGE_MS } from '../shared/defaults'
import { createPerfApi, type PerfApi } from './api'
import { ControlBar } from './control-bar'
import { GlobalBar } from './global-bar'
import { t } from './i18n'
import { MetricsTable } from './metrics-table'
import { Scoreboard } from './scoreboard'
import { TrendChart } from './trend-chart'

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
  const [history, setHistory] = useState<readonly PerfSnapshot[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deep, setDeep] = useState(false)

  const pollMs = snapshot?.mode === 'continuous' ? DEFAULTS.continuousWindowMs : DEFAULTS.windowMs

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const next = await client.snapshot()
        if (cancelled) return
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
    const load = async (): Promise<void> => {
      try {
        const since = Date.now() - RANGE_MS[range]
        const [nextStats, nextHistory] = await Promise.all([
          client.stats(range),
          client.history({ since }),
        ])
        if (cancelled) return
        setStats(nextStats)
        setHistory(nextHistory)
      } catch {
        // The trend is an enhancement; a failed read must not blank the live board.
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, TREND_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client, range])

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

  const style: React.CSSProperties = { padding: '12px 14px', display: 'grid', gap: '10px', fontSize: '12px' }
  const section: React.CSSProperties = { borderTop: '1px solid currentColor', paddingTop: '8px', display: 'grid', gap: '6px' }
  const sectionHead: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', opacity: 0.85 }

  if (snapshot === null) {
    return <div style={style}>{error === null ? t('empty') : `${t('error')}: ${error}`}</div>
  }

  return (
    <div style={style}>
      <GlobalBar snapshot={snapshot} />
      <ControlBar
        mode={snapshot.mode}
        deep={deep}
        busy={busy}
        onPause={() => { void send({ action: 'pause' }) }}
        onResume={() => { void send({ action: 'resume' }) }}
        onToggleContinuous={() => { void send({ mode: snapshot.mode === 'continuous' ? 'duty' : 'continuous' }) }}
        onToggleDeep={() => {
          const next = !deep
          setDeep(next)
          void send({ deep: next })
        }}
      />
      <MetricsTable rows={snapshot.plugins} series={series} coverageThreshold={DEFAULTS.coverageWarnThreshold} />
      <div style={section}>
        <div style={sectionHead}>
          <strong>{t('trend')}</strong>
          <span style={{ opacity: 0.6 }}>{t('range')}</span>
          {RANGES.map(item => (
            <button
              key={item}
              onClick={() => { setRange(item) }}
              style={{ opacity: range === item ? 1 : 0.5, cursor: 'pointer' }}
            >
              {item}
            </button>
          ))}
        </div>
        <TrendChart snapshots={history} hideThreshold={DEFAULTS.trendHideThreshold} />
      </div>
      {stats !== null && stats.plugins.length > 0 ? (
        <div style={section}>
          <div style={sectionHead}><strong>{t('scoreboard')}</strong></div>
          <Scoreboard stats={stats} />
        </div>
      ) : null}
      {error !== null ? <div style={{ opacity: 0.7 }}>{error}</div> : null}
    </div>
  )
}
