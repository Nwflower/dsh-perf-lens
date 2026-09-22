// Multi-plugin CPU-share trend over recorded windows. Hand-drawn SVG, same
// reasoning as sparkline.tsx: the panel is one self-contained bundle and a
// chart library is weight we refuse to add for a single view.
//
// Plugins whose peak share over the range is below the threshold are dropped:
// a host with dozens of installed plugins would otherwise draw a stack of flat
// zero lines that answer nothing.

import type { PerfSnapshot } from '../shared/contract'
import { formatPercent, formatTimeOfDay } from './format'
import { t } from './i18n'

/** Stable line colors; wraps if there are more visible plugins than entries. */
const PALETTE = ['#4f8cff', '#ff8a4f', '#41c98a', '#c061ff', '#ffd24f', '#ff5d7a', '#4fd8e0', '#9aa0a6']

export interface TrendChartProps {
  readonly snapshots: readonly PerfSnapshot[]
  readonly hideThreshold: number
  readonly width?: number
  readonly height?: number
}

interface Series {
  readonly name: string
  readonly values: readonly number[]
}

/** One value per window, zero-filled when the plugin had no row that window. */
export function buildSeries(snapshots: readonly PerfSnapshot[]): Series[] {
  const ordered = [...snapshots].sort((a, b) => a.windowStartedAt - b.windowStartedAt)
  const names = new Set<string>()
  for (const snapshot of ordered) for (const row of snapshot.plugins) names.add(row.moduleName)
  return [...names].map(name => ({
    name,
    values: ordered.map(snapshot => snapshot.plugins.find(row => row.moduleName === name)?.cpuShare ?? 0),
  }))
}

export function TrendChart({ snapshots, hideThreshold, width = 660, height = 170 }: TrendChartProps) {
  const ordered = [...snapshots].sort((a, b) => a.windowStartedAt - b.windowStartedAt)
  const series = buildSeries(ordered)
  const visible = series.filter(item => Math.max(...item.values, 0) >= hideThreshold)
  if (snapshots.length < 2 || visible.length === 0) {
    return <div style={{ opacity: 0.6 }}>{t('noTrend')}</div>
  }
  const padLeft = 34
  const padRight = 8
  const padTop = 8
  const padBottom = 16
  const plotWidth = width - padLeft - padRight
  const plotHeight = height - padTop - padBottom
  const yMax = Math.max(...visible.flatMap(item => [...item.values]), 0.01)
  const points = (values: readonly number[]): string => values
    .map((value, index) => {
      const x = padLeft + (values.length <= 1 ? 0 : (index / (values.length - 1)) * plotWidth)
      const y = padTop + plotHeight - (value / yMax) * plotHeight
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <div style={{ display: 'grid', gap: '4px' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('trend')}>
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={padTop + plotHeight} stroke="currentColor" strokeOpacity="0.25" />
        <line x1={padLeft} y1={padTop + plotHeight} x2={width - padRight} y2={padTop + plotHeight} stroke="currentColor" strokeOpacity="0.25" />
        <text x={4} y={padTop + 8} fontSize="9" fill="currentColor" opacity="0.7">{formatPercent(yMax)}</text>
        <text x={4} y={padTop + plotHeight} fontSize="9" fill="currentColor" opacity="0.7">0%</text>
        <text x={padLeft} y={height - 4} fontSize="9" fill="currentColor" opacity="0.7">
          {formatTimeOfDay(ordered[0]?.windowStartedAt ?? NaN)}
        </text>
        <text x={width - padRight} y={height - 4} fontSize="9" fill="currentColor" opacity="0.7" textAnchor="end">
          {formatTimeOfDay(ordered[ordered.length - 1]?.windowStartedAt ?? NaN)}
        </text>
        {visible.map((item, index) => (
          <polyline
            key={item.name}
            points={points(item.values)}
            fill="none"
            stroke={PALETTE[index % PALETTE.length]}
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        ))}
      </svg>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '11px' }}>
        {visible.map((item, index) => (
          <span key={item.name} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: '9px', height: '9px', borderRadius: '2px', background: PALETTE[index % PALETTE.length] }} />
            {item.name} · {t('peak')} {formatPercent(Math.max(...item.values, 0))}
          </span>
        ))}
      </div>
      {series.length > visible.length ? <div style={{ opacity: 0.55, fontSize: '11px' }}>{t('hiddenZero')}</div> : null}
    </div>
  )
}
