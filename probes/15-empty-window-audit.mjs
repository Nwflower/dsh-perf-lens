/**
 * Probe 15 — how empty is an "empty window", and what actually limits precision?
 *
 * The board can look blank on an idle host. This probe separates the three
 * different things that phrase can mean, using the real history:
 *
 *   1. NO SAMPLES: does a window ever collect nothing? (V8 always emits
 *      samples, idle ones included, so this should never happen.)
 *   2. NO ATTRIBUTION: every sample landed on idle/runtime/harness, so no
 *      plugin row shows cost.
 *   3. BELOW RESOLUTION: the work happened but is smaller than one sample's
 *      worth of CPU (interval ms), so it reads as 0 or 1 sample.
 *
 * It also measures the cadence the idle backoff produces (gap between windows),
 * because "few windows per hour" is what makes a spike easy to miss even when
 * each window is fine.
 *
 * Run: node probes/15-empty-window-audit.mjs [file.jsonl ...]
 * Defaults to every metrics-*.jsonl in $DSH_HOME/perf-lens.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = process.env.DSH_HOME === undefined
  ? join(homedir(), '.dsh', 'perf-lens')
  : join(process.env.DSH_HOME, 'perf-lens')

let files = process.argv.slice(2)
if (files.length === 0) {
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    console.error('no history directory at ' + dir)
    process.exit(1)
  }
  files = names.map((name) => join(dir, name))
}

/** Sampling interval actually used for a window's mode (see DEFAULTS). */
const INTERVAL_MS = { duty: 0.25, continuous: 0.25, background: 1, paused: 0.25 }

const windows = []
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const snap = JSON.parse(trimmed)
      if (snap?.global === undefined) continue
      windows.push(snap)
    } catch { /* malformed line */ }
  }
}
windows.sort((a, b) => a.windowStartedAt - b.windowStartedAt)
if (windows.length === 0) {
  console.error('no windows found')
  process.exit(1)
}

const rows = windows.map((snap) => {
  const global = snap.global
  const active = Math.max(0, global.sampleCount - global.idleSamples)
  const interval = INTERVAL_MS[snap.mode] ?? 0.25
  const pluginMs = snap.plugins.map((row) => row.cpuSelfMs)
  const attributed = pluginMs.reduce((sum, value) => sum + value, 0)
  const top = pluginMs.length === 0 ? 0 : Math.max(...pluginMs)
  // Legacy records (no idleSamples field) report sampleCount 0; they are not
  // "empty windows" in the runtime sense, so mark them for exclusion.
  const nonzero = pluginMs.filter((value) => value > 0).length
  return {
    at: snap.windowStartedAt,
    mode: snap.mode,
    sampleCount: global.sampleCount,
    idleSamples: global.idleSamples,
    active,
    interval,
    activeCpuMs: active * interval,
    top,
    attributed,
    nonzero,
    plugins: snap.plugins.length,
    windowMs: global.sampleWindowMs,
  }
})

const total = rows.length
const zeroActive = rows.filter((row) => row.active === 0)
const tinyActive = rows.filter((row) => row.active > 0 && row.active < 100)
const noAttribution = rows.filter((row) => row.attributed === 0)
const belowResolution = rows.filter((row) => row.top > 0 && row.top < row.interval)
const underFiveSamples = rows.filter((row) => row.top > 0 && row.top < row.interval * 5)

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  return sorted[Math.floor(sorted.length / 2)]
}

console.log('windows ' + total + ' over ' + files.length + ' file(s)')
console.log('')
console.log('--- 1. did a window ever collect NO samples? ---')
console.log('  windows with sampleCount == 0:            ' + rows.filter((row) => row.sampleCount === 0).length)
console.log('  windows with ZERO active (non-idle) samples: ' + zeroActive.length + ' (' + pct(zeroActive.length, total) + ')')
console.log('  windows with < 100 active samples:         ' + tinyActive.length + ' (' + pct(tinyActive.length, total) + ')')
const activeCounts = rows.map((r) => r.active)
console.log('  active samples per window: min ' + Math.min(...activeCounts)
  + '  median ' + median(activeCounts)
  + '  max ' + Math.max(...activeCounts))
const withSamples = rows.filter((r) => r.sampleCount > 0)
const meanIdle = withSamples.length === 0 ? 0 : withSamples.reduce((s, r) => s + r.idleSamples / r.sampleCount, 0) / withSamples.length
console.log('  idle share (windows with samples): mean ' + pct(meanIdle, 1))
console.log('  windows missing the idleSamples field (legacy records): ' + rows.filter((r) => r.idleSamples === undefined).length)
console.log('')
console.log('--- 2. did a window attribute nothing to any plugin? ---')
console.log('  windows with attributed plugin CPU == 0:   ' + noAttribution.length + ' (' + pct(noAttribution.length, total) + ')')
console.log('  plugin rows per window: median ' + median(rows.map((r) => r.plugins))
  + '   windows with zero rows: ' + rows.filter((r) => r.plugins === 0).length)
console.log('')
console.log('--- 3. is the work below the sampling resolution? ---')
console.log('  resolution = interval x 1 sample (ms): duty ' + INTERVAL_MS.duty + ', background ' + INTERVAL_MS.background)
console.log('  top-plugin CPU per window: median ' + median(rows.map((r) => r.top)).toFixed(2) + 'ms'
  + '  p90 ' + percentile(rows.map((r) => r.top), 0.9).toFixed(2) + 'ms'
  + '  max ' + Math.max(...rows.map((r) => r.top)).toFixed(2) + 'ms')
console.log('  windows whose TOP plugin is below 1 sample:  ' + belowResolution.length + ' (' + pct(belowResolution.length, total) + ')')
console.log('  windows whose TOP plugin is below 5 samples: ' + underFiveSamples.length + ' (' + pct(underFiveSamples.length, total) + ')')
console.log('')
console.log('--- 4. cadence: how often is a window even taken? ---')
const gaps = []
for (let i = 1; i < rows.length; i++) {
  const gap = rows[i].at - rows[i - 1].at
  if (gap > 0) gaps.push(gap / 1000)
}
if (gaps.length > 0) {
  console.log('  seconds between windows: median ' + median(gaps).toFixed(1)
    + '  p90 ' + percentile(gaps, 0.9).toFixed(1)
    + '  max ' + Math.max(...gaps).toFixed(1))
  const sampledSec = rows.reduce((s, r) => s + r.windowMs / 1000, 0)
  const spanSec = (rows[rows.length - 1].at - rows[0].at) / 1000
  console.log('  sampled wall time ' + sampledSec.toFixed(0) + 's over a ' + spanSec.toFixed(0) + 's span'
    + ' (' + pct(sampledSec, spanSec) + ' duty cycle)')
}
console.log('')
console.log('--- 5. what the sampler explains of the window (CPU only, sampled) ---')
const activeCpu = rows.reduce((s, r) => s + (Number.isFinite(r.activeCpuMs) ? r.activeCpuMs : 0), 0)
const wall = rows.reduce((s, r) => s + r.windowMs, 0)
console.log('  active samples x interval = ' + (activeCpu / 1000).toFixed(2) + 's CPU over ' + (wall / 1000).toFixed(0) + 's wall'
  + ' = ' + (activeCpu / wall * 100).toFixed(2) + '% of one core')
console.log('  NOTE: this is sampled CPU. A process-level reading (process.cpuUsage) is not')
console.log('  in the log yet, so the share of REAL process CPU the sampler explains cannot')
console.log('  be computed from history — that gap is what the panel now fills per window.')

function pct(part, whole) { return whole === 0 ? '0%' : (part / whole * 100).toFixed(1) + '%' }
function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}
