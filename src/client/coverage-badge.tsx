// Coverage marker for partial metrics. Hard constraint 4: a value measured over
// a subset of call sites must never look as trustworthy as an exact one.

export interface CoverageBadgeProps {
  readonly coverage: number
  readonly threshold: number
  readonly label?: string
}

export function CoverageBadge({ coverage, threshold, label }: CoverageBadgeProps) {
  const percent = Math.round(coverage * 100)
  const low = coverage < threshold
  return (
    <span
      title={low ? `覆盖不足：仅 ${percent}%（阈值 ${Math.round(threshold * 100)}%）` : undefined}
      style={{
        color: low ? 'var(--dsw-color-warning, #c98a00)' : 'inherit',
        opacity: low ? 1 : 0.7,
        whiteSpace: 'nowrap',
      }}
    >
      {percent}%{low ? ' ⚠' : ''}{label === undefined ? '' : ` ${label}`}
    </span>
  )
}
