// The board renders the plugin table from the host snapshot and surfaces a
// failed poll instead of rendering a blank panel.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PerfApi } from '../../src/client/api'
import { PerfPanel } from '../../src/client/panel'
import type { PerfSnapshot } from '../../src/shared/contract'

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

function apiOf(snapshot: PerfSnapshot): PerfApi {
  return {
    snapshot: vi.fn(async () => snapshot),
    control: vi.fn(async () => snapshot),
    history: vi.fn(async () => [snapshot]),
  }
}

afterEach(cleanup)

describe('PerfPanel', () => {
  test('renders the plugin row after the first poll', async () => {
    render(<PerfPanel api={apiOf(SNAPSHOT)} />)
    await waitFor(() => { expect(screen.getByText('pluginA')).toBeTruthy() })
    expect(screen.getByText('50.0%')).toBeTruthy()
  })

  test('surfaces a failed poll', async () => {
    const api: PerfApi = {
      snapshot: vi.fn(async () => { throw new Error('boom') }),
      control: vi.fn(async () => SNAPSHOT),
      history: vi.fn(async () => []),
    }
    render(<PerfPanel api={api} />)
    await waitFor(() => { expect(screen.getByText(/boom/)).toBeTruthy() })
  })
})
