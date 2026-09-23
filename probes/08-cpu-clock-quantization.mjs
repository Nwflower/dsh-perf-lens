/**
 * Probe 08 — `process.cpuUsage()` clock quantization.
 *
 * Answers "why does cpuUsage read 0 for a loop that takes 5.8ms of wall time?".
 * On this Windows host the CPU clock advances in ~15.6ms steps, so a slice
 * shorter than one step reads as either 0 or 16ms. Any per-window "own CPU
 * overhead" figure built from cpuUsage deltas is therefore quantized to zero.
 *
 * This invalidated three earlier attempts at measuring sampler cost by CPU time
 * (see probes/09-sampler-cost-matrix.mjs for the method that survived).
 *
 * Run: node probes/08-cpu-clock-quantization.mjs
 */
let seed = 123456789
const nr = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const N = new Float64Array(4_000_000)
for (let i = 0; i < N.length; i++) N[i] = nr()
const S = new Float64Array(64)

function sliceA() {
  let s = 0
  for (let i = 0; i < N.length; i++) s += Math.sqrt(N[i]) * 1.0000001
  S[0] = s
  return s
}

// Same loop, but reading through a local binding and writing via a function the
// optimizer cannot see through.
function sliceB() {
  const arr = N
  let s = 0
  for (let i = 0; i < arr.length; i++) s += Math.sqrt(arr[i])
  globalThis.__sink = s
  return s
}

function meas(label, fn) {
  for (let i = 0; i < 30; i++) fn()
  const rows = []
  for (let i = 0; i < 7; i++) {
    const c = process.cpuUsage()
    const w = performance.now()
    fn()
    const wall = performance.now() - w
    const d = process.cpuUsage(c)
    rows.push(`${((d.user + d.system) / 1000).toFixed(2)}ms cpu / ${wall.toFixed(2)}ms wall`)
  }
  console.log(`${label}:`)
  for (const r of rows) console.log(`   ${r}`)
}

meas('sliceA (sqrt * const, write Float64Array)', sliceA)
meas('sliceB (sqrt only, write globalThis)', sliceB)

// A loop whose cost cannot be constant-folded at all.
function sliceC(n) {
  let s = 0
  for (let i = 0; i < n; i++) s = Math.sin(s + 1.0000001) + s * 0.5
  globalThis.__sink = s
  return s
}
meas('sliceC (dependent sin chain)', () => sliceC(2_000_000))