// Main-column task-manager board. Polls the host snapshot at the cadence of the
// active sampling window (continuous mode polls faster), keeps a short local
// CPU series for the sparklines, and forwards control toggles to the host.

import { useEffect, useRef, useState } from 'react'
import type { PerfSnapshot } from '../shared/contract'
import { DEFAULTS } from '../shared/defaults'
import { createPerfApi, type PerfApi } from './api'
import { ControlBar } from './control-bar'
import { GlobalBar } from './global-bar'
import { t } from './i18n'
import { MetricsTable } from './metrics-table'

/** Sparkline depth: enough to see a trend without retaining a profile. */
const SERIES_LENGTH = 30

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
      {error !== null ? <div style={{ opacity: 0.7 }}>{error}</div> : null}
    </div>
  )
}
