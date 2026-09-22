// Cumulative-cost scoreboard: "which plugin has burned the most over this
// range", with the peak/average split that an instantaneous window cannot show.
//
// cumulativeCpuMs is sampled CPU milliseconds; estimatedCpuMs scales it by the
// sampling coverage and is labeled an estimate, never presented as measured.

import type { PerfStats } from '../shared/contract'
import { formatPercent } from './format'
import { t } from './i18n'

function ms(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`
  return `${value.toFixed(1)}ms`
}

export interface ScoreboardProps {
  readonly stats: PerfStats
}

export function Scoreboard({ stats }: ScoreboardProps) {
  const cell: React.CSSProperties = { padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
  const head: React.CSSProperties = { ...cell, opacity: 0.7 }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
      <thead>
        <tr>
          <th style={{ ...cell, textAlign: 'left' }}>#</th>
          <th style={{ ...cell, textAlign: 'left' }}>{t('plugin')}</th>
          <th style={head}>{t('cumulative')}</th>
          <th style={head}>{t('avg')}</th>
          <th style={head}>{t('p95')}</th>
          <th style={head}>{t('peak')}</th>
          <th style={head}>{t('estimate')}</th>
        </tr>
      </thead>
      <tbody>
        {stats.plugins.map((row, index) => (
          <tr key={row.moduleName}>
            <td style={{ ...cell, textAlign: 'left', opacity: 0.6 }}>{index + 1}</td>
            <td style={{ ...cell, textAlign: 'left' }}>{row.moduleName}</td>
            <td style={cell}>{ms(row.cumulativeCpuMs)}</td>
            <td style={cell}>{formatPercent(row.avgCpuShare)}</td>
            <td style={cell}>{formatPercent(row.p95CpuShare)}</td>
            <td style={cell}>{formatPercent(row.peakCpuShare)}</td>
            <td style={{ ...cell, opacity: 0.7 }}>≈ {ms(row.estimatedCpuMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
