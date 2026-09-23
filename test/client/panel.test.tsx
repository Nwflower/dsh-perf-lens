// The board renders the plugin table from the host snapshot and surfaces a
// failed poll instead of rendering a blank panel.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PerfApi } from '../../src/client/api'
import { setActiveLocale } from '../../src/client/i18n'
import { PerfPanel } from '../../src/client/panel'
import type { PerfSnapshot, PerfStats, PerfTrend } from '../../src/shared/contract'

const SNAPSHOT: PerfSnapshot = {
  windowStartedAt: 1,
  mode: 'duty',
  global: {
    rss: 1024 * 1024, heapUsed: 512 * 1024, heapTotal: 1024 * 1024, external: 0, arrayBuffers: 0,
    eventLoopLagP99Ms: 3, gcPauseMs: 1, fsOpsTotal: 5, sampleWindowMs: 5000, sampleCount: 100, idleSamples: 0,
  },
  plugins: [{
    moduleName: 'pluginA', entryId: 'a', fiberPhase: 'active',
    cpuShare: 0.5, cpuSelfMs: 10, liveHeapBytes: 2048, allocBytesPerSec: 0,
    fsReadOps: 2, fsWriteOps: 1, fsReadBytes: 0, fsWriteBytes: 0, coverage: 0,
    timers: 0, listeners: 0, handles: 0, diskFootprintBytes: 0,
  }],
  unattributedShare: 0,
  selfShare: 0,
}

const STATS: PerfStats = {
  range: '24h', since: 0, windowCount: 1, sampledWindowMs: 5000, coverage: 0.1,
  plugins: [{
    moduleName: 'pluginA', avgCpuShare: 0.5, peakCpuShare: 0.5, p95CpuShare: 0.5,
    cumulativeCpuMs: 10, estimatedCpuMs: 100, coverage: 0.1, windows: 1,
  }],
}

const TREND: PerfTrend = {
  range: '24h', since: 0, times: [1000, 2000], windowCount: 2,
  series: [{ moduleName: 'pluginA', shares: [0.4, 0.5], cpuMsPerSec: [4, 5] }],
}

function apiOf(snapshot: PerfSnapshot): PerfApi {
  return {
    snapshot: vi.fn(async () => snapshot),
    control: vi.fn(async () => snapshot),
    history: vi.fn(async () => [snapshot]),
    stats: vi.fn(async () => STATS),
    trend: vi.fn(async () => TREND),
    hotspots: vi.fn(async () => ({ plugin: 'pluginA', hotspots: null })),
    vitals: vi.fn(async () => ({ latest: null, recent: [] })),
    postVitals: vi.fn(async () => ({ latest: null, recent: [] })),
  }
}

// Module-level locale state: restore the default so one test's language switch
// cannot leak into the next.
afterEach(() => { cleanup(); setActiveLocale('zh') })

describe('PerfPanel', () => {
  test('renders the plugin row after the first poll', async () => {
    render(<PerfPanel api={apiOf(SNAPSHOT)} />)
    // pluginA now appears in the live table, the trend legend and the scoreboard.
    await waitFor(() => { expect(screen.getAllByText('pluginA').length).toBeGreaterThan(0) })
    expect(screen.getAllByText('50.0%').length).toBeGreaterThan(0)
  })

  test('renders against a host that predates the absolute trend basis', async () => {
    // A rebuilt client is picked up by a page refresh while the host half may
    // still be the previous build: /trend then answers with `shares` only. The
    // absolute axis is the chart's default, so an unguarded read here used to
    // take the whole board down.
    const stale: PerfTrend = {
      range: '24h', since: 0, times: [1000, 2000], windowCount: 2,
      series: [{ moduleName: 'pluginA', shares: [0.4, 0.5] } as unknown as PerfTrend['series'][number]],
    }
    const api = { ...apiOf(SNAPSHOT), trend: vi.fn(async () => stale) }
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(screen.getAllByText('pluginA').length).toBeGreaterThan(0) })
    // No absolute basis on the wire means no basis switch is offered (the
    // metrics table's own 绝对 column is a different thing and stays).
    expect(screen.queryByLabelText('趋势口径')).toBeNull()
  })

  test('renders the English dictionary after a locale switch', async () => {
    setActiveLocale('en')
    render(<PerfPanel api={apiOf(SNAPSHOT)} />)
    await waitFor(() => { expect(screen.getAllByText('Process overview').length).toBeGreaterThan(0) })
    expect(screen.getByText('Perf Lens')).toBeTruthy()
    expect(screen.getAllByText('Top consumers').length).toBeGreaterThan(0)
  })

  test('refreshes the range aggregates only after the host records a new window', async () => {
    vi.useFakeTimers()
    try {
      let current: PerfSnapshot = SNAPSHOT
      const api = { ...apiOf(SNAPSHOT), snapshot: vi.fn(async () => current) }
      render(<PerfPanel api={api} />)
      // Mount fetches once; the first slow tick catches up with the window the
      // first snapshot poll reported.
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      const settled = vi.mocked(api.stats).mock.calls.length
      expect(settled).toBeLessThanOrEqual(2)
      // Three more slow ticks with the same recorded window: nothing new to
      // aggregate, so no request (each one used to cost the host a full
      // history re-parse).
      await act(async () => { await vi.advanceTimersByTimeAsync(45_000) })
      expect(api.stats).toHaveBeenCalledTimes(settled)
      current = { ...SNAPSHOT, windowStartedAt: 2 }
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(api.stats).toHaveBeenCalledTimes(settled + 1)
      expect(api.trend).toHaveBeenCalledTimes(settled + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('surfaces a failed poll', async () => {
    const api: PerfApi = {
      snapshot: vi.fn(async () => { throw new Error('boom') }),
      control: vi.fn(async () => SNAPSHOT),
      history: vi.fn(async () => []),
      stats: vi.fn(async () => STATS),
      trend: vi.fn(async () => TREND),
      hotspots: vi.fn(async () => ({ plugin: 'pluginA', hotspots: null })),
      vitals: vi.fn(async () => ({ latest: null, recent: [] })),
      postVitals: vi.fn(async () => ({ latest: null, recent: [] })),
    }
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(screen.getByText(/boom/)).toBeTruthy() })
  })
})
