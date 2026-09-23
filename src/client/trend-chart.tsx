// Multi-plugin CPU trend over recorded windows, in either cost base. Hand-drawn
// SVG, same reasoning as sparkline.tsx: the panel is one self-contained bundle
// and a chart library is weight we refuse to add for a single view.
//
// Data comes from the compact /api-perf/trend endpoint, not from raw history
// snapshots: the chart needs one value per plugin per point, and shipping full
// snapshots for a 200-plugin host cost ~22MB per poll.
//
// Two bases, because they answer different questions:
//   - share: share of ACTIVE samples. It is the shape view — good for "who
//     spiked when" — but on an idle host the denominator shrinks and every line
//     inflates (§6.5 of docs/design-overnight-analyzer.md).
//   - absolute: sampled CPU ms per second of sampled wall time. Comparable
//     across time and across hosts, so it is the default.
// Series SELECTION (the hide rule and the draw cap) always keys off the share
// peak: a plugin that never registered a meaningful share is not worth a line
// even when the absolute axis is showing.
//
// Readability rules: plugins whose share peak is below the threshold never
// draw; above that, only the top DRAW_LIMIT lines render and only the top
// LEGEND_LIMIT get legend chips. Everything dropped is counted in the footer
// note, and hovering pins a crosshair with a per-series tooltip.

import { useState } from 'react'
import type { PerfTrend } from '../shared/contract'
import { formatPercent, formatTimeOfDay } from './format'
import { displayOwner, t } from './i18n'
import { chartColor } from './palette'

/** Which cost base the chart plots. */
export type TrendMetric = 'share' | 'absolute'

export interface TrendChartProps {
  readonly trend: PerfTrend
  readonly hideThreshold: number
  readonly metric?: TrendMetric
}

export interface Series {
  readonly name: string
  readonly values: readonly number[]
}

/**
 * Whether every series carries the absolute basis.
 *
 * A host started before this field existed answers with `shares` only, and the
 * panel must keep working against it: an old host is a normal deployment state
 * (a rebuilt client is picked up by a page refresh, the host half needs a
 * restart). Without this check the absolute default reads `undefined` and takes
 * the whole board down.
 */
export function hasAbsoluteSeries(trend: PerfTrend): boolean {
  return trend.series.length > 0 && trend.series.every(item => Array.isArray(item.cpuMsPerSec))
}

/** Visible series in the requested base: the hide rule in one place. */
export function buildSeries(trend: PerfTrend, hideThreshold: number, metric: TrendMetric = 'share'): Series[] {
  return trend.series
    .filter(item => peakOf(item.shares) >= hideThreshold)
    .map(item => ({
      name: item.moduleName,
      values: metric === 'share' || !Array.isArray(item.cpuMsPerSec) ? item.shares : item.cpuMsPerSec,
    }))
}

/** How many series the trend held, before the hide rule. */
export function totalSeries(trend: PerfTrend): number {
  return trend.series.length
}

/** Series past this rank (peak-sorted by the host) aggregate into the note. */
export const DRAW_LIMIT = 12
/** Legend chips past this rank fold into the "more lines" note. */
export const LEGEND_LIMIT = 8

/** The lines the chart actually draws: hide rule, then the draw cap. */
export function drawnSeries(trend: PerfTrend, hideThreshold: number, metric: TrendMetric = 'share'): Series[] {
  return buildSeries(trend, hideThreshold, metric).slice(0, DRAW_LIMIT)
}

function peakOf(values: readonly number[] | undefined): number {
  if (!Array.isArray(values)) return 0
  let peak = 0
  for (const value of values) if (value > peak) peak = value
  return peak
}

/** Axis/tooltip/legend formatting for the active base. */
export function formatTrendValue(value: number, metric: TrendMetric): string {
  if (metric === 'share') return formatPercent(value)
  if (!Number.isFinite(value) || value <= 0) return '0ms/s'
  if (value >= 100) return value.toFixed(0) + 'ms/s'
  return value >= 10 ? value.toFixed(1) + 'ms/s' : value.toFixed(2) + 'ms/s'
}

/** Footer note parts: everything the chart dropped, honestly counted. */
export function hiddenNotes(trend: PerfTrend, hideThreshold: number): string[] {
  const notes: string[] = []
  const built = buildSeries(trend, hideThreshold).length
  if (totalSeries(trend) > built) notes.push(t('hiddenZero'))
  if (built > DRAW_LIMIT) notes.push(t('linesCapped'))
  return notes
}

const WIDTH = 660
const HEIGHT = 176
const PAD_LEFT = 38
const PAD_RIGHT = 10
const PAD_TOP = 10
const PAD_BOTTOM = 18
const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM
/** Rows in the hover tooltip; the cursor rarely asks about the 7th line. */
const TOOLTIP_ROWS = 6

export function TrendChart({ trend, hideThreshold, metric = 'absolute' }: TrendChartProps) {
  // Fall back to the share axis when the host did not send the absolute basis.
  const activeMetric: TrendMetric = metric === 'absolute' && hasAbsoluteSeries(trend) ? 'absolute' : 'share'
  const series = drawnSeries(trend, hideThreshold, activeMetric)
  const [hover, setHover] = useState<number | null>(null)
  if (trend.times.length < 2 || series.length === 0) {
    return <div className="pl-empty">{t('noTrend')}</div>
  }
  const count = trend.times.length
  const yMax = Math.max(...series.flatMap(item => [...item.values]), 0.01)
  const xAt = (index: number): number => PAD_LEFT + (count <= 1 ? 0 : (index / (count - 1)) * PLOT_WIDTH)
  const yAt = (value: number): number => PAD_TOP + PLOT_HEIGHT - (value / yMax) * PLOT_HEIGHT
  const points = (values: readonly number[]): string => values
    .map((value, index) => xAt(index).toFixed(1) + ',' + yAt(value).toFixed(1))
    .join(' ')

  const onMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const ratio = (event.clientX - rect.left) / rect.width
    const plotRatio = (ratio * WIDTH - PAD_LEFT) / PLOT_WIDTH
    const index = Math.round(plotRatio * (count - 1))
    setHover(Math.max(0, Math.min(count - 1, index)))
  }

  const hoverIndex = hover
  const hoverRows = hoverIndex === null ? [] : series
    .map((item, index) => ({ name: item.name, value: item.values[hoverIndex] ?? 0, color: chartColor(index) }))
    .sort((left, right) => right.value - left.value)
    .slice(0, TOOLTIP_ROWS)
  const notes = hiddenNotes(trend, hideThreshold)
  if (series.length > LEGEND_LIMIT) notes.push(t('moreLines', { n: series.length - LEGEND_LIMIT }))

  return (
    <div>
      <div
        className="pl-chart-wrap"
        onPointerMove={onMove}
        onPointerLeave={() => { setHover(null) }}
      >
        <svg
          className="pl-chart"
          viewBox={'0 0 ' + WIDTH + ' ' + HEIGHT}
          preserveAspectRatio="none"
          role="img"
          aria-label={t('trend')}
        >
          {[1, 0.5, 0].map(ratio => (
            <g key={ratio}>
              <line
                x1={PAD_LEFT} y1={yAt(yMax * ratio)} x2={WIDTH - PAD_RIGHT} y2={yAt(yMax * ratio)}
                stroke="currentColor" strokeOpacity={ratio === 0 ? 0.3 : 0.12}
              />
              <text x={4} y={yAt(yMax * ratio) + 3} fontSize="9" fill="currentColor" opacity="0.55">
                {formatTrendValue(yMax * ratio, activeMetric)}
              </text>
            </g>
          ))}
          <text x={PAD_LEFT} y={HEIGHT - 4} fontSize="9" fill="currentColor" opacity="0.55">
            {formatTimeOfDay(trend.times[0] ?? NaN)}
          </text>
          <text x={WIDTH - PAD_RIGHT} y={HEIGHT - 4} fontSize="9" fill="currentColor" opacity="0.55" textAnchor="end">
            {formatTimeOfDay(trend.times[count - 1] ?? NaN)}
          </text>
          {series.map((item, index) => (
            <polyline
              key={item.name}
              points={points(item.values)}
              fill="none"
              style={{ stroke: chartColor(index) }}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeOpacity={hoverIndex === null ? 0.9 : 0.35}
            />
          ))}
          {hoverIndex === null ? null : (
            <line
              x1={xAt(hoverIndex)} y1={PAD_TOP} x2={xAt(hoverIndex)} y2={PAD_TOP + PLOT_HEIGHT}
              stroke="currentColor" strokeOpacity="0.35" strokeDasharray="3 3"
            />
          )}
          {hoverIndex === null ? null : series.map((item, index) => (
            <circle
              key={item.name}
              cx={xAt(hoverIndex)}
              cy={yAt(item.values[hoverIndex] ?? 0)}
              r="2.4"
              style={{ fill: chartColor(index) }}
            />
          ))}
        </svg>
        {hoverIndex === null ? null : (
          <div
            className="pl-tip"
            style={{ left: Math.max(12, Math.min(88, (xAt(hoverIndex) / WIDTH) * 100)) + '%' }}
          >
            <div className="pl-tip-time">{formatTimeOfDay(trend.times[hoverIndex] ?? NaN)}</div>
            {hoverRows.map(row => (
              <div key={row.name} className="pl-tip-row">
                <span className="pl-legend-dot" style={{ background: row.color }} />
                <span className="pl-legend-name" style={{ maxWidth: '180px' }}>{displayOwner(row.name)}</span>
                <span>{formatTrendValue(row.value, activeMetric)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="pl-chart-legend">
        {series.slice(0, LEGEND_LIMIT).map((item, index) => (
          <span key={item.name} className="pl-chart-legend-item">
            <span className="pl-legend-dot" style={{ background: chartColor(index) }} />
            <span className="pl-chart-legend-name">{displayOwner(item.name)}</span>
            <span className="pl-legend-val">{t('peak')} {formatTrendValue(peakOf(item.values), activeMetric)}</span>
          </span>
        ))}
      </div>
      {notes.length === 0 ? null : <div className="pl-note" style={{ marginTop: '4px' }}>{notes.join(' · ')}</div>}
    </div>
  )
}
