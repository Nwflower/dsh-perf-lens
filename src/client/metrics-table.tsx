// The detailed board: one section per owner family, sortable rows, and a fold
// for the plugins that did nothing this window.
//
// A flat table was the original design, but a real host loads 200+ plugins and
// most are idle in any given window, so the flat list was mostly zeros with the
// actual consumers lost in the middle. Sections plus the static fold make the
// signal the default and the zeros opt-in. The table caps its own height and
// pins its header; the page itself scrolls on .pl-root.
//
// The harness section additionally shows the host's sub-package breakdown: the
// folded `harness` row is deliberate, but on its own it hides which internal
// package costs what (docs/design-overnight-analyzer.md §6.5). Those rows are
// indented, measured on the same basis, and expandable to hot functions.

import { Fragment, useState } from 'react'
import type { HarnessBreakdownRow, Hotspot, PerfStats, PluginMetricRow } from '../shared/contract'
import { groupRows, groupShareOf, type PluginGroupId } from '../shared/grouping'
import { formatBytes, formatMsPerSecond, formatOps, formatPercent } from './format'
import { displayHarnessPackage, displayOwner, t } from './i18n'
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

/**
 * Columns per row. There is no coverage column: coverage qualifies byte
 * counts, and the table shows only file operation counts, which are exact.
 * Per-plugin bytes are not measured (docs/design.md §13 #22).
 */
const COLUMNS = 9

export interface MetricsTableProps {
  readonly rows: readonly PluginMetricRow[]
  readonly series: Readonly<Record<string, readonly number[]>>
  /** Window length the cpuSelfMs figures were measured over (absolute-cost basis). */
  readonly sampleWindowMs: number
  /** Harness sub-packages shown under the folded harness row (host-provided). */
  readonly harnessBreakdown?: readonly HarnessBreakdownRow[]
  /** Expanded plugin module names; enables the hot-function detail rows. */
  readonly expanded?: ReadonlySet<string>
  /** Hot functions keyed by module name, filled lazily on expand. */
  readonly hotspots?: Readonly<Record<string, readonly Hotspot[]>>
  readonly onToggle?: (moduleName: string) => void
  /** Range aggregate, joined by module name for the average/peak columns. */
  readonly stats?: PerfStats | null
}

/**
 * Widen a breakdown row into the table's row shape.
 *
 * A harness package has no loader entry, fiber phase, allocation figure or
 * coverage, so those cells stay empty and the renderer prints a dash for them
 * rather than a fake zero.
 */
export function breakdownToRow(row: HarnessBreakdownRow): PluginMetricRow {
  return {
    moduleName: row.moduleName,
    entryId: '',
    fiberPhase: '',
    cpuShare: row.cpuShare,
    cpuSelfMs: row.cpuSelfMs,
    liveHeapBytes: row.liveHeapBytes,
    allocBytesPerSec: 0,
    fsReadOps: row.fsReadOps,
    fsWriteOps: row.fsWriteOps,
    fsReadBytes: 0,
    fsWriteBytes: 0,
    coverage: 0,
    timers: 0,
    listeners: 0,
    handles: 0,
    diskFootprintBytes: 0,
  }
}

export function MetricsTable({
  rows, series, sampleWindowMs, harnessBreakdown, expanded, hotspots, onToggle, stats,
}: MetricsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('cpuShare')
  const [openStatic, setOpenStatic] = useState<ReadonlySet<PluginGroupId>>(new Set())
  // Expanded by default: the fold is what hid the answer in the first place
  // (docs/design-overnight-analyzer.md §6.5), so the ranking is the default view.
  const [openBreakdown, setOpenBreakdown] = useState(true)
  const groups = groupRows(rows)
  const byName = new Map((stats?.plugins ?? []).map(row => [row.moduleName, row]))
  const clickable = onToggle !== undefined
  const breakdown = harnessBreakdown ?? []

  const toggleStatic = (id: PluginGroupId): void => {
    setOpenStatic(previous => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const sortHeader = (key: SortKey, label: string) => (
    <th className="pl-th pl-th-sort" onClick={() => { setSortKey(key) }}>
      {label}{sortKey === key ? ' ▾' : ''}
    </th>
  )

  const detailRow = (moduleName: string, colSpan: number) => {
    const detail = hotspots?.[moduleName]
    return (
      <tr>
        <td colSpan={colSpan} className="pl-detail">
          <div className="pl-note" style={{ marginBottom: '2px' }}>{t('hotspot')}</div>
          {detail === undefined || detail.length === 0
            ? <div className="pl-td-dim">{t('hotspotNone')}</div>
            : detail.map(item => (
              <div key={item.url + ':' + item.lineNumber + ':' + item.functionName} className="pl-detail-row">
                <span className="pl-detail-fn">{item.functionName}</span>
                <span className="pl-detail-url">
                  {item.url === '' ? '' : item.url + ':' + item.lineNumber}
                </span>
                <span>{item.selfMs.toFixed(2)}ms</span>
              </div>
            ))}
        </td>
      </tr>
    )
  }

  const dataRow = (row: PluginMetricRow, sub = false) => {
    const isOpen = expanded?.has(row.moduleName) ?? false
    const aggregated = byName.get(row.moduleName)
    const nameClass = [
      'pl-td', 'pl-td-left', 'pl-td-name',
      sub ? 'pl-td-sub' : '',
      clickable ? 'pl-td-click' : '',
    ].filter(part => part !== '').join(' ')
    return (
      <Fragment key={(sub ? 'sub:' : '') + (row.entryId === '' ? row.moduleName : row.entryId)}>
        <tr className={sub ? 'pl-row pl-row-sub' : 'pl-row'}>
          <td className={nameClass} onClick={clickable ? () => { onToggle(row.moduleName) } : undefined}>
            {clickable ? (isOpen ? '▾ ' : '▸ ') : ''}
            {sub ? displayHarnessPackage(row.moduleName) : displayOwner(row.moduleName)}
          </td>
          <td className="pl-td">{formatPercent(row.cpuShare)}</td>
          <td className="pl-td" title={t('idleBasisHint')}>{formatMsPerSecond(row.cpuSelfMs, sampleWindowMs)}</td>
          <td className="pl-td">{aggregated === undefined ? '—' : formatPercent(aggregated.avgCpuShare)}</td>
          <td className="pl-td">{aggregated === undefined ? '—' : formatPercent(aggregated.peakCpuShare)}</td>
          <td className="pl-td"><Sparkline values={series[row.moduleName] ?? []} /></td>
          <td className="pl-td">{formatBytes(row.liveHeapBytes)}</td>
          <td className="pl-td">{formatOps(row.fsReadOps, row.fsWriteOps)}</td>
          <td className="pl-td">{sub || row.allocBytesPerSec === 0 ? '—' : formatBytes(row.allocBytesPerSec) + '/s'}</td>
        </tr>
        {isOpen ? detailRow(row.moduleName, COLUMNS) : null}
      </Fragment>
    )
  }

  return (
    <div className="pl-table-wrap">
      <table className="pl-table">
        <thead>
          <tr>
            <th className="pl-th pl-th-left">{t('plugin')}</th>
            {sortHeader('cpuShare', t('cpu'))}
            <th className="pl-th" title={t('absoluteHint')}>{t('absolute')}</th>
            <th className="pl-th">{t('avg')}</th>
            <th className="pl-th">{t('peak')}</th>
            <th className="pl-th">{t('spark')}</th>
            <th className="pl-th pl-th-sort" title={t('liveHeapHint')} onClick={() => { setSortKey('liveHeapBytes') }}>{t('liveHeap')}{sortKey === 'liveHeapBytes' ? ' ▾' : ''}</th>
            {sortHeader('fs', t('disk'))}
            {sortHeader('allocBytesPerSec', t('alloc'))}
          </tr>
        </thead>
        <tbody>
          {groups.map(group => {
            const sorted = [...group.rows].sort((left, right) => sortValue(right, sortKey) - sortValue(left, sortKey))
            const staticOpen = openStatic.has(group.id)
            const showBreakdown = group.id === 'harness' && breakdown.length > 0
            return (
              <Fragment key={group.id}>
                <tr className="pl-group-row">
                  <th colSpan={COLUMNS} className="pl-th">
                    <span>{t(GROUP_LABEL[group.id])}</span>
                    <span className="pl-group-meta"> · {sorted.length}</span>
                    {sorted.length > 0 ? <span className="pl-group-meta"> · {formatPercent(groupShareOf(group))}</span> : null}
                    {showBreakdown ? (
                      <button
                        className="pl-fold-btn"
                        title={t('harnessBreakdownHint')}
                        onClick={() => { setOpenBreakdown(previous => !previous) }}
                      >
                        {(openBreakdown ? '▾ ' : '▸ ') + t('harnessBreakdown') + ' Top ' + breakdown.length}
                      </button>
                    ) : null}
                    {group.staticRows.length > 0 ? (
                      <button className="pl-fold-btn" onClick={() => { toggleStatic(group.id) }}>
                        {(staticOpen ? '▾ ' : '▸ ') + t('staticFold') + ' ' + group.staticRows.length}
                      </button>
                    ) : null}
                  </th>
                </tr>
                {sorted.map(row => dataRow(row))}
                {showBreakdown && openBreakdown ? breakdown.map(row => dataRow(breakdownToRow(row), true)) : null}
                {staticOpen ? group.staticRows.map(row => dataRow(row)) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
