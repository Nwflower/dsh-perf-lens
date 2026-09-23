// Categorical series colors shared by the trend chart and the composition
// bars. The values are CSS custom properties defined on .pl-root (styles/
// panel.css) so both surfaces agree on "plugin #n is this color" and the
// palette can be re-tinted from the stylesheet without touching components.
// Eight slots cycle; charts cap their drawn series near this count anyway.

export const CHART_COLORS: readonly string[] = [
  'var(--pl-c1)',
  'var(--pl-c2)',
  'var(--pl-c3)',
  'var(--pl-c4)',
  'var(--pl-c5)',
  'var(--pl-c6)',
  'var(--pl-c7)',
  'var(--pl-c8)',
]

/** Aggregate bucket color ("other plugins"), quieter than any single series. */
export const REST_COLOR = 'var(--pl-rest)'
/** Unattributed/self bookkeeping slices. */
export const UNATTRIBUTED_COLOR = 'var(--pl-unattr)'
/** Remainder slice (idle / unsampled / free heap). */
export const FREE_COLOR = 'var(--pl-free)'

export function chartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] ?? 'var(--pl-c8)'
}
