// Coverage marker for partial metrics. Hard constraint 4: a value measured over
// a subset of call sites must never look as trustworthy as an exact one.

import { t } from './i18n'

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
      title={low ? t('coverageLowTitle', { percent, threshold: Math.round(threshold * 100) }) : undefined}
      className={low ? 'pl-cov pl-cov-low' : 'pl-cov'}
    >
      {percent}%{low ? ' ⚠' : ''}{label === undefined ? '' : ' ' + label}
    </span>
  )
}
