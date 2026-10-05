// Scheduler-probe transparency, site capture and report folding.
//
// Every test here asserts a property a wrapper must preserve rather than a
// metric it produces: a wrapper that changes arity, this-binding, return value
// or cancellation identity breaks the page it is supposed to measure.

import { afterEach, describe, expect, test } from 'vitest'
import { createScheduleProbe, isOwnFrame, registrationSiteOf, type ProbeGlobal } from '../../src/client/schedule-probe'

/** The frame shape V8 emits on the desktop origin. */
function pluginStack(line: number, column: number): string {
  return [
    'Error',
    `    at pluginFrame (dsh-app://app/plugins/??a/client.js,b/client.js&rev=r1:${String(line)}:${String(column)})`,
    '    at (dsh-app://app/assets/index.js:1:1)',
  ].join('\n')
}

/** A settable global stand-in, driving its callbacks synchronously. */
function fakeGlobal(callbacks: Array<() => void> = []): Record<string, unknown> {
  return {
    performance: { now: () => 0 },
    Error,
    requestAnimationFrame: (cb: unknown) => { if (typeof cb === 'function') callbacks.push(cb as () => void); return 1 },
    setTimeout: (cb: unknown) => { if (typeof cb === 'function') callbacks.push(cb as () => void); return 2 },
    setInterval: (cb: unknown) => { if (typeof cb === 'function') callbacks.push(cb as () => void); return 3 },
    queueMicrotask: (cb: unknown) => { if (typeof cb === 'function') callbacks.push(cb as () => void); return 4 },
    MutationObserver: class { constructor(readonly cb: unknown) {} },
    ResizeObserver: class { constructor(readonly cb: unknown) {} },
    IntersectionObserver: class { constructor(readonly cb: unknown) {} },
  }
}

const SITE = { url: 'plugins/??a/client.js,b/client.js&rev=r1', line: 100, column: 3 } as const

afterEach(() => { /* the fake globals are local to each test */ })

describe('registrationSiteOf', () => {
  test('returns the first plugins/ frame past the probe\'s own frame', () => {
    expect(registrationSiteOf(pluginStack(1234, 7))).toEqual({
      url: 'plugins/??a/client.js,b/client.js&rev=r1',
      line: 1234,
      column: 7,
    })
  })

  test('a stack with no plugin frame resolves to undefined, never a guess', () => {
    expect(registrationSiteOf('Error\n    at foo (dsh-app://app/assets/index.js:1:1)')).toBeUndefined()
    expect(registrationSiteOf(undefined)).toBeUndefined()
  })

  test('a qualified method frame is still recognized as the probe\'s own', () => {
    // Measured shape: the construct trap reports as "at Object.construct (…)".
    // Missing it attributed the probe's own trap to the probe as a plugin row.
    expect(isOwnFrame('    at Object.construct (<anonymous>:12:44)')).toBe(true)
    expect(isOwnFrame('    at Object.apply (<anonymous>:9:1)')).toBe(true)
    expect(isOwnFrame('    at captureTrap (<anonymous>:5:1)')).toBe(true)
    expect(isOwnFrame('    at scan (dsh-app://app/plugins/??a/client.js&rev=1:3:4)')).toBe(false)
    expect(isOwnFrame('    at Object.scan (dsh-app://app/plugins/??a/client.js&rev=1:3:4)')).toBe(false)
  })

  test('a construct trap attributes the constructing caller, not itself', () => {
    const target = fakeGlobal()
    class FakeObserver { constructor(readonly cb: unknown) {} }
    target.MutationObserver = FakeObserver
    target.Error = class {
      readonly stack = [
        'Error',
        '    at Object.construct (<anonymous>:12:44)',
        `    at Object.<anonymous> (dsh-app://app/plugins/??a/client.js,b/client.js&rev=r1:${String(SITE.line)}:${String(SITE.column)})`,
      ].join('\n')
    }
    const probe = createScheduleProbe(target as ProbeGlobal, () => 0)
    probe.enable()
    const Built = target.MutationObserver as new (cb: unknown) => unknown
    new Built(() => {})
    const sites = probe.takeReport(5000).sites
    expect(sites).toHaveLength(1)
    expect(sites[0]?.line).toBe(SITE.line)
  })
})

describe('createScheduleProbe', () => {
  test('off means untouched: report is inactive and nothing is wrapped', () => {
    const target = fakeGlobal()
    const raf = target.requestAnimationFrame
    const probe = createScheduleProbe(target as ProbeGlobal, () => 0)
    expect(probe.state.active).toBe(false)
    expect(probe.takeReport(5000)).toEqual({ active: false, sites: [], windowMs: 5000 })
    expect(target.requestAnimationFrame).toBe(raf)
  })

  test('enable installs, disable restores every original object', () => {
    const target = fakeGlobal()
    const names = ['requestAnimationFrame', 'setTimeout', 'setInterval', 'queueMicrotask', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver'] as const
    const originals = new Map(names.map(name => [name, target[name]]))
    const probe = createScheduleProbe(target as ProbeGlobal, () => 0)
    probe.enable()
    for (const name of names) expect(target[name]).not.toBe(originals.get(name))
    probe.disable()
    for (const name of names) expect(target[name]).toBe(originals.get(name))
  })

  test('records a registration site with its call count, total and longest call', () => {
    const callbacks: Array<() => void> = []
    const target = fakeGlobal(callbacks)
    let clock = 0
    target.Error = class { readonly stack = pluginStack(SITE.line, SITE.column) }
    target.performance = { now: () => clock }
    const probe = createScheduleProbe(target as ProbeGlobal, () => clock)
    probe.enable()
    const raf = target.requestAnimationFrame as (cb: () => void) => unknown
    raf(() => { clock += 6 })
    raf(() => { clock += 10 })
    for (const callback of callbacks) callback()
    const report = probe.takeReport(5000)
    expect(report.active).toBe(true)
    expect(report.sites).toEqual([{ ...SITE, calls: 2, selfMs: 16, maxMs: 10 }])
    expect(report.selfTest).toEqual({ ...SITE })
  })

  test('the same position folds into one site across many registrations', () => {
    const callbacks: Array<() => void> = []
    const target = fakeGlobal(callbacks)
    target.Error = class { readonly stack = pluginStack(SITE.line, SITE.column) }
    const probe = createScheduleProbe(target as ProbeGlobal, () => 0)
    probe.enable()
    for (let index = 0; index < 40; index += 1) {
      ;(target.setTimeout as (cb: () => void) => unknown)(() => {})
    }
    for (const callback of callbacks) callback()
    const report = probe.takeReport(5000)
    expect(report.sites).toHaveLength(1)
    expect(report.sites[0]?.calls).toBe(40)
  })

  test('a registered callback that never runs contributes no site', () => {
    const target = fakeGlobal()
    target.Error = class { readonly stack = pluginStack(SITE.line, SITE.column) }
    const probe = createScheduleProbe(target as ProbeGlobal, () => 0)
    probe.enable()
    ;(target.setTimeout as (cb: () => void) => unknown)(() => {})
    expect(probe.takeReport(5000).sites).toEqual([])
  })

  test('a wrapper preserves arity, this, return value and the callback arguments', () => {
    const target = fakeGlobal()
    const original = function (this: unknown, cb: (...args: unknown[]) => unknown, ms?: number): unknown {
      const result = cb.apply(this, ['arg'])
      return { handle: ms, result }
    }
    target.setTimeout = original
    target.Error = class { readonly stack = pluginStack(SITE.line, SITE.column) }
    const probe = createScheduleProbe(target as ProbeGlobal, () => 0)
    probe.enable()
    const wrapped = target.setTimeout as typeof original
    const seen: unknown[] = []
    const returned = wrapped.call({ tag: 'this' }, function (this: unknown, arg: unknown) {
      seen.push([this, arg])
      return 'inner'
    }, 25)
    expect(returned).toEqual({ handle: 25, result: 'inner' })
    expect(seen[0]).toEqual([{ tag: 'this' }, 'arg'])
    expect(wrapped.length).toBe(original.length)
  })

  test('observer construction keeps instanceof and still records the site', () => {
    const target = fakeGlobal()
    class FakeObserver { constructor(readonly cb: unknown) {} }
    target.MutationObserver = FakeObserver
    target.Error = class { readonly stack = pluginStack(SITE.line, SITE.column) }
    const probe = createScheduleProbe(target as ProbeGlobal, () => 0)
    probe.enable()
    const Built = target.MutationObserver as new (cb: unknown) => unknown
    const instance = new Built(() => {})
    expect(instance).toBeInstanceOf(FakeObserver)
    expect(probe.takeReport(5000).sites.map(site => [site.line, site.column])).toEqual([[SITE.line, SITE.column]])
  })

  test('the self-test position travels in every report and survives a fold', () => {
    const target = fakeGlobal()
    target.Error = class { readonly stack = pluginStack(7, 2) }
    const probe = createScheduleProbe(target as ProbeGlobal, () => 0)
    probe.enable()
    expect(probe.takeReport(5000).selfTest).toEqual({ url: SITE.url, line: 7, column: 2 })
    expect(probe.takeReport(5000).selfTest).toEqual({ url: SITE.url, line: 7, column: 2 })
  })

  test('a non-plugin position is recorded as absent, not attributed', () => {
    const callbacks: Array<() => void> = []
    const target = fakeGlobal(callbacks)
    target.Error = class { readonly stack = 'Error\n    at foo (dsh-app://app/assets/index.js:1:1)' }
    const probe = createScheduleProbe(target as ProbeGlobal, () => 0)
    probe.enable()
    ;(target.requestAnimationFrame as (cb: () => void) => unknown)(() => {})
    const report = probe.takeReport(5000)
    expect(report.sites).toEqual([])
    expect(report.selfTest).toBeUndefined()
  })
})
