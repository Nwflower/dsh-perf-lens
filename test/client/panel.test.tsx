// The board renders the plugin table from the host snapshot and surfaces a
// failed poll instead of rendering a blank panel.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PerfApi } from '../../src/client/api'
import { setActiveLocale } from '../../src/client/i18n'
import { PerfPanel } from '../../src/client/panel'
import type { PerfControlRequest, PerfSnapshot, PerfStats, PerfTrend, SamplingConfig } from '../../src/shared/contract'
import { effectiveMode } from '../../src/shared/sampling'

const SNAPSHOT: PerfSnapshot = {
  windowStartedAt: 1,
  mode: 'duty',
  global: {
    rss: 1024 * 1024, heapUsed: 512 * 1024, heapTotal: 1024 * 1024, external: 0, arrayBuffers: 0,
    eventLoopLagP99Ms: 3, gcPauseMs: 1, fsOpsTotal: 5, sampleWindowMs: 5000, sampleCount: 100, idleSamples: 0, sampleIntervalMs: 0.5,
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
    vitals: vi.fn(async () => ({ latest: null, recent: [], jank: null, schedule: null })),
    postVitals: vi.fn(async () => ({ latest: null, recent: [], jank: null, schedule: null })),
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

  test('renders the jank attribution table with its coverage marker', async () => {
    const api = {
      ...apiOf(SNAPSHOT),
      vitals: vi.fn(async () => ({
        latest: { longTaskCount: 2, longTaskTotalMs: 120, rafGapP95Ms: 30, windowMs: 5000, at: 1 },
        recent: [],
        jank: {
          rows: [
            { owner: 'plugin:dsh-claude-style', durationMs: 40, forcedLayoutMs: 3, count: 2 },
            { owner: 'harness:@deepseek-ai/dsh-client-ui-chat', durationMs: 20, forcedLayoutMs: 0, count: 1 },
            { owner: 'unresolved', durationMs: 10, forcedLayoutMs: 0, count: 1 },
          ],
          attributedShare: 0.6,
        },
        schedule: null,
      })),
    }
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(screen.getByText('dsh-claude-style')).toBeTruthy() })
    // Harness sub-packages fold into the board's one harness row.
    expect(screen.getAllByText('harness 内置').length).toBeGreaterThan(0)
    expect(screen.getByText('未能归因')).toBeTruthy()
    expect(screen.getByText(/已归因 60%/)).toBeTruthy()
    // The correlation disclaimer only shows when there is nothing attributable.
    expect(screen.queryByText(/时间相关不等于因果/)).toBeNull()
  })

  test('shows the correlation disclaimer when the window has no attributable scripts', async () => {
    // The desktop window's browser withholds LoAF script entries entirely, so
    // resolved rows come back empty; the card must say what that means.
    const api = {
      ...apiOf(SNAPSHOT),
      vitals: vi.fn(async () => ({
        latest: { longTaskCount: 2, longTaskTotalMs: 120, rafGapP95Ms: 30, windowMs: 5000, at: 1 },
        recent: [],
        jank: { rows: [], attributedShare: 1 },
        schedule: null,
      })),
    }
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(screen.getByText(/时间相关不等于因果/)).toBeTruthy() })
    expect(screen.queryByText('未能归因')).toBeNull()
  })

  test('renders the scheduler table with its registrar coverage line', async () => {
    const api = {
      ...apiOf(SNAPSHOT),
      vitals: vi.fn(async () => ({
        latest: { longTaskCount: 2, longTaskTotalMs: 120, rafGapP95Ms: 30, windowMs: 5000, at: 1 },
        recent: [],
        jank: { rows: [], attributedShare: 1 },
        schedule: {
          rows: [
            { owner: 'plugin:dsh-claude-style', scheduledMs: 60.5, calls: 365, maxMs: 0.7 },
            { owner: 'harness:@deepseek-ai/dsh-client-ui-chat', scheduledMs: 2, calls: 4, maxMs: 0.5 },
            { owner: 'unresolved', scheduledMs: 1, calls: 1, maxMs: 1 },
          ],
          attributedShare: 0.98,
          contract: 'ok' as const,
        },
      })),
    }
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(screen.getByText('主线程调度（按注册位置）')).toBeTruthy() })
    expect(screen.getAllByText('dsh-claude-style').length).toBeGreaterThan(0)
    expect(screen.getAllByText('harness 内置').length).toBeGreaterThan(0)
    expect(screen.getByText('未能归因')).toBeTruthy()
    expect(screen.getByText(/已归因 98%/)).toBeTruthy()
    // The registrar basis is stated, not implied.
    expect(screen.getByText('回调耗时 (ms)')).toBeTruthy()
  })

  test('withholds scheduler rows when the probe self-test reports a mismatch', async () => {
    // An offset mismatch means the rows describe a row the browser is not
    // running, so the table must disappear rather than show plausible numbers.
    const api = {
      ...apiOf(SNAPSHOT),
      vitals: vi.fn(async () => ({
        latest: { longTaskCount: 0, longTaskTotalMs: 0, rafGapP95Ms: 8, windowMs: 5000, at: 1 },
        recent: [],
        jank: null,
        schedule: {
          rows: [{ owner: 'plugin:dsh-claude-style', scheduledMs: 99, calls: 9, maxMs: 9 }],
          attributedShare: 1,
          contract: 'mismatch' as const,
        },
      })),
    }
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(screen.getByText(/探针自检不一致/)).toBeTruthy() })
    expect(screen.queryByText('回调耗时 (ms)')).toBeNull()
    expect(screen.queryByText('dsh-claude-style')).toBeNull()
  })

  test('says the probe is off rather than showing an empty table', async () => {
    const api = {
      ...apiOf(SNAPSHOT),
      vitals: vi.fn(async () => ({
        latest: { longTaskCount: 0, longTaskTotalMs: 0, rafGapP95Ms: 8, windowMs: 5000, at: 1 },
        recent: [],
        jank: null,
        schedule: { rows: [], attributedShare: 1, contract: 'ok' as const },
      })),
    }
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(screen.getByText('探针未开启')).toBeTruthy() })
    expect(screen.queryByText('回调耗时 (ms)')).toBeNull()
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
      vitals: vi.fn(async () => ({ latest: null, recent: [], jank: null, schedule: null })),
      postVitals: vi.fn(async () => ({ latest: null, recent: [], jank: null, schedule: null })),
    }
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(screen.getByText(/boom/)).toBeTruthy() })
  })
})

describe('sampling controls', () => {
  /** A snapshot whose mode matches its config, the way a real host sends it. */
  const withSampling = (over: Partial<SamplingConfig> = {}): PerfSnapshot => {
    const sampling: SamplingConfig = { intensity: 'low', background: false, memory: false, ...over }
    return { ...SNAPSHOT, mode: effectiveMode(sampling), sampling }
  }
  const pressed = (name: string): string | null =>
    screen.getByRole('button', { name }).getAttribute('aria-pressed')
  /** A host that answers both endpoints with the config it currently holds. */
  const echoApi = (start: PerfSnapshot): PerfApi => {
    let current = start.sampling ?? { intensity: 'low', background: false, memory: false } as SamplingConfig
    return {
      ...apiOf(start),
      // The poll has to report the live config too: a control change alters the
      // poll cadence, which re-runs the polling effect and fires a snapshot read
      // straight away.
      snapshot: vi.fn(async () => withSampling(current)),
      control: vi.fn(async (body: PerfControlRequest) => {
        current = {
          intensity: body.intensity ?? current.intensity,
          background: body.background ?? current.background,
          memory: body.memory ?? current.memory,
        }
        return withSampling(current)
      }),
    }
  }

  test('renders the three blocks from what the host reports', async () => {
    // The panel used to keep the memory switch in local state, so a reload drew
    // every control off while the host was still sampling.
    render(<PerfPanel api={apiOf(withSampling({ intensity: 'high', background: true, memory: true }))} />)
    await waitFor(() => { expect(pressed('高采样')).toBe('true') })
    expect(pressed('停止采样')).toBe('false')
    expect(pressed('低采样')).toBe('false')
    expect(pressed('后台采样')).toBe('true')
    expect(pressed('内存采样')).toBe('true')
  })

  test('falls back to the mode, and says so, when an older host sends no config', async () => {
    // SNAPSHOT carries no `sampling`, exactly like a record replayed from disk.
    // Such a host also predates the fields these controls send, so a live-looking
    // button would silently do nothing (the bug this guard exists for).
    const api = apiOf(SNAPSHOT)
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(pressed('低采样')).toBe('true') })
    expect(pressed('后台采样')).toBe('false')
    expect(pressed('内存采样')).toBe('false')
    expect(screen.getByText(/重启主机/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '高采样' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '高采样' }))
    expect(api.control).not.toHaveBeenCalled()
  })

  test('sends one block per click, and follows the host back', async () => {
    const api = echoApi(withSampling())
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(pressed('低采样')).toBe('true') })

    fireEvent.click(screen.getByRole('button', { name: '停止采样' }))
    await waitFor(() => { expect(api.control).toHaveBeenCalledWith({ intensity: 'paused' }) })
    await waitFor(() => { expect(pressed('停止采样')).toBe('true') })

    // Stopped plus background sampling: the switch is what keeps a record going,
    // so the chip beside the title reports the background profile, not "stopped".
    fireEvent.click(screen.getByRole('button', { name: '后台采样' }))
    await waitFor(() => { expect(api.control).toHaveBeenCalledWith({ background: true }) })
    await waitFor(() => { expect(pressed('后台采样')).toBe('true') })
    expect(screen.getAllByText('后台采样').length).toBeGreaterThan(1)

    fireEvent.click(screen.getByRole('button', { name: '内存采样' }))
    await waitFor(() => { expect(api.control).toHaveBeenCalledWith({ memory: true }) })
    await waitFor(() => { expect(pressed('内存采样')).toBe('true') })
    // Memory sampling is the one option that costs extra; the panel says so.
    expect(screen.getByText(/内存采样已开/)).toBeTruthy()
  })

  test('turning memory sampling off asks the host for the same thing', async () => {
    const api = echoApi(withSampling({ memory: true }))
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(pressed('内存采样')).toBe('true') })
    fireEvent.click(screen.getByRole('button', { name: '内存采样' }))
    await waitFor(() => { expect(api.control).toHaveBeenCalledWith({ memory: false }) })
  })
})
