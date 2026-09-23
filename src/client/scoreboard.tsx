// Cumulative-cost scoreboard: "which plugin has burned the most over this
// range", with the peak/average split that an instantaneous window cannot show.
//
// cumulativeCpuMs is sampled CPU milliseconds; estimatedCpuMs scales it by the
// sampling coverage and is labeled an estimate, never presented as measured.
//
// The range aggregate names every plugin that ever had a row, and on a real
// host most of those burned nothing: listing them all made this card 219 rows
// (6,000+ px) and buried the detail table under it. Only plugins with sampled
// CPU are ranked, the top SCOREBOARD_LIMIT by default, and the rest are counted
// in the footer rather than dropped silently.

import { useState } from 'react'
import type { PerfStats, PluginStatsRow } from '../shared/contract'
import { DEFAULTS } from '../shared/defaults'
import { formatMsPerSecond, formatPercent } from './format'
import { displayOwner, t } from './i18n'

/** Rows shown before "show all"; the point of a ranking is its top. */
export const SCOREBOARD_LIMIT = 10

function ms(value: number): string {
  if (value >= 1000) return (value / 1000).toFixed(2) + 's'
  return value.toFixed(1) + 'ms'
}

/** Plugins with any sampled CPU in range, in the host's cumulative order. */
export function rankedRows(stats: PerfStats): PluginStatsRow[] {
  return stats.plugins.filter(row => row.cumulativeCpuMs > 0)
}

/**
 * Whether the whole-range estimate is worth printing. Below the floor it is a
 * large multiple of what was actually sampled, so the column shows a dash and
 * the footer says why.
 */
export function estimateShown(stats: PerfStats): boolean {
  return stats.coverage >= DEFAULTS.estimateMinCoverage
}

export interface ScoreboardProps {
  readonly stats: PerfStats
  readonly limit?: number
}

export function Scoreboard({ stats, limit = SCOREBOARD_LIMIT }: ScoreboardProps) {
  const [showAll, setShowAll] = useState(false)
  const ranked = rankedRows(stats)
  if (ranked.length === 0) return <div className="pl-empty">{t('noScoreboard')}</div>
  const shown = showAll ? ranked : ranked.slice(0, limit)
  const estimated = estimateShown(stats)
  const coverage = formatPercent(stats.coverage)
  const notes: string[] = []
  const idle = stats.plugins.length - ranked.length
  if (idle > 0) notes.push(t('scoreboardIdle', { n: idle }))
  if (!estimated) notes.push(t('estimateHidden', { coverage, factor: Math.round(1 / Math.max(stats.coverage, 1e-6)) }))
  return (
    <>
      <table className="pl-table">
        <thead>
          <tr>
            <th className="pl-th pl-th-left">#</th>
            <th className="pl-th pl-th-left">{t('plugin')}</th>
            <th className="pl-th">{t('cumulative')}</th>
            <th className="pl-th" title={t('absoluteHint')}>{t('absolute')}</th>
            <th className="pl-th">{t('avg')}</th>
            <th className="pl-th" title={t('p95Hint')}>{t('p95')}</th>
            <th className="pl-th">{t('peak')}</th>
            <th className="pl-th" title={t('estimateHint', { coverage })}>{t('estimate')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row, index) => (
            <tr key={row.moduleName} className="pl-row">
              <td className="pl-td pl-td-left pl-td-dim">{index + 1}</td>
              <td className="pl-td pl-td-left pl-td-name">{displayOwner(row.moduleName)}</td>
              <td className="pl-td">{ms(row.cumulativeCpuMs)}</td>
              <td className="pl-td">{formatMsPerSecond(row.cumulativeCpuMs, stats.sampledWindowMs)}</td>
              <td className="pl-td">{formatPercent(row.avgCpuShare)}</td>
              <td className="pl-td">{formatPercent(row.p95CpuShare)}</td>
              <td className="pl-td">{formatPercent(row.peakCpuShare)}</td>
              <td className="pl-td pl-td-dim">{estimated ? '≈ ' + ms(row.estimatedCpuMs) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ranked.length > limit || notes.length > 0 ? (
        <div className="pl-table-foot">
          {ranked.length > limit ? (
            <button type="button" className="pl-fold-btn" onClick={() => { setShowAll(previous => !previous) }}>
              {showAll ? t('showTop', { n: limit }) : t('showAll', { n: ranked.length })}
            </button>
          ) : null}
          {notes.length > 0 ? <span className="pl-note">{notes.join(' · ')}</span> : null}
        </div>
      ) : null}
    </>
  )
}
