// The vitals ring and the untrusted POST body narrowing.

import { describe, expect, test } from 'vitest'
import { parseVitals, VitalsStore } from '../src/host/vitals'
import type { ClientVitals } from '../src/shared/contract'

function report(at: number): ClientVitals {
  return { longTaskCount: 1, longTaskTotalMs: 60, rafGapP95Ms: 20, windowMs: 5000, at }
}

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
})
