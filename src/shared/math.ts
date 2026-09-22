// Small shared numeric helpers. Percentiles are needed on both sides: the host
// aggregates window history, the client summarizes foreground frame gaps.

/** Nearest-rank percentile of an already sorted ascending array, 0..1. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil(fraction * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index] ?? 0
}
