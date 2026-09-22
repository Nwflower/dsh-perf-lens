// Inline SVG sparkline. Deliberately no chart library: the panel ships a single
// self-contained bundle and every extra dependency is weight in the host page.

export interface SparklineProps {
  readonly values: readonly number[]
  readonly width?: number
  readonly height?: number
}

export function Sparkline({ values, width = 72, height = 18 }: SparklineProps) {
  if (values.length < 2) return <span style={{ opacity: 0.4 }}>—</span>
  const max = Math.max(...values, Number.EPSILON)
  const step = width / (values.length - 1)
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}
