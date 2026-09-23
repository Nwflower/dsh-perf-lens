/**
 * Probe 16 — does the configured CPU sampling interval actually buy resolution?
 *
 * Probe 09 measured what a finer interval COSTS. This probe measures what it
 * BUYS: the achieved sample count for a fixed amount of busy wall time. If the
 * platform's timer floors the profiler's tick, a 250us interval yields no more
 * samples than a 1ms one — and the default would be paying 4x for nothing.
 *
 * Real history first flagged this: 5s duty windows record ~5,600 samples, not
 * the 20,000 a 250us interval implies (ratio 0.28).
 *
 * Run: node probes/16-achieved-sample-rate.mjs
 */
import inspector from 'node:inspector'

const session = new inspector.Session()
session.connect()
const post = (method, params) => new Promise((resolve, reject) => {
  session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result)))
})

/** Busy work that cannot be optimised away, sized to run ~2s. */
function burn(ms) {
  const end = performance.now() + ms
  let sink = 0
  while (performance.now() < end) {
    for (let i = 0; i < 20000; i++) sink = Math.sin(sink + 1.0000001) + sink * 0.5
    globalThis.__sink = sink
  }
}

const INTERVALS = [100, 250, 500, 1000, 5000]
const RUN_MS = 2000
const REPEATS = 3

console.log('configured interval vs achieved samples over ' + RUN_MS + 'ms of busy JS (median of ' + REPEATS + ')')
console.log('')
console.log('  interval   samples   samples/s   achieved interval')
for (const interval of INTERVALS) {
  const counts = []
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval })
    await post('Profiler.start')
    burn(RUN_MS)
    const { profile } = await post('Profiler.stop')
    counts.push(profile.samples?.length ?? 0)
  }
  counts.sort((a, b) => a - b)
  const samples = counts[Math.floor(counts.length / 2)]
  const perSecond = samples / (RUN_MS / 1000)
  const achievedUs = samples === 0 ? Infinity : (RUN_MS * 1000) / samples
  console.log(
    '  ' + String(interval).padStart(6) + 'us' +
    String(samples).padStart(10) +
    String(Math.round(perSecond)).padStart(12) +
    ('  ' + achievedUs.toFixed(0) + 'us').padStart(20),
  )
}
session.disconnect()
