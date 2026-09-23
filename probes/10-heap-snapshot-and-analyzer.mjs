/**
 * Probe 10 — what an out-of-process analyzer would cost.
 *
 * A child process cannot make snapshot generation cheaper (V8 generates the
 * snapshot in the process that owns the heap), but it can absorb everything
 * after that: JSON parse, graph build, dominator tree for retained size, and
 * attribution of every object to a plugin. This probe measures that second
 * half — the part that would otherwise run in the host.
 *
 * It also measures the WRONG way to attribute memory (by allocation site) next
 * to the RIGHT way (nearest plugin frame on the retaining path), so the design
 * can state which one it implements.
 *
 * Three attempts were needed to build a heap that is really in the V8 heap:
 * Buffers land in external memory, and `bigString + suffix` produces a rope
 * that V8 stores as a pointer. Only runtime-built flat strings gave a real
 * 668MB heap (310k nodes) to measure against.
 *
 * Run: node --max-old-space-size=4096 probes/10-heap-snapshot-and-analyzer.mjs
 *      PROBE_HEAP_MB=600 to scale the heap (default 300)
 */
import v8 from 'node:v8'
import { readFileSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TARGET_MB = Number(process.env.PROBE_HEAP_MB ?? 300)

// ---------------------------------------------------------------------------
// Build a heap that looks like a host: two "plugins" with their own retained
// graphs, plus a shared cache retained by both, plus churn.
// ---------------------------------------------------------------------------
const pluginA = []
const pluginB = []
const sharedCache = []
// Retain into the V8 heap, not into Buffers/ArrayBuffers. Third attempt, and
// the earlier two failures are the lesson: Buffers land in external memory, and
// `BLOB + 'A' + i` makes a CONCATENATED ROPE, so V8 stored a pointer instead of
// 10KB (heapUsed stayed at 14MB). A string built by String.fromCharCode over
// runtime-varying data is a real, flat, in-heap object that cannot be folded.
function makeBlob(tag, index) {
  const codes = Array.from({ length: 10 * 1024 }, () => 0)
  for (let i = 0; i < codes.length; i++) codes[i] = 32 + ((index + i * 7 + tag) % 90)
  return String.fromCharCode(...codes)
}
const PER_PLUGIN = Math.max(1, Math.round((TARGET_MB * 1024 * 1024) / 3 / (10 * 1024)))
for (let i = 0; i < PER_PLUGIN; i++) {
  pluginA.push({ owner: 'pluginA', index: i, blob: makeBlob(1, i), nested: [i, i + 1] })
  pluginB.push({ owner: 'pluginB', index: i, blob: makeBlob(2, i), nested: [i, i + 1] })
  sharedCache.push({ owner: 'shared', index: i, blob: makeBlob(3, i), nested: [i, i + 1] })
}
for (let i = 0; i < 300_000; i++) {
  const transient = { i, text: `t${i}`, nested: [i, i + 1] }
  if (transient.i === -1) console.log('never')
}
globalThis.__retain = { pluginA, pluginB, sharedCache }

const heap = process.memoryUsage()
console.log(`node ${process.version}`)
console.log(`heap: rss ${mb(heap.rss)}MB  heapUsed ${mb(heap.heapUsed)}MB  external ${mb(heap.external)}MB`)

const snapshotPath = join(tmpdir(), 'dsh-perf-lens-p3.heapsnapshot')
const before = process.cpuUsage()
const wallStart = performance.now()
v8.writeHeapSnapshot(snapshotPath)
const genMs = performance.now() - wallStart
const genCpu = process.cpuUsage(before)
console.log(
  `snapshot generation (main process): wall ${genMs.toFixed(0)}ms  cpu ${((genCpu.user + genCpu.system) / 1000).toFixed(0)}ms` +
    `  file ${mb(statSync(snapshotPath).size)}MB\n`,
)

// ---------------------------------------------------------------------------
// Phase 1: parse + build the graph.
// ---------------------------------------------------------------------------
const cpu0 = process.cpuUsage()
const t0 = performance.now()
const raw = readFileSync(snapshotPath, 'utf8')
const tRead = performance.now()
const snapshot = JSON.parse(raw)
const tParse = performance.now()

const meta = snapshot.snapshot.meta
const nodeFields = meta.node_fields
const edgeFields = meta.edge_fields
const nodeFieldCount = nodeFields.length
const edgeFieldCount = edgeFields.length
const strings = snapshot.strings
const nodeCount = snapshot.nodes.length / nodeFieldCount
const totalEdges = snapshot.edges.length / edgeFieldCount

const typeIdx = nodeFields.indexOf('type')
const nameIdx = nodeFields.indexOf('name')
const sizeIdx = nodeFields.indexOf('self_size')
const edgeCountIdx = nodeFields.indexOf('edge_count')
const nodeType = new Uint8Array(nodeCount)
const nodeName = new Uint32Array(nodeCount)
const nodeSelf = new Float64Array(nodeCount)
for (let i = 0; i < nodeCount; i++) {
  const base = i * nodeFieldCount
  nodeType[i] = snapshot.nodes[base + typeIdx]
  nodeName[i] = snapshot.nodes[base + nameIdx]
  nodeSelf[i] = snapshot.nodes[base + sizeIdx]
}

const firstEdge = new Uint32Array(nodeCount + 1)
for (let i = 0; i < nodeCount; i++) {
  firstEdge[i + 1] = firstEdge[i] + snapshot.nodes[i * nodeFieldCount + edgeCountIdx]
}
const edgeTo = new Uint32Array(totalEdges)
const edgeToIdx = edgeFields.indexOf('to_node')
for (let e = 0; e < totalEdges; e++) {
  edgeTo[e] = snapshot.edges[e * edgeFieldCount + edgeToIdx] / nodeFieldCount
}
snapshot.nodes = null
snapshot.edges = null
const tGraph = performance.now()

console.log('--- phase 1: parse + graph build ---')
console.log(`  read ${mb(raw.length)}MB text        ${(tRead - t0).toFixed(0)}ms`)
console.log(`  JSON.parse                     ${(tParse - tRead).toFixed(0)}ms`)
console.log(`  typed-array graph              ${(tGraph - tParse).toFixed(0)}ms`)
console.log(`  nodes ${nodeCount.toLocaleString()}  edges ${totalEdges.toLocaleString()}  strings ${strings.length.toLocaleString()}`)

// ---------------------------------------------------------------------------
// Phase 2: dominator tree (Lengauer-Tarjan, iterative) -> retained sizes.
// ---------------------------------------------------------------------------
const tDomStart = performance.now()

const dfsOrder = new Uint32Array(nodeCount)
const dfsIndex = new Int32Array(nodeCount).fill(-1)
const parent = new Int32Array(nodeCount).fill(-1)
let reachable = 0
{
  const stack = [0]
  dfsIndex[0] = 0
  dfsOrder[0] = 0
  reachable = 1
  while (stack.length > 0) {
    const v = stack.pop()
    for (let e = firstEdge[v]; e < firstEdge[v + 1]; e++) {
      const w = edgeTo[e]
      if (dfsIndex[w] === -1) {
        dfsIndex[w] = reachable
        dfsOrder[reachable] = w
        parent[reachable] = dfsIndex[v]
        reachable += 1
        stack.push(w)
      }
    }
  }
}

const predCount = new Uint32Array(reachable + 1)
for (let i = 1; i < reachable; i++) predCount[parent[i] + 1] += 1
for (let i = 1; i < reachable; i++) predCount[i + 1] += predCount[i]
const predList = new Uint32Array(predCount[reachable])
{
  const cursor = predCount.slice(0, reachable)
  for (let i = 1; i < reachable; i++) {
    const v = dfsOrder[i]
    for (let e = firstEdge[v]; e < firstEdge[v + 1]; e++) {
      const wi = dfsIndex[edgeTo[e]]
      if (wi > 0) predList[cursor[wi]++] = i
    }
  }
}

const semi = new Uint32Array(reachable)
const idom = new Uint32Array(reachable)
const ancestor = new Uint32Array(reachable)
const label = new Uint32Array(reachable)
const bucketHead = new Int32Array(reachable).fill(-1)
const bucketNext = new Int32Array(reachable).fill(-1)
for (let i = 0; i < reachable; i++) {
  semi[i] = i
  label[i] = i
}

function compress(v) {
  const path = []
  let u = v
  while (ancestor[ancestor[u]] !== 0) {
    path.push(u)
    u = ancestor[u]
  }
  while (path.length > 0) {
    const w = path.pop()
    if (semi[label[ancestor[w]]] < semi[label[w]]) label[w] = label[ancestor[w]]
    ancestor[w] = ancestor[ancestor[w]]
  }
}
function evalNode(v) {
  if (ancestor[v] === 0) return label[v]
  compress(v)
  return label[v]
}

for (let i = reachable - 1; i >= 1; i--) {
  for (let p = predCount[i]; p < predCount[i + 1]; p++) {
    const u = evalNode(predList[p])
    if (semi[u] < semi[i]) semi[i] = semi[u]
  }
  const s = semi[i]
  bucketNext[i] = bucketHead[s]
  bucketHead[s] = i
  ancestor[i] = parent[i]
  for (let v = bucketHead[parent[i]]; v !== -1; v = bucketNext[v]) {
    const u = evalNode(v)
    idom[v] = semi[u] < semi[v] ? u : parent[i]
  }
  bucketHead[parent[i]] = -1
}
for (let i = 1; i < reachable; i++) {
  if (idom[i] !== semi[i]) idom[i] = idom[idom[i]]
}

const retained = new Float64Array(nodeCount)
for (let i = 0; i < reachable; i++) retained[dfsOrder[i]] = nodeSelf[dfsOrder[i]]
for (let i = reachable - 1; i >= 1; i--) {
  retained[dfsOrder[idom[i]]] += retained[dfsOrder[i]]
}

const tDom = performance.now()
console.log('\n--- phase 2: dominator tree ---')
console.log(`  reachable ${reachable.toLocaleString()} / ${nodeCount.toLocaleString()} nodes`)
console.log(`  Lengauer-Tarjan + retained sizes   ${(tDom - tDomStart).toFixed(0)}ms`)

// ---------------------------------------------------------------------------
// Phase 3: attribution, both ways.
// ---------------------------------------------------------------------------
const tAttrStart = performance.now()

const RULES = [
  { match: (s) => s.includes('pluginA'), owner: 'pluginA' },
  { match: (s) => s.includes('pluginB'), owner: 'pluginB' },
]
const ownerCache = new Map()
function ownerForNode(nodeIndex) {
  const cached = ownerCache.get(nodeIndex)
  if (cached !== undefined) return cached
  const name = strings[nodeName[nodeIndex]] ?? ''
  let owner = null
  for (const rule of RULES) if (rule.match(name)) { owner = rule.owner; break }
  ownerCache.set(nodeIndex, owner)
  return owner
}

// (a) allocation-site style: charge self size to the node's own owner only.
const bySelf = new Map()
for (let i = 0; i < nodeCount; i++) {
  const owner = ownerForNode(i)
  if (owner === null) continue
  bySelf.set(owner, (bySelf.get(owner) ?? 0) + nodeSelf[i])
}

// (b) retaining-path style: each object is charged to the nearest plugin frame
// on its path from the root. Propagated in reverse DFS order (parents before
// children), so it is O(V+E) and needs no per-path stack.
const nearest = Array.from({ length: reachable }, () => null)
for (let i = 0; i < reachable; i++) {
  const node = dfsOrder[i]
  const own = ownerForNode(node)
  const inherited = i === 0 ? null : nearest[parent[i]]
  nearest[i] = own ?? inherited
}
const byPath = new Map()
for (let i = 0; i < reachable; i++) {
  const owner = nearest[i]
  if (owner === null) continue
  byPath.set(owner, (byPath.get(owner) ?? 0) + nodeSelf[dfsOrder[i]])
}

const tAttr = performance.now()
console.log('\n--- phase 3: attribution ---')
console.log(`  walk + tally                       ${(tAttr - tAttrStart).toFixed(0)}ms`)
console.log('  by node self size (allocation-site; not ownership):')
for (const [owner, bytes] of [...bySelf].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${owner.padEnd(10)} ${mb(bytes).padStart(8)}MB`)
}
console.log('  by nearest plugin frame on retaining path (ownership):')
for (const [owner, bytes] of [...byPath].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${owner.padEnd(10)} ${mb(bytes).padStart(8)}MB`)
}

const cpuTotal = process.cpuUsage(cpu0)
const totalMs = performance.now() - t0
console.log('\n--- totals for the analyzer process (post-generation) ---')
console.log(`  wall ${totalMs.toFixed(0)}ms  cpu ${((cpuTotal.user + cpuTotal.system) / 1000).toFixed(0)}ms`)
console.log(`  peak rss ${mb(process.memoryUsage().rss)}MB`)
console.log(`  file bytes on disk ${mb(statSync(snapshotPath).size)}MB`)

rmSync(snapshotPath, { force: true })

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1)
}