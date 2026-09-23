// Card grid for the plugins that actually cost something right now.
//
// The table below is the complete truth, but a 200-plugin host makes it a wall.
// These cards answer "who is eating resources" at a glance, and they carry the
// average, the peak and the held heap next to the instantaneous value so a
// single quiet window cannot make a chronically expensive plugin look free.

import type { PerfStats, PluginMetricRow } from '../shared/contract'
import { cpuCoreShare, formatBytes, formatMsPerSecond, formatPercent } from './format'
import { displayOwner, t } from './i18n'
import { Sparkline } from './sparkline'

export interface PluginCardsProps {
  readonly rows: readonly PluginMetricRow[]
  readonly series: Readonly<Record<string, readonly number[]>>
  readonly stats: PerfStats | null
  /** Window length the cpuSelfMs figures were measured over (absolute-cost basis). */
  readonly sampleWindowMs: number
  readonly limit?: number
}

/** The rows worth a card: cost now, or heap held, biggest first. */
export function topRows(rows: readonly PluginMetricRow[], limit: number): PluginMetricRow[] {
  return [...rows]
    .filter(row => row.cpuShare > 0 || row.liveHeapBytes > 0 || row.fsReadOps + row.fsWriteOps > 0)
    .sort((a, b) => b.cpuShare - a.cpuShare || b.liveHeapBytes - a.liveHeapBytes)
    .slice(0, limit)
}

export function PluginCards({ rows, series, stats, sampleWindowMs, limit = 6 }: PluginCardsProps) {
  const top = topRows(rows, limit)
  if (top.length === 0) return <div className="pl-empty">{t('empty')}</div>
  const byName = new Map((stats?.plugins ?? []).map(row => [row.moduleName, row]))
  return (
    <div className="pl-cards">
      {top.map(row => {
        const aggregated = byName.get(row.moduleName)
        return (
          <div key={row.entryId === '' ? row.moduleName : row.entryId} className="pl-pcard">
            <div className="pl-pcard-head">
              <span className="pl-pcard-name">{displayOwner(row.moduleName)}</span>
              <span className="pl-pcard-cpu">{formatPercent(row.cpuShare)}</span>
            </div>
            <Sparkline values={series[row.moduleName] ?? []} />
            <div className="pl-pcard-stat" title={t('coreShareHint')}><span>{t('coreShare')}</span><span>{formatPercent(cpuCoreShare(row.cpuSelfMs, sampleWindowMs))} · {formatMsPerSecond(row.cpuSelfMs, sampleWindowMs)}</span></div>
            <div className="pl-pcard-stat"><span>{t('avg')}</span><span>{formatPercent(aggregated?.avgCpuShare ?? row.cpuShare)}</span></div>
            <div className="pl-pcard-stat"><span>{t('peak')}</span><span>{formatPercent(aggregated?.peakCpuShare ?? row.cpuShare)}</span></div>
            <div className="pl-pcard-stat" title={t('liveHeapHint')}><span>{t('heapShort')}</span><span>{formatBytes(row.liveHeapBytes)}</span></div>
          </div>
        )
      })}
    </div>
  )
}
