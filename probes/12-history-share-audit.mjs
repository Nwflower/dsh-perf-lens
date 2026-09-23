/**
 * Probe 12 — audit a real perf-lens history for "why is the harness row huge?".
 *
 * Reads the JSONL snapshots this plugin writes to $DSH_HOME/perf-lens and
 * answers three questions a single snapshot cannot:
 *
 *   1. SHARE — what fraction of active samples each owner held, per window.
 *      This is what the board shows, and it is the misleading number: its
 *      denominator excludes idle samples, so on a host that is idle 95% of the
 *      time a handful of samples reads as a large percentage.
 *   2. ABSOLUTE — CPU milliseconds per second of sampled wall time. This is the
 *      quantity a human actually cares about, and it is usually two orders of
 *      magnitude smaller than the share suggests.
 *   3. RANKING — the per-package harness ranking. The board folds every
 *      `harness:<pkg>` into one row, which hides exactly the answer. Windows
 *      recorded before the fold still contain the individual rows, so both
 *      representations can be compared in one log.
 *
 * Measured on this machine (743 windows over two log files, 2746s sampled,
 * 92.9% idle) — ms per second of sampled wall time, i.e. share of one core
 * divided by 100:
 *   runtime:*                        41.7 ms/s   (4.2% of one core)  <- the real top
 *   harness:@deepseek-ai/dsh          3.1 ms/s
 *   self (perf-lens itself)           2.8 ms/s
 *   harness:...dsh-subprocess-local   1.5 ms/s
 *   harness:...dsh-client-hmr         1.3 ms/s   (50% mean SHARE, 1.3 ms/s ABSOLUTE)
 *   all harness together              ~7.5 ms/s  (0.75% of one core)
 *
 * The lesson: the share column said the harness was ~75% of the host, while its
 * absolute cost was under 1% of one core. A large share on an idle host is a
 * small denominator, not a large cost.
 *
 * Run: node probes/12-history-share-audit.mjs [file.jsonl ...]
 * Defaults to every metrics-*.jsonl in $DSH_HOME/perf-lens.
 */
import { createReadStream, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
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
    console.error(`no history directory at ${dir}`)
    process.exit(1)
  }
  if (names.length === 0) {
    console.error(`no metrics-*.jsonl in ${dir}`)
    process.exit(1)
  }
  files = names.map((name) => join(dir, name))
}

const isHarness = (n) => n === 'harness' || n.startsWith('harness:')
const isRuntime = (n) => n === 'runtime' || n.startsWith('runtime:')
const isSelf = (n) => n === 'self' || n.startsWith('self:')

/** @type {Map<string, {ms:number, shareSum:number, windows:number, peak:number, firstAt:number, lastAt:number}>} */
const cum = new Map()
const perWindow = []
let sampledMs = 0
let totalSamples = 0
let idleSamples = 0
let windowsWithFold = 0
let windowsWithSub = 0

for (const file of files) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.trim() === '') continue
    let snap
    try { snap = JSON.parse(line) } catch { continue }
    if (!Array.isArray(snap.plugins)) continue
    const g = snap.global ?? {}
    const windowMs = g.sampleWindowMs ?? 5000
    sampledMs += windowMs
    totalSamples += g.sampleCount ?? 0
    idleSamples += g.idleSamples ?? 0
    const active = Math.max(0, (g.sampleCount ?? 0) - (g.idleSamples ?? 0))
    let sawFold = false
    let sawSub = false
    let harnessShare = 0
    let externalShare = 0
    let runtimeShare = 0
    let selfShare = 0
    for (const row of snap.plugins) {
      const name = row.moduleName
      if (isHarness(name)) { harnessShare += row.cpuShare; if (name === 'harness') sawFold = true; else sawSub = true }
      else if (isRuntime(name)) runtimeShare += row.cpuShare
      else if (isSelf(name)) selfShare += row.cpuShare
      else if (name !== 'idle' && name !== 'unattributed') externalShare += row.cpuShare
      if (row.cpuSelfMs > 0) {
        const e = cum.get(name) ?? { ms: 0, shareSum: 0, windows: 0, peak: 0, firstAt: snap.windowStartedAt, lastAt: snap.windowStartedAt }
        e.ms += row.cpuSelfMs
        e.shareSum += row.cpuShare
        e.windows += 1
        if (row.cpuShare > e.peak) e.peak = row.cpuShare
        e.lastAt = snap.windowStartedAt
        cum.set(name, e)
      }
    }
    if (sawFold) windowsWithFold += 1
    if (sawSub) windowsWithSub += 1
    perWindow.push({ at: snap.windowStartedAt, active, harnessShare, externalShare, runtimeShare, selfShare })
  }
}

const pct = (x) => `${(x * 100).toFixed(2)}%`
const secs = sampledMs / 1000
const fmtTime = (at) => new Date(at).toISOString().slice(5, 19).replace('T', ' ')

console.log(`files: ${files.length}`)
console.log(`windows: ${perWindow.length}   sampled: ${secs.toFixed(0)}s   idle share: ${pct(totalSamples === 0 ? 0 : idleSamples / totalSamples)}`)
console.log(`windows using the folded 'harness' row: ${windowsWithFold}   using 'harness:<pkg>' rows: ${windowsWithSub}`)
console.log('')

// ---------------------------------------------------------------------------
// 1. Absolute cost per owner. The honest headline.
// ---------------------------------------------------------------------------
console.log('=== ABSOLUTE: CPU ms per second of sampled wall time ===')
console.log('  ms/sampled-sec   mean share   peak share   windows   module')
for (const [name, e] of [...cum].sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(
    `  ${(e.ms / secs).toFixed(2).padStart(13)}   ${pct(e.shareSum / e.windows).padStart(10)}   ` +
      `${pct(e.peak).padStart(10)}   ${String(e.windows).padStart(7)}   ${name}`,
  )
}

const sumOf = (pred) => [...cum].filter(([n]) => pred(n)).reduce((a, [, e]) => a + e.ms, 0)
const harnessMs = sumOf(isHarness)
const externalMs = sumOf((n) => !isHarness(n) && !isRuntime(n) && !isSelf(n))
const runtimeMs = sumOf(isRuntime)
const selfMs = sumOf(isSelf)
console.log('')
console.log('=== group totals ===')
for (const [label, ms] of [['harness', harnessMs], ['external plugins', externalMs], ['runtime:*', runtimeMs], ['self (perf-lens)', selfMs]]) {
  const perSec = ms / secs
  console.log(`  ${label.padEnd(18)} ${ms.toFixed(0).padStart(8)} ms   ${perSec.toFixed(2).padStart(6)} ms/sampled-sec   = ${(perSec / 10).toFixed(2)}% of one core`)
}
console.log('')
console.log('Read this together: a large SHARE with a tiny ms/s means the host was idle,')
console.log('not that the owner is expensive. Only ms/sampled-sec is comparable across hosts.')

// ---------------------------------------------------------------------------
// 2. Harness ranking, recovered from windows recorded before the fold.
// ---------------------------------------------------------------------------
const sub = [...cum].filter(([n]) => n.startsWith('harness:')).sort((a, b) => b[1].ms - a[1].ms)
console.log('')
console.log('=== RANKING: harness subpackages (the fold hides this) ===')
if (sub.length === 0) {
  console.log('  none in this log — every window already used the folded row.')
  console.log('  To recover the ranking, capture with the fold disabled, or read')
  console.log('  /api-perf/diagnostics ownerKeys for the raw keys of the last window.')
} else {
  for (const [name, e] of sub) {
    console.log(
      `  ${(e.ms / secs).toFixed(2).padStart(6)} ms/s   ${pct(e.peak).padStart(7)} peak   ` +
        `${String(e.windows).padStart(4)} win   ${fmtTime(e.firstAt)}..${fmtTime(e.lastAt)}   ${name}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 3. Per-window shape: one burst or steady state?
// ---------------------------------------------------------------------------
const busy = perWindow.filter((w) => w.active >= 100)
console.log('')
console.log(`=== SHAPE: windows with >=100 active samples (${busy.length} / ${perWindow.length}) ===`)
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
if (busy.length > 0) {
  console.log(`  mean harness ${pct(mean(busy.map((w) => w.harnessShare)))}   external ${pct(mean(busy.map((w) => w.externalShare)))}   runtime ${pct(mean(busy.map((w) => w.runtimeShare)))}   self ${pct(mean(busy.map((w) => w.selfShare)))}`)
}
const busiest = perWindow.filter((w) => w.active >= 500).sort((a, b) => b.active - a.active)
console.log(`  genuinely busy windows (>=500 active samples): ${busiest.length}`)
for (const w of busiest.slice(0, 10)) {
  console.log(
    `    ${fmtTime(w.at)}  active ${String(w.active).padStart(5)}  harness ${pct(w.harnessShare).padStart(7)}  ` +
      `external ${pct(w.externalShare).padStart(7)}  runtime ${pct(w.runtimeShare).padStart(7)}  self ${pct(w.selfShare).padStart(7)}`,
  )
}