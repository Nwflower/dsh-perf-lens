/**
 * Probe 03 — sampling overhead matrix.
 *
 * Measures CPU-profiler and heap-sampling overhead separately and combined, on
 * a compute-bound workload and on an async + file-I/O workload. Establishes
 * that running both continuously is too expensive for a default.
 *
 * Also demonstrates the state-machine hazard: stopping a Profiler that was
 * never started throws ERR_INSPECTOR_COMMAND (-32000).
 */
import inspector from 'node:inspector'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const session = new inspector.Session()
session.connect()

const post = (method, params) =>
  new Promise((resolve, reject) =>
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result))),
  )

const ioPath = join(tmpdir(), 'dsh-perf-lens-probe-03.bin')
const payload = Buffer.alloc(256 * 1024, 7)

const compute = () => {
  let sum = 0
  for (let i = 0; i < 1e5; i++) sum += Math.sqrt(i)
  return sum
}

const mixed = async () => {
  compute()
  writeFileSync(ioPath, payload)
  readFileSync(ioPath)
  await new Promise(resolve => setImmediate(resolve))
  compute()
}

async function bench(fn, iterations) {
  await fn()
  await fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) await fn()
  return performance.now() - start
}

for (const [label, fn, iterations] of [
  ['compute-bound', compute, 60],
  ['async+io-mixed', mixed, 60],
]) {
  console.log(`\n--- ${label} ---`)
  const baseline = await bench(fn, iterations)
  console.log(`baseline                    ${baseline.toFixed(0).padStart(6)} ms`)

  await post('Profiler.enable')
  await post('Profiler.start')
  const cpu = await bench(fn, iterations)
  console.log(`CPU profiler 1000us         ${cpu.toFixed(0).padStart(6)} ms`)
  await post('Profiler.stop')

  await post('HeapProfiler.enable')
  await post('HeapProfiler.startSampling', { samplingInterval: 32768 })
  const heap = await bench(fn, iterations)
  console.log(`heap sampling 32KB          ${heap.toFixed(0).padStart(6)} ms`)
  await post('HeapProfiler.stopSampling')

  await post('Profiler.start')
  await post('HeapProfiler.startSampling', { samplingInterval: 32768 })
  const both = await bench(fn, iterations)
  console.log(`both                        ${both.toFixed(0).padStart(6)} ms`)
  await post('Profiler.stop')
  await post('HeapProfiler.stopSampling')

  console.log(
    `  overhead: cpu ${fmt(cpu / baseline)}  heap ${fmt(heap / baseline)}  both ${fmt(both / baseline)}`,
  )
}

// State-machine hazard: stop() without start() is an error, not a no-op.
try {
  await post('Profiler.stop')
  console.log('\nProfiler.stop when idle: no error')
} catch (error) {
  console.log(`\nProfiler.stop when idle throws: ${error.code} — ${error.message}`)
}

rmSync(ioPath, { force: true })
session.disconnect()

function fmt(ratio) {
  const pct = (ratio - 1) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}