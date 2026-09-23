/**
 * Probe 09 — sampler cost on a fixed amount of compute-bound work.
 *
 * Methodology note, because four attempts failed first:
 *   - Absolute CPU share across configs is swamped by GC/allocator noise.
 *   - `process.cpuUsage()` on this Windows host quantizes to ~15.6ms
 *     (see 08-cpu-clock-quantization.mjs): a 5.7ms slice reads 0 or 16ms, and
 *     batching many slices just snaps the median to the quantum. CPU-time
 *     deltas are therefore NOT usable here.
 *
 * So this probe uses the only signal that survived: wall-clock time for an
 * identical, deterministic amount of compute, with control and treatment
 * interleaved and medians taken over repeats. On a process with a core to
 * itself, that wall time IS the sampler's cost.
 *
 * The point of the matrix is to answer one design question: how coarse must the
 * sampling intervals be for background collection to stay cheap?
 *
 * Run: node probes/09-sampler-cost-matrix.mjs   (run 3x; cite trends, never single numbers)
 */
import inspector from 'node:inspector'

const session = new inspector.Session()
session.connect()
const post = (method, params) =>
  new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result)))
  })

let seed = 123456789
const nextRandom = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const NUMBERS = new Float64Array(1_000_000)
for (let i = 0; i < NUMBERS.length; i++) NUMBERS[i] = nextRandom()
const SCRATCH = new Float64Array(8)

/** ~15ms of pure compute, no allocation, so no GC. */
function computeChunk() {
  let sum = 0
  for (let i = 0; i < NUMBERS.length; i++) sum += Math.sqrt(NUMBERS[i]) * 1.0000001
  SCRATCH[0] = sum
}

/** Allocation-heavy chunk of comparable duration. */
function allocChunk() {
  let sum = 0
  for (let i = 0; i < 120_000; i++) {
    const record = { i, s: `v${i}`, arr: [i, i + 1, i + 2] }
    sum += record.arr[0] + record.s.length
  }
  SCRATCH[1] = sum
}

const CHUNKS_PER_RUN = 12
const REPEATS = 5

function timedRun(chunk) {
  const start = performance.now()
  for (let i = 0; i < CHUNKS_PER_RUN; i++) chunk()
  return performance.now() - start
}

/** Interleaved control/treatment, median of REPEATS. */
async function compare(label, chunk, setup, teardown) {
  for (let i = 0; i < 5; i++) chunk() // warm up / let V8 optimize
  const controls = []
  const treateds = []
  for (let i = 0; i < REPEATS; i++) {
    controls.push(timedRun(chunk))
    if (setup) await setup()
    treateds.push(timedRun(chunk))
    if (teardown) await teardown()
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const control = med(controls)
  const treated = med(treateds)
  const overhead = (treated / control - 1) * 100
  console.log(
    `${label.padEnd(30)} control ${control.toFixed(1).padStart(6)}ms  sampled ${treated.toFixed(1).padStart(6)}ms` +
      `  overhead ${(overhead >= 0 ? '+' : '') + overhead.toFixed(1).padStart(6)}%`,
  )
  return overhead
}

const cpuSetup = (interval) => async () => {
  await post('Profiler.enable')
  await post('Profiler.setSamplingInterval', { interval })
  await post('Profiler.start')
}
const cpuTeardown = async () => { await post('Profiler.stop') }
const heapSetup = (samplingInterval) => async () => {
  await post('HeapProfiler.enable')
  await post('HeapProfiler.startSampling', { samplingInterval })
}
const heapTeardown = async () => { await post('HeapProfiler.stopSampling') }
const bothSetup = (interval, samplingInterval) => async () => {
  await cpuSetup(interval)()
  await heapSetup(samplingInterval)()
}
const bothTeardown = async () => {
  await cpuTeardown()
  await heapTeardown()
}

console.log(`compute-bound workload, ${CHUNKS_PER_RUN} chunks x ~15ms, median of ${REPEATS}\n`)
await compare('baseline', computeChunk, null, null)

console.log('\n-- CPU profiler: cost scales with sampling rate --')
for (const interval of [10_000, 5_000, 1_000, 250]) {
  await compare(`Profiler ${interval}us`, computeChunk, cpuSetup(interval), cpuTeardown)
}

console.log('\n-- heap sampling: no allocation, so only fixed cost --')
for (const samplingInterval of [262_144, 32_768]) {
  await compare(`HeapProfiler ${samplingInterval / 1024}KB`, computeChunk, heapSetup(samplingInterval), heapTeardown)
}

console.log('\n-- bundles (the actual design candidates) --')
await compare('background cpu 5ms+heap 256KB', computeChunk, bothSetup(5_000, 262_144), bothTeardown)
await compare('background cpu 1ms+heap 256KB', computeChunk, bothSetup(1_000, 262_144), bothTeardown)
await compare('active cpu 250us+heap 32KB', computeChunk, bothSetup(250, 32_768), bothTeardown)

console.log('\n-- heap sampling: cost scales with allocation rate --')
await compare('alloc baseline', allocChunk, null, null)
for (const samplingInterval of [1_048_576, 262_144, 32_768]) {
  await compare(`alloc + heap ${samplingInterval / 1024}KB`, allocChunk, heapSetup(samplingInterval), heapTeardown)
}
await compare('alloc + cpu 1ms + heap 256KB', allocChunk, bothSetup(1_000, 262_144), bothTeardown)

session.disconnect()