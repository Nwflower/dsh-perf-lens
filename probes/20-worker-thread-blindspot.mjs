// Probe 20: do worker threads escape main-thread inspector profiling?
//
// Question: the sampler opens one `inspector.Session` in the host thread. If a plugin moves its work
// into a `worker_threads` worker, does that work still appear in the CPU profile?
//
// Method: run a worker (data: URL, so this stays a single self-contained file) that busy-loops for
// ~700 ms with a distinctive marker in its source; busy-loop the main thread for the same 700 ms; run
// a CPU profile on the main thread for the whole span. Then compare what the profile saw against what
// the process actually burned, measured independently by `process.resourceUsage()` and
// `process.report.getReport().resourceUsage.cpuConsumptionPercent`.

import { Worker } from 'node:worker_threads'
import { Session } from 'node:inspector'

const WORKER_MARKER = 'probe20WorkerBurn'
const BURN_MS = 700

const workerSource = `
  import { parentPort } from 'node:worker_threads'
  function ${WORKER_MARKER} () {
    const until = Date.now() + ${BURN_MS}
    let x = 0
    while (Date.now() < until) x += Math.sqrt(x + 1)
    return x
  }
  parentPort.postMessage(${WORKER_MARKER}())
`

function burnMainThread (ms) {
  const until = Date.now() + ms
  let x = 0
  while (Date.now() < until) x += Math.sqrt(x + 1)
  return x
}

const before = process.resourceUsage()
const wallStart = Date.now()

const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`))

const session = new Session()
session.connect()
const call = (method, params) => new Promise((resolve, reject) =>
  session.post(method, params ?? {}, (err, result) => err ? reject(err) : resolve(result)))

await call('Profiler.enable')
await call('Profiler.start')

burnMainThread(BURN_MS)
await new Promise(resolve => worker.once('message', resolve))

const { profile } = await call('Profiler.stop')
session.disconnect()

const wallMs = Date.now() - wallStart
const after = process.resourceUsage()
const cpuMs = ((after.userCPUTime - before.userCPUTime) + (after.systemCPUTime - before.systemCPUTime)) / 1000

const urls = [...new Set(profile.nodes.map(node => node.callFrame.url).filter(Boolean))]
const workerFrames = urls.filter(url => url.includes(WORKER_MARKER))
const samples = profile.samples?.length ?? 0

// The profile's own time base: the sum of timeDeltas is the CPU time the profile actually saw.
let sampledMs = 0
if (profile.timeDeltas) for (const delta of profile.timeDeltas) sampledMs += delta
sampledMs /= 1000

console.log('--- probe 20: worker threads vs a main-thread CPU profile ---')
console.log(`wall clock                : ${wallMs} ms (main thread busy ~${BURN_MS} ms, worker busy ~${BURN_MS} ms)`)
console.log(`process CPU actually used : ${cpuMs.toFixed(1)} ms  (${(cpuMs / wallMs * 100).toFixed(0)}% of one core)`)
console.log(`CPU time the profile saw  : ${sampledMs.toFixed(1)} ms`)
console.log(`main-thread samples       : ${samples}`)
console.log(`distinct frame urls       : ${urls.length}`)
console.log(`frames from the worker    : ${workerFrames.length}  <-- 0 means the worker is invisible`)
console.log(`cpuConsumptionPercent     : ${process.report.getReport().resourceUsage.cpuConsumptionPercent}  (>100 means more than one thread ran)`)
console.log(`report.workers (live)     : ${JSON.stringify(process.report.getReport().workers)}`)

await worker.terminate()