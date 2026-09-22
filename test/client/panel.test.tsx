// The board renders the plugin table from the host snapshot and surfaces a
// failed poll instead of rendering a blank panel.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PerfApi } from '../../src/client/api'
import { PerfPanel } from '../../src/client/panel'
import type { PerfSnapshot, PerfStats } from '../../src/shared/contract'

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

function apiOf(snapshot: PerfSnapshot): PerfApi {
  return {
    snapshot: vi.fn(async () => snapshot),
    control: vi.fn(async () => snapshot),
    history: vi.fn(async () => [snapshot]),
    stats: vi.fn(async () => STATS),
  }
}

afterEach(cleanup)

describe('PerfPanel', () => {
  test('renders the plugin row after the first poll', async () => {
    render(<PerfPanel api={apiOf(SNAPSHOT)} />)
    // pluginA now appears in the live table, the trend legend and the scoreboard.
    await waitFor(() => { expect(screen.getAllByText('pluginA').length).toBeGreaterThan(0) })
    expect(screen.getAllByText('50.0%').length).toBeGreaterThan(0)
  })

  test('surfaces a failed poll', async () => {
    const api: PerfApi = {
      snapshot: vi.fn(async () => { throw new Error('boom') }),
      control: vi.fn(async () => SNAPSHOT),
      history: vi.fn(async () => []),
      stats: vi.fn(async () => STATS),
    }
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(screen.getByText(/boom/)).toBeTruthy() })
  })
})
