// The task-manager table: one row per plugin, sortable by the resource that
// matters. Non-exact columns carry their coverage marker rather than looking as
// trustworthy as the exact ones.

import { useState } from 'react'
import type { PluginMetricRow } from '../shared/contract'
import { CoverageBadge } from './coverage-badge'
import { formatBytes, formatOps, formatPercent } from './format'
import { t } from './i18n'
import { Sparkline } from './sparkline'

type SortKey = 'cpuShare' | 'liveHeapBytes' | 'fs' | 'allocBytesPerSec'

function sortValue(row: PluginMetricRow, key: SortKey): number {
  switch (key) {
    case 'cpuShare': return row.cpuShare
    case 'liveHeapBytes': return row.liveHeapBytes
    case 'allocBytesPerSec': return row.allocBytesPerSec
    case 'fs': return row.fsReadOps + row.fsWriteOps
  }
}

export interface MetricsTableProps {
  readonly rows: readonly PluginMetricRow[]
  readonly series: Readonly<Record<string, readonly number[]>>
  readonly coverageThreshold: number
}

const HEADERS: readonly { key: SortKey; label: string }[] = [
  { key: 'cpuShare', label: t('cpu') },
  { key: 'liveHeapBytes', label: t('liveHeap') },
  { key: 'fs', label: t('disk') },
  { key: 'allocBytesPerSec', label: t('alloc') },
]

export function MetricsTable({ rows, series, coverageThreshold }: MetricsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('cpuShare')
  const sorted = [...rows].sort((left, right) => sortValue(right, sortKey) - sortValue(left, sortKey))
  const cell: React.CSSProperties = { padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
  const head: React.CSSProperties = { ...cell, opacity: 0.7, cursor: 'pointer', userSelect: 'none' }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
      <thead>
        <tr>
          <th style={{ ...cell, textAlign: 'left' }}>{t('plugin')}</th>
          {HEADERS.map(header => (
            <th key={header.key} style={head} onClick={() => { setSortKey(header.key) }}>
              {header.label}{sortKey === header.key ? ' ▾' : ''}
            </th>
          ))}
          <th style={head}>{t('coverage')}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(row => (
          <tr key={row.entryId === '' ? row.moduleName : row.entryId}>
            <td style={{ ...cell, textAlign: 'left' }}>{row.moduleName}</td>
            <td style={cell}>{formatPercent(row.cpuShare)}</td>
            <td style={cell}><Sparkline values={series[row.moduleName] ?? []} /></td>
            <td style={cell}>{formatBytes(row.liveHeapBytes)}</td>
            <td style={cell}>{formatOps(row.fsReadOps, row.fsWriteOps)}</td>
            <td style={cell}>{row.allocBytesPerSec === 0 ? '—' : `${formatBytes(row.allocBytesPerSec)}/s`}</td>
            <td style={cell}><CoverageBadge coverage={row.coverage} threshold={coverageThreshold} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
