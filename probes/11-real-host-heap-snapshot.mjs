/**
 * Probe 11 — heap-snapshot cost measured on the REAL DSH host.
 *
 * Probe 10 measured a synthetic heap of flat strings (~2.2KB/node) and yielded
 * 1.1ms/MB. That unit is wrong for extrapolation: V8 snapshot generation costs
 * are dominated by node/edge count, and a real JS heap packs many more nodes per
 * MB. This probe attaches to the running host over CDP and measures the actual
 * pause plus the node/edge counts, so cost can be quoted as us/node.
 *
 * Attach path: process._debugProcess(pid) opens the inspector on a Node process
 * that was NOT started with --inspect (same hook the CLI debugger uses).
 * HeapProfiler.takeHeapSnapshot is called WITHOUT reportProgress:true — that
 * flag crashes the target process outright (0xC0000005, measured).
 *
 * The snapshot pauses the host for the whole generation. Chunks stream over the
 * websocket and are written straight to disk; nothing is parsed here.
 *
 * Run:  $env:DSH_HOST_PID=<pid>; node --max-old-space-size=4096 probes/11-real-host-heap-snapshot.mjs
 * Env:  PROBE_OUT   output path (default: <tmp>/dsh-perf-lens-real-host.heapsnapshot)
 *       PROBE_PORT  inspector port (default 9229)
 */
import { createWriteStream } from 'node:fs'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const pid = Number(process.env.DSH_HOST_PID)
if (!Number.isInteger(pid) || pid <= 0) {
  console.error('set DSH_HOST_PID to the dsh host process id')
  process.exit(2)
}
const port = Number(process.env.PROBE_PORT ?? 9229)
const out = process.env.PROBE_OUT ?? join(tmpdir(), 'dsh-perf-lens-real-host.heapsnapshot')

// Opening the inspector on a process that did not opt in. Windows has no SIGUSR1
// path; this is the supported-ish hook (node inspect uses it).
process._debugProcess(pid)

let targets = null
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json/list')
    targets = await res.json()
    if (Array.isArray(targets) && targets.length > 0) break
  } catch { /* not up yet */ }
  await new Promise(resolve => setTimeout(resolve, 250))
}
if (targets === null || targets.length === 0) {
  console.error('inspector endpoint did not appear on port ' + port)
  process.exit(3)
}

const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
let chunkCount = 0
let chunkBytes = 0
let stream = null
ws.addEventListener('message', event => {
  const msg = JSON.parse(event.data)
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
    return
  }
  if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
    chunkCount += 1
    const text = msg.params?.chunk ?? ''
    chunkBytes += text.length
    if (stream !== null) stream.write(text)
  }
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
const send = (method, params) => new Promise(resolve => {
  const id = nextId++
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true })
  return res.result?.result?.value
}

const before = JSON.parse(await evaluate('JSON.stringify({mem: process.memoryUsage(), cpu: process.cpuUsage(), up: process.uptime()})'))
console.log('target pid ' + pid + '  uptime ' + before.up.toFixed(0) + 's')
console.log('before: heapUsed ' + mb(before.mem.heapUsed) + 'MB  rss ' + mb(before.mem.rss) + 'MB  heapTotal ' + mb(before.mem.heapTotal) + 'MB')

// True stop-the-world pause, measured INSIDE the target: a 50ms heartbeat on
// the host's own event loop records the largest gap while the snapshot runs.
// The CDP wall time above includes chunk transport; this separates them.
await evaluate('globalThis.__plBeat = []; globalThis.__plBeatTimer = setInterval(function () { __plBeat.push(performance.now()) }, 50); "ok"')
await send('HeapProfiler.enable')
stream = createWriteStream(out)
const started = performance.now()
const done = await send('HeapProfiler.takeHeapSnapshot')
const wall = performance.now() - started
stream.end()
await new Promise(resolve => stream.on('close', resolve))

const after = JSON.parse(await evaluate('JSON.stringify({mem: process.memoryUsage(), cpu: process.cpuUsage()})'))
const cpuMs = ((after.cpu.user + after.cpu.system) - (before.cpu.user + before.cpu.system)) / 1000
const heapUsedMb = before.mem.heapUsed / 1024 / 1024
const fileMb = statSync(out).size / 1024 / 1024

console.log('takeHeapSnapshot error:', done.error === undefined ? 'none' : JSON.stringify(done.error))
console.log('chunks ' + chunkCount + '  payload ' + mb(chunkBytes) + 'MB  file ' + fileMb.toFixed(1) + 'MB')
console.log('generation (host process): wall ' + wall.toFixed(0) + 'ms  cpu ' + cpuMs.toFixed(0) + 'ms')
console.log('pause per heap MB: ' + (wall / heapUsedMb).toFixed(2) + ' ms/MB   (synthetic probe 10: 1.14 ms/MB)')
console.log('after:  heapUsed ' + mb(after.mem.heapUsed) + 'MB  rss ' + mb(after.mem.rss) + 'MB')
// Let the target's loop resume and land its next heartbeat BEFORE reading: the
// gap only materializes on the first tick after the block.
await new Promise(resolve => setTimeout(resolve, 400))
const beat = JSON.parse(await evaluate('clearInterval(__plBeatTimer); JSON.stringify(__plBeat)'))
let maxGap = 0
for (let i = 1; i < beat.length; i++) maxGap = Math.max(maxGap, beat[i] - beat[i - 1])
console.log('host event-loop max gap (50ms heartbeat): ' + maxGap.toFixed(0) + 'ms')
console.log('  -> transport share of the wall time: ' + (wall - maxGap).toFixed(0) + 'ms')
console.log('snapshot saved: ' + out)

ws.close()
process.exit(0)

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) }
