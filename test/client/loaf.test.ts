// LoAF entry normalization, window aggregation and the observer plumbing.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { aggregateLoaf, LOAF_SCRIPT_CAP, scriptOfEntry, startLoafObserver } from '../../src/client/loaf'
import type { RawLoafScript } from '../../src/shared/contract'

function script(url: string, durationMs: number): RawLoafScript {
  return { url, charPosition: 0, functionName: 'f', invokerType: 'user-callback', durationMs, forcedLayoutMs: 0 }
}

describe('scriptOfEntry', () => {
  test('maps the browser fields to the contract shape', () => {
    expect(scriptOfEntry({
      sourceURL: 'dsh-app://app/plugins/??a/client.js&rev=x',
      sourceCharPosition: 42,
      sourceFunctionName: 'scan',
      invokerType: 'user-callback',
      duration: 12.5,
      forcedStyleAndLayoutDuration: 3,
    })).toEqual({
      url: 'dsh-app://app/plugins/??a/client.js&rev=x',
      charPosition: 42,
      functionName: 'scan',
      invokerType: 'user-callback',
      durationMs: 12.5,
      forcedLayoutMs: 3,
    })
  })

  test('absent fields degrade to values that resolve nothing', () => {
    const normalized = scriptOfEntry({})
    expect(normalized.url).toBe('')
    expect(normalized.charPosition).toBe(-1)
    expect(normalized.durationMs).toBe(0)
  })
})

describe('aggregateLoaf', () => {
  test('under the cap the window passes through untouched', () => {
    const entries = [script('a', 10), script('b', 20)]
    expect(aggregateLoaf(entries, true)).toEqual({
      supported: true, scripts: entries, otherCount: 0, otherMs: 0,
    })
  })

  test('over the cap keeps the top by duration and folds the rest honestly', () => {
    const entries = Array.from({ length: LOAF_SCRIPT_CAP + 3 }, (_, index) => script(`u${index}`, index + 1))
    const report = aggregateLoaf(entries, true)
    expect(report.scripts).toHaveLength(LOAF_SCRIPT_CAP)
    expect(report.scripts[0]?.durationMs).toBe(LOAF_SCRIPT_CAP + 3)
    expect(report.otherCount).toBe(3)
    expect(report.otherMs).toBe(1 + 2 + 3)
    const listed = report.scripts.reduce((total, s) => total + s.durationMs, 0)
    const raw = entries.reduce((total, s) => total + s.durationMs, 0)
    expect(listed + report.otherMs).toBe(raw)
  })
})

describe('startLoafObserver', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  test('reports unsupported when the entry type is missing', () => {
    class NoLoaf {
      static readonly supportedEntryTypes = ['longtask']
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', NoLoaf)
    const handle = startLoafObserver(() => {})
    expect(handle.supported).toBe(false)
  })

  test('delivers normalized script entries and stops cleanly', () => {
    let callback: ((list: { getEntries: () => unknown[] }) => void) | undefined
    let observed: unknown
    let disconnected = false
    class FakeLoaf {
      static readonly supportedEntryTypes = ['long-animation-frame']
      constructor(cb: (list: { getEntries: () => unknown[] }) => void) { callback = cb }
      observe(options: unknown): void { observed = options }
      disconnect(): void { disconnected = true }
    }
    vi.stubGlobal('PerformanceObserver', FakeLoaf)
    const received: RawLoafScript[] = []
    const handle = startLoafObserver(scripts => { received.push(...scripts) })
    expect(handle.supported).toBe(true)
    expect(observed).toEqual({ type: 'long-animation-frame', buffered: true })
    callback?.({
      getEntries: () => [{
        scripts: [
          { sourceURL: 'u1', sourceCharPosition: 1, duration: 5 },
          { sourceURL: 'u2', sourceCharPosition: 2, duration: 6 },
        ],
      }],
    })
    expect(received.map(s => s.url)).toEqual(['u1', 'u2'])
    handle.stop()
    expect(disconnected).toBe(true)
  })
})
