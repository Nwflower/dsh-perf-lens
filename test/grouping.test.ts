// Grouping rules: harness folds, external plugins stay separate, and idle rows
// move into the static fold.

import { describe, expect, test } from 'vitest'
import { groupIdOf, groupRows, groupShareOf, isStaticRow } from '../src/shared/grouping'
import type { PluginMetricRow } from '../src/shared/contract'

function row(moduleName: string, overrides: Partial<PluginMetricRow> = {}): PluginMetricRow {
  return {
    moduleName, entryId: moduleName, fiberPhase: 'active', cpuShare: 0, cpuSelfMs: 0,
    liveHeapBytes: 0, allocBytesPerSec: 0, fsReadOps: 0, fsWriteOps: 0,
    fsReadBytes: 0, fsWriteBytes: 0, coverage: 0, timers: 0, listeners: 0, handles: 0,
    diskFootprintBytes: 0, ...overrides,
  }
}

describe('groupIdOf', () => {
  test('classifies each owner family', () => {
    expect(groupIdOf('dsh-context')).toBe('external')
    expect(groupIdOf('harness')).toBe('harness')
    expect(groupIdOf('harness:@deepseek-ai/dsh-client-hmr')).toBe('harness')
    expect(groupIdOf('runtime')).toBe('runtime')
    expect(groupIdOf('runtime:gc')).toBe('runtime')
    expect(groupIdOf('runtime:node')).toBe('runtime')
    expect(groupIdOf('self')).toBe('self')
    expect(groupIdOf('unattributed')).toBe('other')
  })
})

describe('isStaticRow', () => {
  test('only a row with no cost at all is static', () => {
    expect(isStaticRow(row('a'))).toBe(true)
    expect(isStaticRow(row('a', { cpuShare: 0.001 }))).toBe(false)
    expect(isStaticRow(row('a', { liveHeapBytes: 1024 }))).toBe(false)
    expect(isStaticRow(row('a', { fsReadOps: 1 }))).toBe(false)
  })
})

describe('groupRows', () => {
  test('separates active rows from the static fold and drops empty sections', () => {
    const groups = groupRows([
      row('dsh-context', { cpuShare: 0.4 }),
      row('idle-plugin'),
      row('harness', { cpuShare: 0.2 }),
      row('runtime', { cpuShare: 0.1 }),
    ])
    expect(groups.map(group => group.id)).toEqual(['external', 'harness', 'runtime'])
    const external = groups[0]
    expect(external?.rows.map(item => item.moduleName)).toEqual(['dsh-context'])
    expect(external?.staticRows.map(item => item.moduleName)).toEqual(['idle-plugin'])
    if (external !== undefined) expect(groupShareOf(external)).toBeCloseTo(0.4, 10)
  })

  test('a section with only static rows is still shown', () => {
    const groups = groupRows([row('self')])
    expect(groups.map(group => group.id)).toEqual(['self'])
    expect(groups[0]?.rows).toHaveLength(0)
    expect(groups[0]?.staticRows).toHaveLength(1)
  })
})
