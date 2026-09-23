// The scoreboard ranks only plugins that burned CPU, caps the list, and never
// prints a whole-range estimate that is mostly multiplier.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { setActiveLocale } from '../../src/client/i18n'
import { estimateShown, rankedRows, Scoreboard } from '../../src/client/scoreboard'
import type { PerfStats, PluginStatsRow } from '../../src/shared/contract'

function statsRow(moduleName: string, cumulativeCpuMs: number, coverage: number): PluginStatsRow {
  return {
    moduleName, avgCpuShare: 0.1, peakCpuShare: 0.2, p95CpuShare: 0.15,
    cumulativeCpuMs, estimatedCpuMs: coverage > 0 ? cumulativeCpuMs / coverage : cumulativeCpuMs, coverage, windows: 1,
  }
}

/** `busy` plugins with descending CPU, then `idle` plugins that burned none. */
function stats(busy: number, idle: number, coverage = 0.1): PerfStats {
  const plugins: PluginStatsRow[] = []
  for (let index = 0; index < busy; index += 1) plugins.push(statsRow('busy-' + index, 1000 - index, coverage))
  for (let index = 0; index < idle; index += 1) plugins.push(statsRow('idle-' + index, 0, coverage))
  return { range: '24h', since: 0, windowCount: 10, sampledWindowMs: 50_000, coverage, plugins }
}

afterEach(() => { cleanup(); setActiveLocale('zh') })

describe('rankedRows', () => {
  test('keeps plugins with sampled CPU, in the host order', () => {
    expect(rankedRows(stats(3, 5)).map(row => row.moduleName)).toEqual(['busy-0', 'busy-1', 'busy-2'])
  })
})

describe('estimateShown', () => {
  test('hides the estimate below the coverage floor', () => {
    // 1.5% coverage was the live-host case: a 68x scale-up.
    expect(estimateShown(stats(1, 0, 0.015))).toBe(false)
    expect(estimateShown(stats(1, 0, 0.14))).toBe(true)
  })
})

describe('Scoreboard', () => {
  test('lists the top plugins and counts the idle ones instead of listing them', () => {
    setActiveLocale('en')
    const { container } = render(<Scoreboard stats={stats(3, 200)} />)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(screen.queryByText('idle-0')).toBeNull()
    expect(screen.getByText(/200 more plugins had no sampled CPU/)).toBeTruthy()
  })

  test('caps the list and toggles the rest in', () => {
    setActiveLocale('en')
    const { container } = render(<Scoreboard stats={stats(25, 0)} limit={10} />)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(10)
    fireEvent.click(screen.getByText('Show all 25'))
    expect(container.querySelectorAll('tbody tr')).toHaveLength(25)
    fireEvent.click(screen.getByText('Show top 10'))
    expect(container.querySelectorAll('tbody tr')).toHaveLength(10)
  })

  test('shows no toggle when everything fits', () => {
    setActiveLocale('en')
    render(<Scoreboard stats={stats(3, 0)} limit={10} />)
    expect(screen.queryByText(/Show all/)).toBeNull()
  })

  test('prints a dash and the reason when coverage is too thin for an estimate', () => {
    setActiveLocale('en')
    render(<Scoreboard stats={stats(1, 0, 0.015)} />)
    expect(screen.queryByText(/^≈/)).toBeNull()
    expect(screen.getByText(/covered only 1\.50% of this range; a whole-range estimate would be a 67x/)).toBeTruthy()
  })

  test('prints the estimate when coverage supports it', () => {
    render(<Scoreboard stats={stats(1, 0, 0.1)} />)
    expect(screen.getByText('≈ 10.00s')).toBeTruthy()
  })

  test('says so when nothing was sampled', () => {
    setActiveLocale('en')
    render(<Scoreboard stats={stats(0, 4)} />)
    expect(screen.getByText('No CPU sampled in this range yet')).toBeTruthy()
  })
})
