/**
 * Probe 07 — what the opaque "runtime" owner is actually made of.
 *
 * The panel reported one `runtime` row. On a live host it sat at the top of the
 * board (avg 36.8%, peak 100%), which answers nothing. This probe samples a
 * workload that mimics a plugin host (timers, async fs, JSON, GC pressure) and
 * tallies the leaf frame of every sample that has no plugin/harness frame on
 * its stack.
 *
 * Observed (Node v24, 3079 samples, 250us interval, 3s):
 *   idle (excluded from the active denominator)  54.7% of the runtime bucket
 *   (garbage collector)                          19.2%
 *   node internals (node:*)                      13.7% + tail
 *   empty-url native/libuv frames                fstat / writeBuffer / close ...
 *   (program) synthetic root                     4.1%
 *
 * Hence the split into gc / native / node / event-loop / other.
 */
import inspector from 'node:inspector'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = await mkdtemp(join(tmpdir(), 'dsh-perf-runtime-'))
const file = join(dir, 'data.json')

const session = new inspector.Session()
session.connect()
const post = (method, params) =>
  new Promise((resolve, reject) =>
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result))),
  )

await post('Profiler.enable')
await post('Profiler.setSamplingInterval', { interval: 250 })
await post('Profiler.start')

const big = { rows: Array.from({ length: 20000 }, (_, i) => ({ i, s: 'x'.repeat(20) })) }
const start = Date.now()
const timers = setInterval(() => { Math.sqrt(Math.random()) }, 5)
while (Date.now() - start < 3000) {
  await writeFile(file, JSON.stringify(big))
  await readFile(file, 'utf8')
  const parsed = JSON.parse(JSON.stringify(big))
  for (let i = 0; i < 200; i++) void Array.from({ length: 1000 }, () => i)
  void parsed
}
clearInterval(timers)
const { profile } = await post('Profiler.stop')
await rm(dir, { recursive: true, force: true })

const nodeById = new Map(profile.nodes.map(n => [n.id, n]))
const parentOf = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id)

const isRuntimeUrl = u => u === '' || /^(node:|internal\/|native|\(root\)|\(program\)|\(idle\)|\(anonymous\)|\()/.test(u)

const leaf = new Map()
let runtimeSamples = 0
for (const id of profile.samples) {
  let cursor = id
  let owner = 'runtime'
  while (cursor !== undefined) {
    const n = nodeById.get(cursor)
    if (n === undefined) break
    const u = n.callFrame?.url ?? ''
    if (!isRuntimeUrl(u)) { owner = 'other'; break }
    cursor = parentOf.get(cursor)
  }
  if (owner !== 'runtime') continue
  runtimeSamples += 1
  const n = nodeById.get(id)
  const key = (n?.callFrame?.functionName ?? '?') + ' @ ' + ((n?.callFrame?.url ?? '') || '(empty-url)')
  leaf.set(key, (leaf.get(key) ?? 0) + 1)
}

const total = profile.samples.length
const top = [...leaf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
console.log(JSON.stringify({
  totalSamples: total,
  runtimeSamples,
  runtimeShare: +(runtimeSamples / total).toFixed(3),
  topLeafFrames: top.map(([frame, count]) => ({ frame, count, shareOfRuntime: +(count / runtimeSamples).toFixed(3) })),
}, null, 1))
