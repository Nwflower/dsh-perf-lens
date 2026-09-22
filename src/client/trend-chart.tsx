// Multi-plugin CPU-share trend over recorded windows. Hand-drawn SVG, same
// reasoning as sparkline.tsx: the panel is one self-contained bundle and a
// chart library is weight we refuse to add for a single view.
//
// Data comes from the compact /api-perf/trend endpoint, not from raw history
// snapshots: the chart needs one share per plugin per point, and shipping full
// snapshots for a 200-plugin host cost ~22MB per poll.
//
// Plugins whose peak share over the range is below the threshold are dropped:
// a host with dozens of installed plugins would otherwise draw a stack of flat
// zero lines that answer nothing.

import type { PerfTrend } from '../shared/contract'
import { formatPercent, formatTimeOfDay } from './format'
import { t } from './i18n'

/** Stable line colors; wraps if there are more visible plugins than entries. */
const PALETTE = ['#4f8cff', '#ff8a4f', '#41c98a', '#c061ff', '#ffd24f', '#ff5d7a', '#4fd8e0', '#9aa0a6']

export interface TrendChartProps {
  readonly trend: PerfTrend
  readonly hideThreshold: number
  width?: number
  height?: number
}

export interface Series {
  readonly name: string
  readonly values: readonly number[]
}

/** Visible series only: the hide rule in one place, testable without a DOM. */
export function buildSeries(trend: PerfTrend, hideThreshold: number): Series[] {
  return trend.series
    .filter(item => peakOf(item.shares) >= hideThreshold)
    .map(item => ({ name: item.moduleName, values: item.shares }))
}

/** How many series the trend held, before the hide rule. */
export function totalSeries(trend: PerfTrend): number {
  return trend.series.length
}

function peakOf(values: readonly number[]): number {
  let peak = 0
  for (const value of values) if (value > peak) peak = value
  return peak
}

export function TrendChart({ trend, hideThreshold, width = 660, height = 170 }: TrendChartProps) {
  const series = buildSeries(trend, hideThreshold)
  if (trend.times.length < 2 || series.length === 0) {
    return <div style={{ opacity: 0.6 }}>{t('noTrend')}</div>
  }
  const padLeft = 34
  const padRight = 8
  const padTop = 8
  const padBottom = 16
  const plotWidth = width - padLeft - padRight
  const plotHeight = height - padTop - padBottom
  const yMax = Math.max(...series.flatMap(item => [...item.values]), 0.01)
  const points = (values: readonly number[]): string => values
    .map((value, index) => {
      const x = padLeft + (values.length <= 1 ? 0 : (index / (values.length - 1)) * plotWidth)
      const y = padTop + plotHeight - (value / yMax) * plotHeight
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const firstAt = trend.times[0]
  const lastAt = trend.times[trend.times.length - 1]
  return (
    <div style={{ display: 'grid', gap: '4px' }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('trend')}>
        <line x1={padLeft} y1={padTop} x2={padLeft} y2={padTop + plotHeight} stroke="currentColor" strokeOpacity="0.25" />
        <line x1={padLeft} y1={padTop + plotHeight} x2={width - padRight} y2={padTop + plotHeight} stroke="currentColor" strokeOpacity="0.25" />
        <text x={4} y={padTop + 8} fontSize="9" fill="currentColor" opacity="0.7">{formatPercent(yMax)}</text>
        <text x={4} y={padTop + plotHeight} fontSize="9" fill="currentColor" opacity="0.7">0%</text>
        <text x={padLeft} y={height - 4} fontSize="9" fill="currentColor" opacity="0.7">
          {formatTimeOfDay(firstAt ?? NaN)}
        </text>
        <text x={width - padRight} y={height - 4} fontSize="9" fill="currentColor" opacity="0.7" textAnchor="end">
          {formatTimeOfDay(lastAt ?? NaN)}
        </text>
        {series.map((item, index) => (
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
        {series.map((item, index) => (
          <span key={item.name} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ width: '9px', height: '9px', borderRadius: '2px', background: PALETTE[index % PALETTE.length] }} />
            {item.name} · {t('peak')} {formatPercent(peakOf(item.values))}
          </span>
        ))}
      </div>
      {totalSeries(trend) > series.length ? <div style={{ opacity: 0.55, fontSize: '11px' }}>{t('hiddenZero')}</div> : null}
    </div>
  )
}
