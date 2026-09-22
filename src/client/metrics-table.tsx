// The task-manager table: one row per plugin, sortable by the resource that
// matters. Non-exact columns carry their coverage marker rather than looking as
// trustworthy as the exact ones.

import { Fragment, useState } from 'react'
import type { Hotspot, PluginMetricRow } from '../shared/contract'
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
  /** Expanded plugin module names; enables the hot-function detail rows. */
  readonly expanded?: ReadonlySet<string>
  /** Hot functions keyed by module name, filled lazily on expand. */
  readonly hotspots?: Readonly<Record<string, readonly Hotspot[]>>
  readonly onToggle?: (moduleName: string) => void
}

const HEADERS: readonly { key: SortKey; label: string }[] = [
  { key: 'cpuShare', label: t('cpu') },
  { key: 'liveHeapBytes', label: t('liveHeap') },
  { key: 'fs', label: t('disk') },
  { key: 'allocBytesPerSec', label: t('alloc') },
]

export function MetricsTable({ rows, series, coverageThreshold, expanded, hotspots, onToggle }: MetricsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('cpuShare')
  const sorted = [...rows].sort((left, right) => sortValue(right, sortKey) - sortValue(left, sortKey))
  const cell: React.CSSProperties = { padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
  const head: React.CSSProperties = { ...cell, opacity: 0.7, cursor: 'pointer', userSelect: 'none' }
  const clickable = onToggle !== undefined
  const nameCell: React.CSSProperties = { ...cell, textAlign: 'left', cursor: clickable ? 'pointer' : 'default' }
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
        {sorted.map(row => {
          const isOpen = expanded?.has(row.moduleName) ?? false
          const detail = hotspots?.[row.moduleName]
          return (
            <Fragment key={row.entryId === '' ? row.moduleName : row.entryId}>
              <tr>
                <td
                  style={nameCell}
                  onClick={clickable ? () => { onToggle(row.moduleName) } : undefined}
                >
                  {clickable ? `${isOpen ? '▾' : '▸'} ` : ''}{row.moduleName}
                </td>
                <td style={cell}>{formatPercent(row.cpuShare)}</td>
                <td style={cell}><Sparkline values={series[row.moduleName] ?? []} /></td>
                <td style={cell}>{formatBytes(row.liveHeapBytes)}</td>
                <td style={cell}>{formatOps(row.fsReadOps, row.fsWriteOps)}</td>
                <td style={cell}>{row.allocBytesPerSec === 0 ? '—' : `${formatBytes(row.allocBytesPerSec)}/s`}</td>
                <td style={cell}><CoverageBadge coverage={row.coverage} threshold={coverageThreshold} /></td>
              </tr>
              {isOpen ? (
                <tr>
                  <td colSpan={7} style={{ padding: '4px 8px 8px 20px', opacity: 0.9 }}>
                    <div style={{ marginBottom: '2px', opacity: 0.7 }}>{t('hotspot')}</div>
                    {detail === undefined || detail.length === 0
                      ? <div style={{ opacity: 0.6 }}>{t('hotspotNone')}</div>
                      : detail.map(item => (
                        <div key={`${item.url}:${item.lineNumber}:${item.functionName}`} style={{ display: 'flex', gap: '8px' }}>
                          <span style={{ minWidth: '150px' }}>{item.functionName}</span>
                          <span style={{ opacity: 0.7, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {item.url === '' ? '' : `${item.url}:${item.lineNumber}`}
                          </span>
                          <span>{item.selfMs.toFixed(2)}ms</span>
                        </div>
                      ))}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}
