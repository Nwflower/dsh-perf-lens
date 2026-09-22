/**
 * Probe 02 — CPU + allocation attribution by module URL through node:inspector.
 *
 * Shows that Profiler and HeapProfiler sampling both yield call frames whose
 * `url` identifies the owning module, which is the basis for per-plugin
 * attribution.
 */
import inspector from 'node:inspector'
import * as v8 from 'node:v8'

const session = new inspector.Session()
session.connect()

const post = (method, params) =>
  new Promise((resolve, reject) =>
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result))),
  )

const compute = () => {
  let sum = 0
  for (let i = 0; i < 3e6; i++) sum += Math.sqrt(i)
  return sum
}
const allocate = () => {
  const out = []
  for (let i = 0; i < 2e4; i++) out.push({ i, pad: 'x'.repeat(64) })
  return out.length
}

await post('Profiler.enable')
await post('HeapProfiler.enable')

await post('Profiler.start')
await post('HeapProfiler.startSampling', { samplingInterval: 4096 })

const kept = []
for (let i = 0; i < 12; i++) {
  compute()
  kept.push(allocate())
}

const { profile: cpu } = await post('Profiler.stop')
const { profile: heap } = await post('HeapProfiler.stopSampling')

console.log('cpu profile nodes:', cpu.nodes.length, 'samples:', cpu.samples.length)
console.log('heap sampling samples:', heap.samples?.length ?? '(tree only)')

// --- CPU self-time by call frame url ---
const nodeById = new Map(cpu.nodes.map(node => [node.id, node]))
const ticksById = new Map()
for (const id of cpu.samples) ticksById.set(id, (ticksById.get(id) ?? 0) + 1)

const cpuByUrl = new Map()
for (const [id, ticks] of ticksById) {
  const frame = nodeById.get(id)?.callFrame
  if (!frame) continue
  const url = frame.url.replace(/^file:\/\//, '') || '(native)'
  cpuByUrl.set(url, (cpuByUrl.get(url) ?? 0) + ticks)
}
console.log('\nCPU self-time by frame url:')
for (const [url, ticks] of [...cpuByUrl].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ${String(ticks).padStart(5)}  ${url}`)
}

// --- allocation self-size by call frame url ---
const heapByUrl = new Map()
const walk = node => {
  const url = (node.callFrame?.url ?? '').replace(/^file:\/\//, '') || '(root)'
  const self = node.selfSize ?? 0
  if (self > 0) heapByUrl.set(url, (heapByUrl.get(url) ?? 0) + self)
  for (const child of node.children ?? []) walk(child)
}
walk(heap.head)

console.log('\nAllocation self-size by frame url (bytes):')
for (const [url, bytes] of [...heapByUrl].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(bytes).padStart(9)}  ${url}`)
}

console.log('\nheap stats:', JSON.stringify({ heapUsed: v8.getHeapStatistics().used_heap_size }))
console.log('writeHeapSnapshot available:', typeof v8.writeHeapSnapshot)

session.disconnect()