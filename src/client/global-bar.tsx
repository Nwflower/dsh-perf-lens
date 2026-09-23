// Process overview: the totals every per-plugin figure is read against,
// as KPI tiles — resident memory, heap, event-loop lag, GC pause, sampling
// window and sample counts — plus the two qualifying shares (unattributed, own
// overhead) as footnote chips, warned when past their thresholds.
//
// Every tile carries a one-line hint: the tile labels are the panel's densest
// jargon (RSS, p99, GC, active samples), and a number a reader cannot interpret
// is worse than no number. The hint says what the figure is and how to read it.

import type { PerfSnapshot } from '../shared/contract'
import { DEFAULTS } from '../shared/defaults'
import { formatBytes, formatMs, formatPercent } from './format'
import { t, type MessageKey } from './i18n'

/**
 * Process CPU below this is too close to the platform clock's granularity to
 * calibrate against; ~15.6ms on Windows, so 100ms keeps the ratio meaningful.
 */
const CPU_CALIBRATION_FLOOR_MS = 100

export interface GlobalBarProps {
  readonly snapshot: PerfSnapshot
}

export function GlobalBar({ snapshot }: GlobalBarProps) {
  const { global } = snapshot
  const activeSamples = Math.max(0, global.sampleCount - global.idleSamples)
  const idleShare = global.sampleCount === 0 ? 0 : global.idleSamples / global.sampleCount
  const unattributedHigh = snapshot.unattributedShare > DEFAULTS.unattributedWarnThreshold
  // On an idle host the share denominator (active samples) shrinks to a few
  // percent, so every share reads ~15x too big. Say so instead of letting the
  // share columns be read as absolute cost (docs/design-overnight-analyzer.md §6.5).
  const idleBasis = idleShare >= DEFAULTS.idleBackoffThreshold
  // Resolution: the profiler's achieved interval, not the configured one. On
  // Windows the tick floors at ~536us regardless of a 250us setting (probe 16),
  // so the honest floor is sampleWindowMs / sampleCount. One active sample is
  // worth that much CPU, and 1/activeSamples of share.
  const achievedIntervalMs = global.sampleCount > 0 ? global.sampleWindowMs / global.sampleCount : 0
  const shareGranularity = activeSamples > 0 ? 1 / activeSamples : 0
  // Coverage needs a process-CPU figure well above the platform clock's
  // granularity (probe 08: ~15.6ms on Windows); below the floor the ratio is
  // noise, so the panel says so instead of printing a meaningless percentage.
  const processCpuMs = global.processCpuMs
  const sampledCpuMs = activeSamples * achievedIntervalMs
  const coverage = processCpuMs !== undefined && processCpuMs >= CPU_CALIBRATION_FLOOR_MS
    ? Math.min(1, sampledCpuMs / processCpuMs)
    : null
  const tiles: { readonly label: MessageKey; readonly hint: MessageKey; readonly value: string }[] = [
    { label: 'rss', hint: 'rssHint', value: formatBytes(global.rss) },
    { label: 'heap', hint: 'heapHint', value: formatBytes(global.heapUsed) },
    { label: 'lag', hint: 'lagHint', value: formatMs(global.eventLoopLagP99Ms) },
    { label: 'gc', hint: 'gcHint', value: formatMs(global.gcPauseMs) },
    { label: 'window', hint: 'windowHint', value: global.sampleWindowMs + 'ms' },
    { label: 'activeSamples', hint: 'activeSamplesHint', value: activeSamples + '/' + global.sampleCount },
    { label: 'idleShare', hint: 'idleShareHint', value: formatPercent(idleShare) },
  ]
  return (
    <div className="pl-card">
      <div className="pl-card-title">{t('overview')}</div>
      <div className="pl-kpis">
        {tiles.map(tile => (
          <div key={tile.label} className="pl-kpi" title={t(tile.hint)}>
            <div className="pl-kpi-label">{t(tile.label)}</div>
            <div className="pl-kpi-value">{tile.value}</div>
          </div>
        ))}
      </div>
      <div className="pl-chips">
        {idleBasis ? <span className="pl-chip-warn">{t('idleBasisHint')}</span> : null}
        <span title={t('cpuCoverageHint')}>
          {coverage === null ? t('cpuCoverageUnknown') : t('cpuCoverage') + ' ' + formatPercent(coverage)}
        </span>
        <span title={t('sampleResolutionHint', {
          total: global.sampleCount,
          active: activeSamples,
          interval: achievedIntervalMs.toFixed(2),
          granularity: formatPercent(shareGranularity),
        })}>
          {t('sampleResolution')} {achievedIntervalMs.toFixed(2)}ms
        </span>
        <span className={unattributedHigh ? 'pl-chip-warn' : undefined} title={t('unattributedHint')}>
          {t('unattributed')} {formatPercent(snapshot.unattributedShare)}{unattributedHigh ? ' ⚠' : ''}
        </span>
        <span title={t('selfHint')}>{t('self')} {formatPercent(snapshot.selfShare)}</span>
      </div>
    </div>
  )
}
