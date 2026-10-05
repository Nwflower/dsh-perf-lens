// Persisted probe preference: the switch has to survive a page load, because
// the probe must be installed before the plugins register their callbacks.

import { describe, expect, test } from 'vitest'
import { probeEnabledFromStorage, rememberProbeEnabled } from '../../src/client/schedule-probe'

function memoryStorage(seed: Record<string, string> = {}): Storage & { readonly data: Record<string, string> } {
  const data: Record<string, string> = { ...seed }
  return {
    get data() { return data },
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => { data[key] = value },
    removeItem: (key: string) => { delete data[key] },
  } as unknown as Storage & { readonly data: Record<string, string> }
}

const KEY = 'dsh-perf-lens.scheduleProbe'

describe('probe preference', () => {
  test('absent storage reads as off and remembers nothing', () => {
    expect(probeEnabledFromStorage(undefined)).toBe(false)
    expect(() => { rememberProbeEnabled(undefined, true) }).not.toThrow()
  })

  test('a remembered "on" reads back as on', () => {
    const storage = memoryStorage()
    rememberProbeEnabled(storage, true)
    expect(storage.data[KEY]).toBe('1')
    expect(probeEnabledFromStorage(storage)).toBe(true)
  })

  test('turning it off clears the stored value', () => {
    const storage = memoryStorage({ [KEY]: '1' })
    rememberProbeEnabled(storage, false)
    expect(storage.data[KEY]).toBeUndefined()
    expect(probeEnabledFromStorage(storage)).toBe(false)
  })

  test('an unrelated stored value reads as off', () => {
    expect(probeEnabledFromStorage(memoryStorage({ [KEY]: 'yes' }))).toBe(false)
  })

  test('a storage that throws degrades to off instead of breaking the panel', () => {
    const throwing = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
    } as unknown as Storage
    expect(probeEnabledFromStorage(throwing)).toBe(false)
    expect(() => { rememberProbeEnabled(throwing, true) }).not.toThrow()
  })
})
