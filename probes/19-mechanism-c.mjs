/**
 * Probe 19 — how much CPU hides behind the async boundary (mechanism C)?
 *
 * The ancestor-stack rule attributes a sample to the nearest plugin frame on
 * the JS stack. When a plugin hands work to a harness timer/callback, that
 * frame is gone by the time the callback runs, so the cost lands on harness.
 *
 * This probe builds a fake plugin that hands data to a fake harness, which does
 * the heavy work from a setTimeout callback. It then attributes the same CPU
 * samples two ways: by the JS stack (the product rule) and by time-correlating
 * each sample with async_hooks execution windows. The gap is mechanism C.
 *
 * It also proves the clock handling the product relies on: V8's profile clock
 * is boot-monotonic and shares no origin with performance.now(), so sample
 * times must be rebased by the sampler's own start/stop readings.
 *
 * Run: node probes/19-mechanism-c.mjs
 */
import inspector from 'node:inspector'
import { createHook } from 'node:async_hooks'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  attributeFrameList, attributeNode, buildNodeMap, buildParentMap, frameUrlsOfStack,
  normalizePath, ownerKey,
} from '../src/host/attribute.ts'

const HARNESS_SOURCE = [
  'const pending = []',
  'export function scheduleProcessing(payload) {',
  '  pending.push(payload)',
  '  setTimeout(run, 0)',
  '}',
  'function run() {',
  '  const payload = pending.shift()',
  '  if (payload) process(payload)',
  '}',
  'function process(payload) { burn(payload.ms) }',
  'function burn(ms) {',
  '  const end = performance.now() + ms',
  '  let sink = 0',
  '  while (performance.now() < end) {',
  '    for (let i = 0; i < 20000; i++) sink = Math.sin(sink + 1.0000001) + sink * 0.5',
  '    globalThis.__sink = sink',
  '  }',
  '}',
].join('\n')

const PLUGIN_SOURCE = [
  "import { scheduleProcessing } from './c-harness.mjs'",
  'export function start(ms) { scheduleProcessing({ ms }) }',
].join('\n')

const dir = mkdtempSync(join(tmpdir(), 'perf-lens-mechanism-c-'))
const harnessPath = join(dir, 'c-harness.mjs')
const pluginPath = join(dir, 'c-plugin.mjs')
writeFileSync(harnessPath, HARNESS_SOURCE)
writeFileSync(pluginPath, PLUGIN_SOURCE)

const session = new inspector.Session()
session.connect()
const post = (method, params) => new Promise((resolve, reject) => {
  session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result)))
})

const index = {
  rules: [
    { kind: 'harness', name: 'harness', prefix: normalizePath(pathToFileURL(harnessPath).href) },
    { kind: 'plugin', name: 'plugin', prefix: normalizePath(pathToFileURL(pluginPath).href) },
  ].sort((a, b) => b.prefix.length - a.prefix.length),
}

const nowUs = () => performance.now() * 1000
const initOwner = new Map()
const windows = []
const open = new Map()

const hook = createHook({
  init(asyncId) {
    initOwner.set(asyncId, ownerKey(attributeFrameList(frameUrlsOfStack(new Error().stack ?? ''), index)))
  },
  before(asyncId) {
    const stack = open.get(asyncId) ?? []
    stack.push(nowUs())
    open.set(asyncId, stack)
  },
  after(asyncId) {
    const stack = open.get(asyncId)
    const start = stack?.pop()
    if (start !== undefined) windows.push({ id: asyncId, start, end: nowUs() })
  },
})
hook.enable()

const { start } = await import(pathToFileURL(pluginPath).href)
await post('Profiler.enable')
await post('Profiler.setSamplingInterval', { interval: 250 })
await post('Profiler.start')
const perfAtStartUs = nowUs()
start(700)
await new Promise((resolve) => { setTimeout(resolve, 1100) })
const { profile } = await post('Profiler.stop')
hook.disable()

console.log('clock calibration:')
console.log('  profile.startTime        = ' + profile.startTime + ' us (boot-monotonic)')
console.log('  perf clock at start      = ' + perfAtStartUs.toFixed(0) + ' us')
console.log('  profile duration         = ' + ((profile.endTime - profile.startTime) / 1000).toFixed(1) + ' ms')
console.log('  observed duration        = ' + ((nowUs() - perfAtStartUs) / 1000).toFixed(1) + ' ms')
console.log('')

const samples = profile.samples ?? []
const deltas = profile.timeDeltas ?? []
const nodesById = buildNodeMap(profile.nodes)
const parentOf = buildParentMap(profile.nodes)
const ownerOfNode = new Map()
const ownerOf = (nodeId) => {
  let key = ownerOfNode.get(nodeId)
  if (key === undefined) {
    key = ownerKey(attributeNode(nodeId, nodesById, parentOf, index))
    ownerOfNode.set(nodeId, key)
  }
  return key
}

let time = perfAtStartUs
const sampleTimes = []
for (let i = 0; i < samples.length; i++) {
  time += deltas[i] ?? 0
  sampleTimes.push(time)
}

const stackCounts = new Map()
for (const id of samples) stackCounts.set(ownerOf(id), (stackCounts.get(ownerOf(id)) ?? 0) + 1)
console.log('stack attribution (the product rule):')
for (const [key, count] of [...stackCounts].sort((a, b) => b[1] - a[1])) console.log('  ' + key + ' = ' + count)

let inside = 0
const asyncCounts = new Map()
const cross = new Map()
for (let i = 0; i < samples.length; i++) {
  const t = sampleTimes[i]
  let best = null
  for (const w of windows) if (w.start <= t && t <= w.end && (best === null || w.start > best.start)) best = w
  if (best === null) continue
  inside += 1
  const owner = initOwner.get(best.id) ?? 'unknown'
  asyncCounts.set(owner, (asyncCounts.get(owner) ?? 0) + 1)
  const pair = ownerOf(samples[i]) + ' -> ' + owner
  cross.set(pair, (cross.get(pair) ?? 0) + 1)
}

console.log('')
console.log('samples total:            ' + samples.length)
console.log('samples inside a window:  ' + inside)
console.log('async-window owner counts:')
for (const [key, count] of [...asyncCounts].sort((a, b) => b[1] - a[1])) console.log('  ' + key + ' = ' + count)
console.log('cross-tab (stack -> async):')
for (const [key, count] of [...cross].sort((a, b) => b[1] - a[1])) console.log('  ' + key + ' = ' + count)
console.log('')
console.log('mechanism C = samples whose stack says harness/runtime but whose async context is a plugin.')

session.disconnect()
rmSync(dir, { recursive: true, force: true })
