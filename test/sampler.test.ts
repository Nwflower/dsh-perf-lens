// Locks the sampling state machine, above all hard constraint 5: a stop on a
// session that is not recording throws ERR_INSPECTOR_COMMAND, so stopCpu /
// stopHeap must return null instead of ever issuing an unpaired stop.

import { Session } from 'node:inspector'
import { describe, expect, test } from 'vitest'
import type { InspectorSession } from '../src/host/sampler'
import { Sampler } from '../src/host/sampler'

interface RecordedCall {
  readonly method: string
  readonly params: object | undefined
}

/** Inspector session double: records calls and answers from a method table. */
function mockSession(responders: Record<string, (params?: object) => unknown> = {}): {
  session: InspectorSession
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const session: InspectorSession = {
    post(method, params, callback) {
      calls.push({ method, params })
      const responder = responders[method]
      if (responder === undefined) {
        callback(null, {})
        return
      }
      try {
        callback(null, responder(params))
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
  }
  return { session, calls }
}

const OPTIONS = { cpuIntervalUs: 1000, heapIntervalBytes: 32768 }

const CPU_PROFILE = {
  nodes: [
    { id: 1, callFrame: { url: '/plugins/pluginA/index.mjs' }, children: [2] },
    { id: 2, callFrame: { url: '/shared/dep.mjs' }, children: [] },
  ],
  samples: [2, 2, 2],
}

describe('sampler start/stop pairing', () => {
  test('startCpu enables, sets the interval, then starts', async () => {
    const { session, calls } = mockSession()
    const sampler = new Sampler(session, OPTIONS)
    await sampler.startCpu()
    expect(calls.map(call => call.method)).toEqual([
      'Profiler.enable',
      'Profiler.setSamplingInterval',
      'Profiler.start',
    ])
    expect(calls[1]?.params).toEqual({ interval: 1000 })
    expect(sampler.cpuActive).toBe(true)
  })

  test('stopCpu while idle returns null and never posts a stop', async () => {
    const { session, calls } = mockSession()
    const sampler = new Sampler(session, OPTIONS)
    expect(await sampler.stopCpu()).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('startCpu twice records one window', async () => {
    const { session, calls } = mockSession()
    const sampler = new Sampler(session, OPTIONS)
    await sampler.startCpu()
    await sampler.startCpu()
    expect(calls.filter(call => call.method === 'Profiler.start')).toHaveLength(1)
  })

  test('stopCpu returns the parsed profile and closes the window', async () => {
    const { session } = mockSession({ 'Profiler.stop': () => CPU_PROFILE })
    const sampler = new Sampler(session, OPTIONS)
    await sampler.startCpu()
    const profile = await sampler.stopCpu()
    expect(profile?.samples).toEqual([2, 2, 2])
    expect(profile?.nodes).toHaveLength(2)
    expect(sampler.cpuActive).toBe(false)
    expect(await sampler.stopCpu()).toBeNull()
  })

  test('a failed start leaves the window closed', async () => {
    const { session } = mockSession({
      'Profiler.start': () => { throw new Error('ERR_INSPECTOR_COMMAND') },
    })
    const sampler = new Sampler(session, OPTIONS)
    await expect(sampler.startCpu()).rejects.toThrow('ERR_INSPECTOR_COMMAND')
    expect(sampler.cpuActive).toBe(false)
    expect(await sampler.stopCpu()).toBeNull()
  })

  test('dispose stops active windows and disables both domains, once', async () => {
    const { session, calls } = mockSession({ 'Profiler.stop': () => CPU_PROFILE })
    const sampler = new Sampler(session, OPTIONS)
    await sampler.startCpu()
    await sampler.dispose()
    const methods = calls.map(call => call.method)
    expect(methods).toContain('Profiler.stop')
    expect(methods).toContain('Profiler.disable')
    expect(methods).toContain('HeapProfiler.disable')
    expect(sampler.cpuActive).toBe(false)
    expect(sampler.disposed).toBe(true)
    await sampler.dispose()
    expect(calls.filter(call => call.method === 'Profiler.disable')).toHaveLength(1)
  })

  test('heap sampling uses the configured interval and stops each window', async () => {
    const { session, calls } = mockSession({
      'HeapProfiler.stopSampling': () => ({ profile: { head: { selfSize: 10, children: [] } } }),
    })
    const sampler = new Sampler(session, OPTIONS)
    await sampler.startHeap()
    expect(calls.find(call => call.method === 'HeapProfiler.startSampling')?.params)
      .toEqual({ samplingInterval: 32768 })
    const heap = await sampler.stopHeap()
    expect(heap?.head.selfSize).toBe(10)
    expect(await sampler.stopHeap()).toBeNull()
  })
})

// End-to-end proof against the real inspector. CDP wraps the result under
// `profile`; reading the top level silently yields zero samples, which is exactly
// how the live panel showed 0% for every plugin while the host was busy.
describe('sampler against the real inspector', () => {
  test('a busy window yields CPU samples', async () => {
    const session = new Session()
    session.connect()
    try {
      const sampler = new Sampler(session as unknown as InspectorSession, OPTIONS)
      await sampler.startCpu()
      const deadline = Date.now() + 250
      while (Date.now() < deadline) Math.sqrt(Math.random())
      const profile = await sampler.stopCpu()
      expect(profile).not.toBeNull()
      expect(profile?.samples.length ?? 0).toBeGreaterThan(0)
      expect(profile?.nodes.length ?? 0).toBeGreaterThan(0)
      await sampler.dispose()
    } finally {
      session.disconnect()
    }
  })
})
