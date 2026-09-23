// Board grouping: turn a flat per-owner row list into the few sections a human
// can scan.
//
// Two problems this solves. Harness internals (`harness:@deepseek-ai/dsh-*`) are
// one product, not a hundred rows. And most installed plugins are idle in any
// given window, so a flat list buries the handful that actually cost something
// under a wall of zeros.

import type { PluginMetricRow } from './contract'

export type PluginGroupId = 'external' | 'harness' | 'runtime' | 'self' | 'other'

export interface PluginGroup {
  readonly id: PluginGroupId
  /** Rows that showed cost in the window, in the order they arrived. */
  readonly rows: readonly PluginMetricRow[]
  /** Rows with no measurable cost; the board collapses these behind a count. */
  readonly staticRows: readonly PluginMetricRow[]
}

/** Which section an owner belongs to. */
export function groupIdOf(moduleName: string): PluginGroupId {
  if (moduleName === 'runtime' || moduleName.startsWith('runtime:')) return 'runtime'
  if (moduleName === 'self') return 'self'
  if (moduleName === 'harness' || moduleName.startsWith('harness:')) return 'harness'
  if (moduleName === 'unattributed' || moduleName === 'idle') return 'other'
  return 'external'
}

/**
 * A row with no CPU, no live heap, no file operations and no allocation rate.
 *
 * This is a per-window judgement, not a permanent label: a plugin that is idle
 * now appears in the static fold and moves back out the moment it does work.
 */
export function isStaticRow(row: PluginMetricRow): boolean {
  return row.cpuShare === 0
    && row.cpuSelfMs === 0
    && row.liveHeapBytes === 0
    && row.fsReadOps === 0
    && row.fsWriteOps === 0
    && row.allocBytesPerSec === 0
}

/** Section order, most actionable first. */
export const GROUP_ORDER: readonly PluginGroupId[] = ['external', 'harness', 'runtime', 'self', 'other']

/** Group rows into sections; empty sections are dropped. */
export function groupRows(rows: readonly PluginMetricRow[]): PluginGroup[] {
  const buckets = new Map<PluginGroupId, { rows: PluginMetricRow[]; staticRows: PluginMetricRow[] }>()
  for (const id of GROUP_ORDER) buckets.set(id, { rows: [], staticRows: [] })
  for (const row of rows) {
    const bucket = buckets.get(groupIdOf(row.moduleName))
    if (bucket === undefined) continue
    if (isStaticRow(row)) bucket.staticRows.push(row)
    else bucket.rows.push(row)
  }
  const groups: PluginGroup[] = []
  for (const id of GROUP_ORDER) {
    const bucket = buckets.get(id)
    if (bucket === undefined) continue
    if (bucket.rows.length === 0 && bucket.staticRows.length === 0) continue
    groups.push({ id, rows: bucket.rows, staticRows: bucket.staticRows })
  }
  return groups
}

/** Total CPU share of the non-static rows in a group, 0..1. */
export function groupShareOf(group: PluginGroup): number {
  let sum = 0
  for (const row of group.rows) sum += row.cpuShare
  return sum
}
