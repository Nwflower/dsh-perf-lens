// Presentation formatting shared by the table and the global bar.

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)}${units[unit]}`
}

export function formatPercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  const percent = share * 100
  return percent >= 10 ? `${percent.toFixed(1)}%` : `${percent.toFixed(2)}%`
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  return ms >= 10 ? `${ms.toFixed(0)}ms` : `${ms.toFixed(1)}ms`
}

/**
 * Absolute CPU cost: sampled CPU milliseconds per second of sampled wall time.
 *
 * This exists because `cpuShare` alone cannot be compared across hosts. Its
 * denominator is the ACTIVE sample count, so on a 93%-idle host (the norm) it
 * inflates every owner by ~15x: a package burning 1.3 ms/s shows as a 96% share
 * (see docs/design-overnight-analyzer.md §6.5). Absolute ms/s is the figure an
 * optimization decision can actually use, so the panel shows it next to share.
 */
export function cpuMsPerSecond(cpuMs: number, windowMs: number): number {
  if (!Number.isFinite(cpuMs) || !Number.isFinite(windowMs) || windowMs <= 0) return 0
  return cpuMs / (windowMs / 1000)
}

/** The same cost as a fraction of ONE core (0..1). */
export function cpuCoreShare(cpuMs: number, windowMs: number): number {
  if (!Number.isFinite(cpuMs) || !Number.isFinite(windowMs) || windowMs <= 0) return 0
  return cpuMs / windowMs
}

export function formatMsPerSecond(cpuMs: number, windowMs: number): string {
  const value = cpuMsPerSecond(cpuMs, windowMs)
  if (value <= 0) return '—'
  if (value >= 100) return `${value.toFixed(0)}ms/s`
  return value >= 10 ? `${value.toFixed(1)}ms/s` : `${value.toFixed(2)}ms/s`
}

export function formatOps(reads: number, writes: number): string {
  if (reads === 0 && writes === 0) return '—'
  return `${reads} / ${writes}`
}

/** Local HH:mm for trend-chart axis labels; date parts would drown a sparkline-scale axis. */
export function formatTimeOfDay(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '—'
  const date = new Date(epochMs)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
