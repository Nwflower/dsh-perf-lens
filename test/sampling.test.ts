// The three control blocks and the one mode they resolve to.
//
// This is the heart of the panel's sampling controls: the user sets an
// intensity, a background switch and a memory switch independently, and exactly
// one profile comes out. Every combination is pinned here, because the panel
// renders the combination and the host runs it — a disagreement between the two
// is what "the controls lie" looks like.

import { describe, expect, test } from 'vitest'
import type { SamplingConfig } from '../src/shared/contract'
import { applyControl, configFromMode, effectiveMode, isSamplingIntensity, samplingOf } from '../src/shared/sampling'

const config = (over: Partial<SamplingConfig> = {}): SamplingConfig =>
  ({ intensity: 'low', background: false, memory: false, ...over })

describe('effectiveMode', () => {
  test('the intensity segment picks the foreground profile', () => {
    expect(effectiveMode(config({ intensity: 'low' }))).toBe('duty')
    expect(effectiveMode(config({ intensity: 'high' }))).toBe('continuous')
  })

  test('stopped means stopped only when background sampling is off', () => {
    expect(effectiveMode(config({ intensity: 'paused', background: false }))).toBe('paused')
    expect(effectiveMode(config({ intensity: 'paused', background: true }))).toBe('background')
  })

  test('background sampling changes nothing while the foreground runs', () => {
    // The switch is inert at low and high: there is one sampling loop, and the
    // foreground tier already owns it. Rendering it as "on" must not promise a
    // second, parallel record.
    expect(effectiveMode(config({ intensity: 'low', background: true }))).toBe('duty')
    expect(effectiveMode(config({ intensity: 'high', background: true }))).toBe('continuous')
  })

  test('memory sampling never changes the mode, only what a window collects', () => {
    for (const intensity of ['paused', 'low', 'high'] as const) {
      for (const background of [false, true]) {
        expect(effectiveMode(config({ intensity, background, memory: true })))
          .toBe(effectiveMode(config({ intensity, background, memory: false })))
      }
    }
  })
})

describe('configFromMode', () => {
  test('recovers the blocks a persisted mode implies', () => {
    expect(configFromMode('duty')).toEqual({ intensity: 'low', background: false, memory: false })
    expect(configFromMode('continuous')).toEqual({ intensity: 'high', background: false, memory: false })
    expect(configFromMode('background')).toEqual({ intensity: 'paused', background: true, memory: false })
    expect(configFromMode('paused')).toEqual({ intensity: 'paused', background: false, memory: false })
  })

  test('round-trips every mode it can produce', () => {
    for (const mode of ['duty', 'continuous', 'background', 'paused'] as const) {
      expect(effectiveMode(configFromMode(mode))).toBe(mode)
    }
  })
})

describe('samplingOf', () => {
  test('prefers the config a live host sent', () => {
    const sent = config({ intensity: 'high', background: true, memory: true })
    expect(samplingOf({ mode: 'duty', sampling: sent })).toBe(sent)
  })

  test('falls back to the mode for a record that predates the config', () => {
    // History strips the config, and an older host never sent one; a rebuilt
    // panel must still be able to draw its controls.
    expect(samplingOf({ mode: 'background' })).toEqual({ intensity: 'paused', background: true, memory: false })
    expect(samplingOf({ mode: 'continuous' })).toEqual({ intensity: 'high', background: false, memory: false })
  })
})

describe('applyControl', () => {
  test('changes only the fields the request carried', () => {
    const before = config({ intensity: 'high', background: true, memory: true })
    expect(applyControl(before, { memory: false })).toEqual({ intensity: 'high', background: true, memory: false })
    expect(applyControl(before, { intensity: 'paused' })).toEqual({ intensity: 'paused', background: true, memory: true })
    expect(applyControl(before, { background: false })).toEqual({ intensity: 'high', background: false, memory: true })
  })

  test('an empty request is a no-op', () => {
    const before = config({ intensity: 'high' })
    expect(applyControl(before, {})).toEqual(before)
  })

  test('ignores a malformed field instead of wedging the host', () => {
    const before = config()
    expect(applyControl(before, { intensity: 'turbo' as never })).toEqual(before)
    expect(applyControl(before, { intensity: 42 as never })).toEqual(before)
    expect(applyControl(before, { background: 'yes' as never })).toEqual(before)
    expect(applyControl(before, { memory: null as never })).toEqual(before)
  })

  test('accepts every intensity the segment can send', () => {
    for (const intensity of ['paused', 'low', 'high'] as const) {
      expect(isSamplingIntensity(intensity)).toBe(true)
      expect(applyControl(config(), { intensity }).intensity).toBe(intensity)
    }
    expect(isSamplingIntensity('medium')).toBe(false)
    expect(isSamplingIntensity(undefined)).toBe(false)
  })
})