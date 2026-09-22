// Card row for the plugins that actually cost something right now.
//
// The table below is the complete truth, but a 200-plugin host makes it a wall.
// These cards answer "who is eating resources" at a glance, and they carry the
// average and peak next to the instantaneous value so a single quiet window
// cannot make a chronically expensive plugin look free.

import type { PerfStats, PluginMetricRow } from '../shared/contract'
import { formatPercent } from './format'
import { t } from './i18n'
import { Sparkline } from './sparkline'

export interface PluginCardsProps {
  readonly rows: readonly PluginMetricRow[]
  readonly series: Readonly<Record<string, readonly number[]>>
  readonly stats: PerfStats | null
  readonly limit?: number
}

/** The rows worth a card: cost now, or heap held, biggest first. */
export function topRows(rows: readonly PluginMetricRow[], limit: number): PluginMetricRow[] {
  return [...rows]
    .filter(row => row.cpuShare > 0 || row.liveHeapBytes > 0 || row.fsReadOps + row.fsWriteOps > 0)
    .sort((a, b) => b.cpuShare - a.cpuShare || b.liveHeapBytes - a.liveHeapBytes)
    .slice(0, limit)
}

export function PluginCards({ rows, series, stats, limit = 6 }: PluginCardsProps) {
  const top = topRows(rows, limit)
  if (top.length === 0) return <div style={{ opacity: 0.6 }}>{t('empty')}</div>
  const byName = new Map((stats?.plugins ?? []).map(row => [row.moduleName, row]))
  const card: React.CSSProperties = {
    border: '1px solid currentColor', borderRadius: '6px', padding: '8px 10px',
    display: 'grid', gap: '4px', minWidth: '150px', opacity: 0.95,
  }
  const stat: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '8px', opacity: 0.85 }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      {top.map(row => {
        const aggregated = byName.get(row.moduleName)
        return (
          <div key={row.entryId === '' ? row.moduleName : row.entryId} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '130px' }}>
                {row.moduleName}
              </span>
              <strong>{formatPercent(row.cpuShare)}</strong>
            </div>
            <Sparkline values={series[row.moduleName] ?? []} />
            <div style={stat}><span>{t('avg')}</span><span>{formatPercent(aggregated?.avgCpuShare ?? row.cpuShare)}</span></div>
            <div style={stat}><span>{t('peak')}</span><span>{formatPercent(aggregated?.peakCpuShare ?? row.cpuShare)}</span></div>
          </div>
        )
      })}
    </div>
  )
}
