// Per-plugin event-listener counts, read from the cordis event registry
// (roadmap item 3). Nothing here patches or wraps a listener.

import { describe, expect, test } from 'vitest'
import { countListeners, type EventsRegistryFace } from '../src/host/listeners'
import { fiberOwnerKeys, ownerKeyOfModule, ownerOfModule } from '../src/host/plugin-index'

const FIBER_A = { name: 'alpha' }
const FIBER_B = { name: 'beta' }
const FIBER_HARNESS = { name: 'core' }

const ownerOfFiber = (fiber: unknown): string | null => {
  if (fiber === FIBER_A) return 'plugin:dsh-alpha'
  if (fiber === FIBER_B) return 'plugin:dsh-beta'
  if (fiber === FIBER_HARNESS) return 'harness:@deepseek-ai/dsh-core'
  return null
}

describe('countListeners', () => {
  test('counts each listener against the plugin whose context registered it', () => {
    const events: EventsRegistryFace = {
      _hooks: {
        'session/event': [{ ctx: { fiber: FIBER_A } }, { ctx: { fiber: FIBER_B } }],
        'tool/execute': [{ ctx: { fiber: FIBER_A } }, { ctx: { fiber: FIBER_A } }],
        'internal/dispatch': [{ ctx: { fiber: FIBER_HARNESS } }],
      },
    }
    const counts = countListeners(events, ownerOfFiber)
    expect(counts?.get('plugin:dsh-alpha')).toBe(3)
    expect(counts?.get('plugin:dsh-beta')).toBe(1)
    expect(counts?.get('harness:@deepseek-ai/dsh-core')).toBe(1)
  })

  test('an unreadable registry is null, not an empty (all-zero) result', () => {
    expect(countListeners(undefined, ownerOfFiber)).toBeNull()
    expect(countListeners({}, ownerOfFiber)).toBeNull()
  })

  test('a hook with no resolvable fiber is skipped rather than misattributed', () => {
    const events: EventsRegistryFace = { _hooks: { 'x/y': [{ ctx: { fiber: { other: true } } }, {}] } }
    expect(countListeners(events, ownerOfFiber)?.size).toBe(0)
  })

  test('a non-array hook list does not throw', () => {
    const events = { _hooks: { 'x/y': 'nonsense' } } as unknown as EventsRegistryFace
    expect(countListeners(events, ownerOfFiber)?.size).toBe(0)
  })
})

describe('fiberOwnerKeys', () => {
  test('maps each entry fiber to the same owner key the path index produces', () => {
    const keys = fiberOwnerKeys([
      { moduleName: 'dsh-alpha', entryId: 'alpha', baseUrl: '/x/alpha', fiber: FIBER_A },
      { moduleName: '@deepseek-ai/dsh-core', entryId: 'core', baseUrl: '/x/core', fiber: FIBER_HARNESS },
      { moduleName: 'dsh-perf-lens', entryId: 'self', baseUrl: '/x/self', fiber: {} },
      { moduleName: 'dsh-beta', entryId: 'beta', baseUrl: '/x/beta' },
    ])
    expect(keys.get(FIBER_A)).toBe('plugin:dsh-alpha')
    expect(keys.get(FIBER_HARNESS)).toBe('harness:@deepseek-ai/dsh-core')
    expect(keys.size).toBe(3)
  })

  test('module classification is one rule shared by both mechanisms', () => {
    expect(ownerOfModule('dsh-perf-lens')).toEqual({ kind: 'self', name: 'dsh-perf-lens' })
    expect(ownerOfModule('@deepseek-ai/dsh-tool-todo').kind).toBe('harness')
    expect(ownerOfModule('dsh-context').kind).toBe('plugin')
    expect(ownerKeyOfModule('dsh-context')).toBe('plugin:dsh-context')
  })
})