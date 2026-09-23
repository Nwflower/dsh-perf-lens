// The detailed board: one section per owner family, sortable rows, and a fold
// for the plugins that did nothing this window.
//
// A flat table was the original design, but a real host loads 200+ plugins and
// most are idle in any given window, so the flat list was mostly zeros with the
// actual consumers lost in the middle. Sections plus the static fold make the
// signal the default and the zeros opt-in.

import { Fragment, useState } from 'react'
import type { Hotspot, PerfStats, PluginMetricRow } from '../shared/contract'
import { groupRows, groupShareOf, type PluginGroupId } from '../shared/grouping'
import { CoverageBadge } from './coverage-badge'
import { formatBytes, formatOps, formatPercent } from './format'
import { displayOwner, t } from './i18n'
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

const GROUP_LABEL: Record<PluginGroupId, 'groupExternal' | 'groupHarness' | 'groupRuntime' | 'groupSelf' | 'groupOther'> = {
  external: 'groupExternal',
  harness: 'groupHarness',
  runtime: 'groupRuntime',
  self: 'groupSelf',
  other: 'groupOther',
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
  /** Range aggregate, joined by module name for the average/peak columns. */
  readonly stats?: PerfStats | null
}

export function MetricsTable({
  rows, series, coverageThreshold, expanded, hotspots, onToggle, stats,
}: MetricsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('cpuShare')
  const [openStatic, setOpenStatic] = useState<ReadonlySet<PluginGroupId>>(new Set())
  const groups = groupRows(rows)
  const byName = new Map((stats?.plugins ?? []).map(row => [row.moduleName, row]))
  const cell: React.CSSProperties = { padding: '4px 8px', textAlign: 'right', whiteSpace: 'nowrap' }
  const head: React.CSSProperties = { ...cell, opacity: 0.7, cursor: 'pointer', userSelect: 'none' }
  const clickable = onToggle !== undefined
  const nameCell: React.CSSProperties = { ...cell, textAlign: 'left', cursor: clickable ? 'pointer' : 'default' }

  const toggleStatic = (id: PluginGroupId): void => {
    setOpenStatic(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const detailRow = (row: PluginMetricRow, colSpan: number) => {
    const detail = hotspots?.[row.moduleName]
    return (
      <tr>
        <td colSpan={colSpan} style={{ padding: '4px 8px 8px 20px', opacity: 0.9 }}>
          <div style={{ marginBottom: '2px', opacity: 0.7 }}>{t('hotspot')}</div>
          {detail === undefined || detail.length === 0
            ? <div style={{ opacity: 0.6 }}>{t('hotspotNone')}</div>
            : detail.map(item => (
              <div key={item.url + ':' + item.lineNumber + ':' + item.functionName} style={{ display: 'flex', gap: '8px' }}>
                <span style={{ minWidth: '150px' }}>{item.functionName}</span>
                <span style={{ opacity: 0.7, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.url === '' ? '' : item.url + ':' + item.lineNumber}
                </span>
                <span>{item.selfMs.toFixed(2)}ms</span>
              </div>
            ))}
        </td>
      </tr>
    )
  }

  const dataRow = (row: PluginMetricRow) => {
    const isOpen = expanded?.has(row.moduleName) ?? false
    const aggregated = byName.get(row.moduleName)
    return (
      <Fragment key={row.entryId === '' ? row.moduleName : row.entryId}>
        <tr>
          <td style={nameCell} onClick={clickable ? () => { onToggle(row.moduleName) } : undefined}>
            {clickable ? (isOpen ? '▾ ' : '▸ ') : ''}{displayOwner(row.moduleName)}
          </td>
          <td style={cell}>{formatPercent(row.cpuShare)}</td>
          <td style={cell}>{aggregated === undefined ? '—' : formatPercent(aggregated.avgCpuShare)}</td>
          <td style={cell}>{aggregated === undefined ? '—' : formatPercent(aggregated.peakCpuShare)}</td>
          <td style={cell}><Sparkline values={series[row.moduleName] ?? []} /></td>
          <td style={cell}>{formatBytes(row.liveHeapBytes)}</td>
          <td style={cell}>{formatOps(row.fsReadOps, row.fsWriteOps)}</td>
          <td style={cell}>{row.allocBytesPerSec === 0 ? '—' : formatBytes(row.allocBytesPerSec) + '/s'}</td>
          <td style={cell}><CoverageBadge coverage={row.coverage} threshold={coverageThreshold} /></td>
        </tr>
        {isOpen ? detailRow(row, 9) : null}
      </Fragment>
    )
  }

  const groupHead: React.CSSProperties = {
    padding: '6px 8px', textAlign: 'left', opacity: 0.9, borderTop: '1px solid currentColor',
  }

  return (
    <div style={{ maxHeight: '48vh', overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left' }}>{t('plugin')}</th>
            <th style={head} onClick={() => { setSortKey('cpuShare') }}>{t('cpu')}{sortKey === 'cpuShare' ? ' ▾' : ''}</th>
            <th style={cell}>{t('avg')}</th>
            <th style={cell}>{t('peak')}</th>
            <th style={cell}>{t('spark')}</th>
            <th style={head} onClick={() => { setSortKey('liveHeapBytes') }}>{t('liveHeap')}{sortKey === 'liveHeapBytes' ? ' ▾' : ''}</th>
            <th style={head} onClick={() => { setSortKey('fs') }}>{t('disk')}{sortKey === 'fs' ? ' ▾' : ''}</th>
            <th style={head} onClick={() => { setSortKey('allocBytesPerSec') }}>{t('alloc')}{sortKey === 'allocBytesPerSec' ? ' ▾' : ''}</th>
            <th style={cell}>{t('coverage')}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(group => {
            const sorted = [...group.rows].sort((left, right) => sortValue(right, sortKey) - sortValue(left, sortKey))
            const staticOpen = openStatic.has(group.id)
            return (
              <Fragment key={group.id}>
                <tr>
                  <th colSpan={9} style={groupHead}>
                    <span style={{ fontWeight: 600 }}>{t(GROUP_LABEL[group.id])}</span>
                    <span style={{ opacity: 0.6 }}> · {sorted.length}</span>
                    {sorted.length > 0 ? <span style={{ opacity: 0.6 }}> · {formatPercent(groupShareOf(group))}</span> : null}
                    {group.staticRows.length > 0 ? (
                      <button
                        onClick={() => { toggleStatic(group.id) }}
                        style={{ marginLeft: '8px', opacity: 0.7, cursor: 'pointer', fontSize: '11px' }}
                      >
                        {(staticOpen ? '▾ ' : '▸ ') + t('staticFold') + ' ' + group.staticRows.length}
                      </button>
                    ) : null}
                  </th>
                </tr>
                {sorted.map(dataRow)}
                {staticOpen ? group.staticRows.map(dataRow) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
