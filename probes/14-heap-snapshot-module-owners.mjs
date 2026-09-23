/**
 * Probe 14 — per-plugin memory from a REAL host snapshot, by dominator partition.
 *
 * Sibling of probe 13. Probe 13 asked "what carries plugin identity in the
 * graph?" and found the anchors are code nodes / property names whose idom-chain
 * retained size is ~0.1%. This probe asks the complementary question: take each
 * module's own nodes as roots, and charge every object in the heap to exactly
 * ONE owner — the nearest module root above it in the dominator tree.
 *
 * Measured on the real host snapshot (274.6MB file, 3,811,715 nodes, 11,611,449
 * edges, 363.9MB reachable self_size):
 *
 *   parse 715ms   module roots 714ms   dominator (Lengauer-Tarjan) 400ms
 *   partition 35ms   TOTAL 2.4s   analyzer peak RSS 368MB
 *
 *   charged to a module (DOMINATOR basis): 1.2MB = 0.3% of the reachable heap
 *     harness:@deepseek-ai/dsh                 0.6MB   (53% of attributed)
 *     plugin:dsh-chat-import                   0.2MB
 *
 *   [REVIEW CORRECTION] The first version of this probe walked the DFS spanning
 *   tree instead of the dominator tree and reported 38.8MB = 10.7%. The DFS
 *   parent is whichever edge was discovered first, not a retention relation —
 *   probe 13 measured the two bases disagreeing on 89.7% of bytes. The
 *   dominator basis is what this header always claimed; it lowers the
 *   attributed heap 35x and is the number to quote.
 *
 *   3,806,344 nodes (362.7MB, 99.7%) have NO module root above them.
 *
 * The 99.7% is the finding that matters: those objects are reachable only from
 * V8 roots that no module node dominates (shapes, code strings, ArrayBuffers,
 * caches). No attribution scheme can put them on a plugin, so a per-plugin
 * memory number is inherently a tiny-coverage statistic and MUST be shown with
 * its coverage, like the disk-byte metrics (docs/AGENTS.md 4). Recovering a
 * usable per-plugin figure needs INJECTED anchors (design §11.3), not a better
 * graph walk.
 *
 * Usage: node --max-old-space-size=8192 probes/14-heap-snapshot-module-owners.mjs <file.heapsnapshot> <owner-rules.json>
 *
 * Get the rules JSON from the live host:
 *   Invoke-RestMethod http://127.0.0.1:3081/api-perf/diagnostics |
 *     ConvertTo-Json -Depth 6 | Set-Content $env:TEMP\pl-rules.json -Encoding UTF8
 */

import { readFileSync, statSync } from 'node:fs'

const path = process.argv[2]
const rulesPath = process.argv[3]
if (path === undefined || rulesPath === undefined) {
  console.error('usage: node 14-heap-snapshot-module-owners.mjs <file.heapsnapshot> <owner-rules.json>')
  process.exit(2)
}

const parsed = JSON.parse(readFileSync(rulesPath, 'utf8'))
const rules = []
for (const rule of parsed.ownerRules ?? parsed) {
  if (typeof rule.prefix !== 'string') continue
  const marker = rule.prefix.replace(/\\/g, '/').replace(/^\/[A-Za-z]:/, '')
  if (marker !== '') rules.push({ marker, name: rule.name, kind: rule.kind })
}
rules.sort((a, b) => b.marker.length - a.marker.length)

const t0 = performance.now()
const raw = readFileSync(path, 'utf8')
const tRead = performance.now()
const snap = JSON.parse(raw)
const tParse = performance.now()

const meta = snap.snapshot.meta
const nodeFields = meta.node_fields
const edgeFields = meta.edge_fields
const nfc = nodeFields.length
const efc = edgeFields.length
const strings = snap.strings
const nodeCount = snap.nodes.length / nfc
const totalEdges = snap.edges.length / efc
const typeIdx = nodeFields.indexOf('type')
const nameIdx = nodeFields.indexOf('name')
const sizeIdx = nodeFields.indexOf('self_size')
const edgeCountIdx = nodeFields.indexOf('edge_count')
const nodeTypes = meta.node_types[typeIdx]
const typeStringIdx = nodeTypes.indexOf('string')
const typeCodeIdx = nodeTypes.indexOf('code')
const typeObjectIdx = nodeTypes.indexOf('object')
const typeClosureIdx = nodeTypes.indexOf('closure')

const nodeType = new Uint8Array(nodeCount)
const nodeName = new Uint32Array(nodeCount)
const nodeSelf = new Float64Array(nodeCount)
for (let i = 0; i < nodeCount; i++) {
  const b = i * nfc
  nodeType[i] = snap.nodes[b + typeIdx]
  nodeName[i] = snap.nodes[b + nameIdx]
  nodeSelf[i] = snap.nodes[b + sizeIdx]
}
const firstEdge = new Uint32Array(nodeCount + 1)
for (let i = 0; i < nodeCount; i++) firstEdge[i + 1] = firstEdge[i] + snap.nodes[i * nfc + edgeCountIdx]
const edgeTo = new Uint32Array(totalEdges)
const edgeToIdx = edgeFields.indexOf('to_node')
for (let e = 0; e < totalEdges; e++) edgeTo[e] = snap.edges[e * efc + edgeToIdx] / nfc
snap.nodes = null
snap.edges = null

// ---------------------------------------------------------------------------
// Module roots. A string naming a package directory marks the nodes that carry
// that name: the module wrapper, its exports object, its prototypes.
// ---------------------------------------------------------------------------
const ownerOfString = new Map()
let matchedStrings = 0
for (let i = 0; i < strings.length; i++) {
  const s = strings[i]
  if (s.length < 8) continue
  for (const rule of rules) {
    if (s.includes(rule.marker)) { ownerOfString.set(i, `${rule.kind}:${rule.name}`); matchedStrings += 1; break }
  }
}
const ownerKeys = []
const ownerIndexByKey = new Map()
const intern = (key) => {
  let idx = ownerIndexByKey.get(key)
  if (idx === undefined) { idx = ownerKeys.length; ownerKeys.push(key); ownerIndexByKey.set(key, idx) }
  return idx
}
const nodeOwner = new Int32Array(nodeCount).fill(-1)
let rootNodeCount = 0
for (let i = 0; i < nodeCount; i++) {
  const t = nodeType[i]
  if (t !== typeStringIdx && t !== typeCodeIdx && t !== typeObjectIdx && t !== typeClosureIdx) continue
  const key = ownerOfString.get(nodeName[i])
  if (key === undefined) continue
  nodeOwner[i] = intern(key)
  if (t !== typeStringIdx) rootNodeCount += 1
}
const tRoots = performance.now()

// ---------------------------------------------------------------------------
// Reachability + dominator tree.
// ---------------------------------------------------------------------------
const dfsOrder = new Uint32Array(nodeCount)
const dfsIndex = new Int32Array(nodeCount).fill(-1)
const parent = new Int32Array(nodeCount).fill(-1)
let reachable = 0
{
  const stack = [0]
  dfsIndex[0] = 0; dfsOrder[0] = 0; reachable = 1
  while (stack.length > 0) {
    const v = stack.pop()
    for (let e = firstEdge[v]; e < firstEdge[v + 1]; e++) {
      const w = edgeTo[e]
      if (dfsIndex[w] === -1) {
        dfsIndex[w] = reachable; dfsOrder[reachable] = w; parent[reachable] = dfsIndex[v]
        reachable += 1; stack.push(w)
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
for (let i = 0; i < reachable; i++) { semi[i] = i; label[i] = i }
function compress(v) {
  const p = []
  let u = v
  while (ancestor[ancestor[u]] !== 0) { p.push(u); u = ancestor[u] }
  while (p.length > 0) {
    const w = p.pop()
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
  bucketNext[i] = bucketHead[s]; bucketHead[s] = i; ancestor[i] = parent[i]
  for (let v = bucketHead[parent[i]]; v !== -1; v = bucketNext[v]) {
    const u = evalNode(v)
    idom[v] = semi[u] < semi[v] ? u : parent[i]
  }
  bucketHead[parent[i]] = -1
}
for (let i = 1; i < reachable; i++) if (idom[i] !== semi[i]) idom[i] = idom[idom[i]]
const tDom = performance.now()

// Retained size (dominator subtree) for reporting, and the partition below.
const retained = new Float64Array(nodeCount)
for (let i = 0; i < reachable; i++) retained[dfsOrder[i]] = nodeSelf[dfsOrder[i]]
for (let i = reachable - 1; i >= 1; i--) retained[dfsOrder[idom[i]]] += retained[dfsOrder[i]]

// ---------------------------------------------------------------------------
// Partition: charge every node to the nearest dominator-tree ancestor that is a
// module root. Root nodes win over inherited owners, so an inner module beats
// the outer one that requires it.
// ---------------------------------------------------------------------------
// Two propagations are computed so the difference is visible rather than
// assumed (probe 13 measured them disagreeing on 89.7% of bytes):
//   - idom: an object is charged to the nearest module root among its
//     DOMINATORS. This is the ownership semantics the header claims: the
//     object could not survive without that module's subgraph.
//   - dfsParent: the original version of this probe walked the DFS spanning
//     tree instead, which charges by whichever path happened to be discovered
//     first (edge order), not by retention. Kept only as the comparison.
// Both are valid preorder walks: idom[i] < i and parent[i] < i in DFS order.
const tAttr = performance.now()
const charged = new Int32Array(reachable).fill(-1)
const chargedDfs = new Int32Array(reachable).fill(-1)
const ownerSelf = new Float64Array(ownerKeys.length)
const ownerNodes = new Float64Array(ownerKeys.length)
const ownerSelfDfs = new Float64Array(ownerKeys.length)
for (let i = 0; i < reachable; i++) {
  const node = dfsOrder[i]
  const own = nodeOwner[node]
  const inherited = i === 0 ? -1 : charged[idom[i]]
  const inheritedDfs = i === 0 ? -1 : chargedDfs[parent[i]]
  const effective = own !== -1 ? own : inherited
  const effectiveDfs = own !== -1 ? own : inheritedDfs
  charged[i] = effective
  chargedDfs[i] = effectiveDfs
  if (effective !== -1) {
    ownerSelf[effective] += nodeSelf[node]
    ownerNodes[effective] += 1
  }
  if (effectiveDfs !== -1) ownerSelfDfs[effectiveDfs] += nodeSelf[node]
}
const tEnd = performance.now()

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
const mb = (x) => (x / 1024 / 1024).toFixed(1)
let totalSelf = 0
for (let i = 0; i < reachable; i++) totalSelf += nodeSelf[dfsOrder[i]]
const heapUsed = Number(process.env.PROBE_HEAP_USED ?? 0)
const attributed = ownerSelf.reduce((a, b) => a + b, 0)

console.log(`file ${mb(statSync(path).size)}MB  nodes ${nodeCount.toLocaleString()}  edges ${totalEdges.toLocaleString()}  reachable ${reachable.toLocaleString()}`)
console.log(`timings: read ${(tRead - t0).toFixed(0)}ms  parse ${(tParse - tRead).toFixed(0)}ms  roots ${(tRoots - tParse).toFixed(0)}ms  dominator ${(tDom - tRoots).toFixed(0)}ms  partition ${(tEnd - tAttr).toFixed(0)}ms  total ${(tEnd - t0).toFixed(0)}ms`)
console.log(`owner strings matched ${matchedStrings.toLocaleString()}   module root nodes ${rootNodeCount.toLocaleString()}`)
const attributedDfs = ownerSelfDfs.reduce((a, b) => a + b, 0)
console.log(`reachable self_size ${mb(totalSelf)}MB   charged to a module ${mb(attributed)}MB (${((attributed / totalSelf) * 100).toFixed(1)}%)`)
console.log(`  same figure via DFS spanning tree (the old, arbitrary basis): ${mb(attributedDfs)}MB (${((attributedDfs / totalSelf) * 100).toFixed(1)}%)`)
if (heapUsed > 0) console.log(`host heapUsed at capture ${mb(heapUsed)}MB`)
console.log('')
console.log('  charged      share of   objects      owner')
const rows = ownerKeys.map((name, i) => ({ name, bytes: ownerSelf[i], nodes: ownerNodes[i] }))
rows.sort((a, b) => b.bytes - a.bytes)
for (const row of rows) {
  if (row.bytes < 100 * 1024) continue
  const dfsBytes = ownerSelfDfs[ownerIndexByKey.get(row.name) ?? -1] ?? 0
  console.log(
    `  ${mb(row.bytes).padStart(7)}MB   ${((row.bytes / attributed) * 100).toFixed(2).padStart(8)}%   ` +
      `${String(row.nodes).padStart(9)}   ${row.name}` +
      `   (DFS basis ${mb(dfsBytes)}MB)`,
  )
}
console.log('')
console.log(`analyzer peak RSS ${mb(process.memoryUsage().rss)}MB`)

// ---------------------------------------------------------------------------
// Diagnostics: what keeps the UNATTRIBUTED bytes alive?
//
// The partition reaches only ~10% of a real host heap, which is itself the most
// important finding. This section shows where the rest sits: the biggest
// retained subtrees in the graph, and who retains them.
// ---------------------------------------------------------------------------
const top = []
for (let i = 0; i < reachable; i++) {
  const node = dfsOrder[i]
  const size = retained[node]
  if (size < 512 * 1024) continue
  top.push({ node, size, owner: nodeOwner[node], type: nodeTypes[nodeType[node]], name: strings[nodeName[node]] ?? '' })
}
top.sort((a, b) => b.size - a.size)

/** Nearest module-root owner of a node, walking the dominator tree. */
function ownerAbove(node) {
  let d = dfsIndex[node]
  while (d > 0) {
    const n = dfsOrder[d]
    if (nodeOwner[n] !== -1) return ownerKeys[nodeOwner[n]]
    d = idom[d]
  }
  return '(no module root above it)'
}

console.log('')
console.log(`=== top ${Math.min(top.length, 25)} retained subtrees in the whole graph ===`)
console.log('  retained    type            owner above it                        name')
for (const entry of top.slice(0, 25)) {
  const name = entry.name.length > 48 ? entry.name.slice(0, 48) + '…' : entry.name
  console.log(
    `  ${mb(entry.size).padStart(7)}MB   ${entry.type.padEnd(14)}  ${ownerAbove(entry.node).padEnd(36)}  ${name}`,
  )
}

// How much of the heap sits under NO module root at all?
let noOwnerBytes = 0
let noOwnerNodes = 0
for (let i = 0; i < reachable; i++) {
  if (charged[i] === -1) { noOwnerBytes += nodeSelf[dfsOrder[i]]; noOwnerNodes += 1 }
}
console.log('')
console.log(`nodes with no module root above them: ${noOwnerNodes.toLocaleString()} (${mb(noOwnerBytes)}MB, ${((noOwnerBytes / totalSelf) * 100).toFixed(1)}% of the reachable heap)`)
console.log('These are objects reachable only from globals/roots that no module node dominates.')
console.log('A per-plugin memory number can never cover them, no matter how attribution is done.')