// Async-context re-attribution (mechanism C): the correlation arithmetic and
// the async_hooks recorder that feeds it.

import { describe, expect, test } from 'vitest'
import {
  AsyncWindowRecorder,
  correlateSamples,
  sampleTimesUs,
  type AsyncWindow,
} from '../src/host/async-attribution'
import { createOwnerIndex, normalizePath, type ProfileNode } from '../src/host/attribute'

const INDEX = createOwnerIndex([
  { kind: 'plugin', name: 'pluginA', prefix: '/plugins/pluginA/' },
  { kind: 'harness', name: 'harness', prefix: '/dsh/' },
])

// 1 = plugin frame, 2 = harness frame, 3 = idle.
const NODES: ProfileNode[] = [
  { id: 1, callFrame: { url: '/plugins/pluginA/index.mjs' }, children: [] },
  { id: 2, callFrame: { url: '/dsh/scheduler.js' }, children: [] },
  { id: 3, callFrame: { functionName: '(idle)', url: '' }, children: [] },
]

describe('sampleTimesUs', () => {
  test('accumulates deltas and scales out clock drift', () => {
    expect(sampleTimesUs(1000, 2000, 0, 1000, [100, 100])).toEqual([1100, 1200])
    // Profile clock ran half as long as the sampler clock: 2x scale.
    expect(sampleTimesUs(1000, 2000, 0, 500, [100])).toEqual([1200])
  })

  test('a zero-length profile clock falls back to unit scale', () => {
    expect(sampleTimesUs(1000, 1000, 0, 0, [100])).toEqual([1100])
  })
})

describe('correlateSamples', () => {
  test('moves harness samples inside a plugin-owned window back to the plugin', () => {
    const windows: AsyncWindow[] = [{ asyncId: 7, startUs: 50, endUs: 250 }]
    const ownerOf = new Map([[7, 'plugin:pluginA']])
    const correlation = correlateSamples([2, 2, 1, 3], [100, 200, 300, 400], windows, ownerOf, NODES, INDEX)
    expect(correlation.windowedSamples).toBe(2)
    expect(correlation.override.get(0)).toBe('plugin:pluginA')
    expect(correlation.override.get(1)).toBe('plugin:pluginA')
    // A plugin already on the stack is more specific than the async context.
    expect(correlation.override.has(2)).toBe(false)
    // Idle is never inside a plugin callback.
    expect(correlation.override.has(3)).toBe(false)
  })

  test('picks the innermost window when windows nest', () => {
    const windows: AsyncWindow[] = [
      { asyncId: 1, startUs: 0, endUs: 1000 },
      { asyncId: 2, startUs: 100, endUs: 200 },
    ]
    const ownerOf = new Map([[1, 'plugin:outer'], [2, 'plugin:inner']])
    const correlation = correlateSamples([2], [150], windows, ownerOf, NODES, INDEX)
    expect(correlation.override.get(0)).toBe('plugin:inner')
  })

  test('leaves samples outside every window alone', () => {
    const windows: AsyncWindow[] = [{ asyncId: 7, startUs: 0, endUs: 50 }]
    const ownerOf = new Map([[7, 'plugin:pluginA']])
    const correlation = correlateSamples([2], [500], windows, ownerOf, NODES, INDEX)
    expect(correlation.windowedSamples).toBe(0)
    expect(correlation.override.size).toBe(0)
  })
})

describe('AsyncWindowRecorder', () => {
  // Attribute the test's own frames to a plugin so a timer created here is
  // plugin-owned; otherwise only harness/runtime work would be recorded.
  const SELF_INDEX = createOwnerIndex([
    { kind: 'plugin', name: 'selftest', prefix: normalizePath(import.meta.url) },
  ])

  test('records an execution window for a plugin-owned timer', async () => {
    const recorder = new AsyncWindowRecorder()
    recorder.setOwnerIndex(SELF_INDEX)
    recorder.enable()
    await new Promise<void>((resolve) => { setTimeout(resolve, 1) })
    const sample = recorder.take()
    recorder.disable()
    expect(sample.windows.length).toBeGreaterThan(0)
    expect([...sample.ownerOf.values()]).toContain('plugin:selftest')
    // take() drains, so a second call is empty.
    expect(recorder.take().windows).toHaveLength(0)
  })

  test('enable and disable are idempotent', () => {
    const recorder = new AsyncWindowRecorder()
    expect(recorder.enabled).toBe(false)
    recorder.enable()
    recorder.enable()
    expect(recorder.enabled).toBe(true)
    recorder.disable()
    recorder.disable()
    expect(recorder.enabled).toBe(false)
  })
})
