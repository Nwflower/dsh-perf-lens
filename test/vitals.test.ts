// The vitals ring and the untrusted POST body narrowing.

import { describe, expect, test } from 'vitest'
import { parseVitals, VitalsStore } from '../src/host/vitals'
import type { ClientVitals, LoafReport } from '../src/shared/contract'

function report(at: number): ClientVitals {
  return { longTaskCount: 1, longTaskTotalMs: 60, rafGapP95Ms: 20, windowMs: 5000, at }
}

function loafReport(): LoafReport {
  return {
    supported: true,
    scripts: [{
      url: 'plugins/??dsh-claude-style/client.js&rev=x',
      charPosition: 0,
      functionName: 'sync',
      invokerType: 'user-callback',
      durationMs: 30,
      forcedLayoutMs: 2,
    }],
    otherCount: 0,
    otherMs: 0,
  }
}

const LOAF_BODY = {
  url: 'plugins/??dsh-claude-style/client.js&rev=x',
  charPosition: 0,
  functionName: 'sync',
  invokerType: 'user-callback',
  durationMs: 30,
  forcedLayoutMs: 2,
}

const NUMBERS = { longTaskCount: 1, longTaskTotalMs: 2, rafGapP95Ms: 3, windowMs: 4, at: 5 }

describe('VitalsStore', () => {
  test('latest is the newest and recent is newest-first', () => {
    const store = new VitalsStore(3)
    expect(store.view().latest).toBeNull()
    store.record(report(1))
    store.record(report(2))
    const view = store.view()
    expect(view.latest?.at).toBe(2)
    expect(view.recent.map(item => item.at)).toEqual([2, 1])
  })

  test('drops the oldest beyond capacity', () => {
    const store = new VitalsStore(2)
    store.record(report(1))
    store.record(report(2))
    store.record(report(3))
    expect(store.view().recent.map(item => item.at)).toEqual([3, 2])
  })

  test('rejects a non-positive capacity', () => {
    expect(() => new VitalsStore(0)).toThrow(RangeError)
  })

  test('resolves the loaf field at record time and exposes it on the view', () => {
    const store = new VitalsStore(3, {
      jank: r => r.loaf === undefined
        ? null
        : { rows: [{ owner: 'plugin:x', durationMs: 30, forcedLayoutMs: 2, count: 1 }], attributedShare: 1 },
    })
    store.record({ ...report(1), loaf: loafReport() })
    const view = store.view()
    expect(view.jank).toEqual({
      rows: [{ owner: 'plugin:x', durationMs: 30, forcedLayoutMs: 2, count: 1 }],
      attributedShare: 1,
    })
    expect(view.latest?.loaf?.scripts).toHaveLength(1)
  })

  test('a report without a loaf field views a null jank', () => {
    const store = new VitalsStore(3, { jank: () => null })
    store.record(report(1))
    expect(store.view().jank).toBeNull()
  })

  test('resolves the schedule field at record time and exposes it on the view', () => {
    const store = new VitalsStore(3, {
      schedule: r => r.schedule === undefined
        ? null
        : {
          rows: [{ owner: 'plugin:x', scheduledMs: 12, calls: 3, maxMs: 5 }],
          attributedShare: 1,
          contract: 'ok',
        },
    })
    store.record({
      ...report(1),
      schedule: { active: true, sites: [], windowMs: 5000 },
    })
    const view = store.view()
    expect(view.schedule).toEqual({
      rows: [{ owner: 'plugin:x', scheduledMs: 12, calls: 3, maxMs: 5 }],
      attributedShare: 1,
      contract: 'ok',
    })
    expect(view.latest?.schedule?.active).toBe(true)
  })

  test('a report without a schedule field views a null schedule', () => {
    const store = new VitalsStore(3, {})
    store.record(report(1))
    expect(store.view().schedule).toBeNull()
  })
})

describe('parseVitals', () => {
  test('accepts a complete numeric body', () => {
    expect(parseVitals({ longTaskCount: 1, longTaskTotalMs: 2, rafGapP95Ms: 3, windowMs: 4, at: 5 }))
      .toEqual({ longTaskCount: 1, longTaskTotalMs: 2, rafGapP95Ms: 3, windowMs: 4, at: 5 })
  })

  test('rejects missing or non-finite fields', () => {
    expect(parseVitals({})).toBeNull()
    expect(parseVitals({ longTaskCount: Number.NaN, longTaskTotalMs: 1, rafGapP95Ms: 1, windowMs: 1, at: 1 })).toBeNull()
    expect(parseVitals({ longTaskCount: 'x', longTaskTotalMs: 1, rafGapP95Ms: 1, windowMs: 1, at: 1 })).toBeNull()
  })

  test('accepts a body with a well-formed loaf field', () => {
    const parsed = parseVitals({
      ...NUMBERS,
      loaf: { supported: true, scripts: [LOAF_BODY], otherCount: 1, otherMs: 4 },
    })
    expect(parsed?.loaf).toEqual({
      supported: true,
      scripts: [LOAF_BODY],
      otherCount: 1,
      otherMs: 4,
    })
  })

  test('accepts a body without a loaf field', () => {
    const parsed = parseVitals({ ...NUMBERS })
    expect(parsed).not.toBeNull()
    expect(parsed?.loaf).toBeUndefined()
  })

  test('accepts a body with a well-formed schedule field', () => {
    const parsed = parseVitals({
      ...NUMBERS,
      schedule: {
        active: true,
        windowMs: 5000,
        sites: [{ url: 'plugins/??a/client.js&rev=r', line: 1, column: 2, calls: 3, selfMs: 4, maxMs: 5 }],
        selfTest: { url: 'plugins/??a/client.js&rev=r', line: 9, column: 8 },
      },
    })
    expect(parsed?.schedule).toEqual({
      active: true,
      windowMs: 5000,
      sites: [{ url: 'plugins/??a/client.js&rev=r', line: 1, column: 2, calls: 3, selfMs: 4, maxMs: 5 }],
      selfTest: { url: 'plugins/??a/client.js&rev=r', line: 9, column: 8 },
    })
  })

  test('accepts a body without a schedule field', () => {
    expect(parseVitals({ ...NUMBERS })?.schedule).toBeUndefined()
  })

  test('rejects malformed schedule bodies instead of guessing', () => {
    const schedule = (over: Record<string, unknown>): unknown => ({
      active: true, windowMs: 5000, sites: [], ...over,
    })
    expect(parseVitals({ ...NUMBERS, schedule: 7 })).toBeNull()
    expect(parseVitals({ ...NUMBERS, schedule: schedule({ active: 'yes' }) })).toBeNull()
    expect(parseVitals({ ...NUMBERS, schedule: schedule({ sites: 'none' }) })).toBeNull()
    expect(parseVitals({ ...NUMBERS, schedule: schedule({ sites: [{ url: 'u', line: 1 }] }) })).toBeNull()
    expect(parseVitals({ ...NUMBERS, schedule: schedule({ selfTest: { url: 1, line: 1, column: 1 } }) })).toBeNull()
  })

  test('rejects malformed loaf bodies instead of guessing', () => {
    expect(parseVitals({ ...NUMBERS, loaf: 7 })).toBeNull()
    expect(parseVitals({ ...NUMBERS, loaf: { supported: 'yes', scripts: [], otherCount: 0, otherMs: 0 } })).toBeNull()
    expect(parseVitals({ ...NUMBERS, loaf: { supported: true, scripts: [{ ...LOAF_BODY, url: 3 }], otherCount: 0, otherMs: 0 } }))
      .toBeNull()
    expect(parseVitals({ ...NUMBERS, loaf: { supported: true, scripts: [{ ...LOAF_BODY, durationMs: 'x' }], otherCount: 0, otherMs: 0 } }))
      .toBeNull()
    expect(parseVitals({ ...NUMBERS, loaf: { supported: true, scripts: [], otherCount: 0 } })).toBeNull()
  })
})
