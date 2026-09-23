/**
 * Probe 18 — what does the sentinel tier actually cost?
 *
 * The two-tier design (docs/design-overnight-analyzer.md §13.6/13.7) runs a
 * cheap coarse probe during the 120s idle backoff and only pays for a fine
 * window when the probe finds activity. This measures the real sample counts
 * for the two tiers and turns them into the extra budget the probes add.
 *
 * Run: node probes/18-sentinel-cost.mjs
 */
import inspector from 'node:inspector'

const session = new inspector.Session()
session.connect()
const post = (method, params) => new Promise((resolve, reject) => {
  session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result)))
})

/** Busy work that cannot be optimised away. */
function burn(ms) {
  const end = performance.now() + ms
  let sink = 0
  while (performance.now() < end) {
    for (let i = 0; i < 20000; i++) sink = Math.sin(sink + 1.0000001) + sink * 0.5
    globalThis.__sink = sink
  }
}

const CONFIGS = [
  { name: 'sentinel', intervalUs: 10_000, runMs: 1_000 },
  { name: 'fine', intervalUs: 250, runMs: 5_000 },
]
const REPEATS = 3
const BACKOFF_MS = 120_000
const PROBE_EVERY_MS = 10_000

async function measure(config) {
  const counts = []
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: config.intervalUs })
    await post('Profiler.start')
    burn(config.runMs)
    const { profile } = await post('Profiler.stop')
    counts.push(profile.samples?.length ?? 0)
  }
  counts.sort((a, b) => a - b)
  return counts[Math.floor(counts.length / 2)]
}

console.log('tier sample counts (median of ' + REPEATS + ')')
console.log('')
const measured = {}
for (const config of CONFIGS) {
  const samples = await measure(config)
  measured[config.name] = samples
  console.log(
    '  ' + config.name.padEnd(9) +
    String(config.intervalUs).padStart(7) + 'us' +
    String(config.runMs).padStart(7) + 'ms' +
    String(samples).padStart(9) + ' samples',
  )
}

// The loop probes after each 10s slice except the last, so 120s yields 11.
const probes = Math.max(0, Math.ceil(BACKOFF_MS / PROBE_EVERY_MS) - 1)
const fine = measured.fine ?? 0
const sentinel = measured.sentinel ?? 0
const extra = fine === 0 ? Infinity : (100 * probes * sentinel) / fine

console.log('')
console.log('per ' + BACKOFF_MS / 1000 + 's idle backoff:')
console.log('  probes:                 ' + probes)
console.log('  probe samples total:    ' + probes * sentinel)
console.log('  one fine window:        ' + fine)
console.log('  extra sampling budget:  ' + extra.toFixed(1) + '%')
session.disconnect()
