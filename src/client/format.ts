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

export function formatOps(reads: number, writes: number): string {
  if (reads === 0 && writes === 0) return '—'
  return `${reads} / ${writes}`
}
