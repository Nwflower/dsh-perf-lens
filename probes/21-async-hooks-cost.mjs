// Probe 21: what does an always-on async_hooks hook cost?
//
// Roadmap item 3 wants per-plugin live timer and handle gauges. async_hooks is
// the only source, but the existing fs counters enable their hook only inside a
// sampling window (17% duty at the default cadence). A live gauge cannot be
// window-scoped and still be true, so the question is what a permanently enabled
// hook costs — the same question probe 09 asked about the profilers.
//
// Method: run a promise-churn workload, a timer-churn workload and a mixed one,
// each with no hook and with an enabled hook whose init callback does only what
// the tracker's does (two Set lookups, and a stack capture only for timers and
// handles). Report the median of three runs.

import { createHook } from 'node:async_hooks'

const TIMERS = new Set(['Timeout', 'Immediate'])
const HANDLES = new Set(['TCPSERVERWRAP', 'TCPWRAP', 'PIPEWRAP', 'PIPECONNECTWRAP', 'TTYWRAP', 'SIGNALWRAP', 'UDPWRAP', 'PROCESSWRAP', 'FSEVENTWRAP', 'STATWATCHER'])

function makeHook (captureStacks) {
  return createHook({
    init: (_id, type) => {
      if (!TIMERS.has(type) && !HANDLES.has(type)) return
      if (captureStacks) void new Error().stack
    },
  })
}

async function promiseChurn (n) {
  let acc = 0
  for (let i = 0; i < n; i += 1) {
    acc += await Promise.resolve(i)
  }
  return acc
}

function timerChurn (n) {
  return new Promise(resolve => {
    let left = n
    const tick = () => { if (--left === 0) resolve() }
    for (let i = 0; i < n; i += 1) setImmediate(tick)
  })
}

async function mixed (n) {
  const pending = []
  for (let i = 0; i < n; i += 1) {
    pending.push(Promise.resolve(i).then(v => v + 1))
    if (i % 4 === 0) setImmediate(() => {})
  }
  return (await Promise.all(pending)).length
}

function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function measure (label, workload, n) {
  // warm up
  await workload(Math.floor(n / 4))
  const times = []
  for (let run = 0; run < 3; run += 1) {
    const start = process.hrtime.bigint()
    await workload(n)
    times.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  return { label, ms: median(times), times }
}

const cases = [
  ['promise churn', promiseChurn, 200_000],
  ['timer churn', timerChurn, 50_000],
  ['mixed', mixed, 100_000],
]

console.log('--- probe 21: cost of an always-on async_hooks hook ---')
for (const [label, workload, n] of cases) {
  const off = await measure(label, workload, n)
  const on = makeHook(false)
  on.enable()
  const withHook = await measure(label, workload, n)
  on.disable()
  const withStack = makeHook(true)
  withStack.enable()
  const withStackResult = await measure(label, workload, n)
  withStack.disable()
  const pct = (value) => `${((value / off.ms - 1) * 100).toFixed(1)}%`
  console.log(`${label.padEnd(15)} off ${off.ms.toFixed(0)}ms | hook ${withHook.ms.toFixed(0)}ms (${pct(withHook.ms)}) | hook+stack ${withStackResult.ms.toFixed(0)}ms (${pct(withStackResult.ms)})`)
  console.log(`  runs off=${off.times.map(t => t.toFixed(0)).join('/')} hook=${withHook.times.map(t => t.toFixed(0)).join('/')}`)
}
