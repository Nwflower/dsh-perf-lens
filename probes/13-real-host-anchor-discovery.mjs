/**
 * Probe 12 — can a REAL host heap snapshot be attributed to plugins?
 *
 * Probe 11 proved a real 366MB host heap costs a ~10s pause and yields a 272MB
 * snapshot (probe 10's synthetic heap was 19.7MB for 668MB: flat strings pack
 * the file, real heaps do not). This probe answers the question the design
 * cannot proceed without: inside that snapshot, what carries plugin identity,
 * and does ownership-by-dominator differ from probe 10's DFS-parent walk?
 *
 * Phases:
 *   1. parse + counts -> us/node, us/edge (the unit that extrapolates)
 *   2. identity inventory -> node names / strings / EDGE property names
 *   3. ownership -> dominator (idom chain) vs DFS-parent propagation, for
 *      whatever anchors phase 2 found; reports attributed vs unowned coverage
 *
 * Run: node --max-old-space-size=8192 probes/12-real-host-anchor-discovery.mjs
 * Env: PROBE_SNAPSHOT (default <tmp>/dsh-perf-lens-real-host.heapsnapshot)
 *      PROBE_SKIP_DOM=1 to stop after phase 2
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const file = process.env.PROBE_SNAPSHOT ?? join(tmpdir(), 'dsh-perf-lens-real-host.heapsnapshot')
console.log('snapshot: ' + file + '  (' + mb(statSync(file).size) + 'MB)')

const t0 = performance.now()
const raw = readFileSync(file, 'utf8')
const snap = JSON.parse(raw)
const tParse = performance.now()

const meta = snap.snapshot.meta
const nodeFields = meta.node_fields
const edgeFields = meta.edge_fields
const nodeFieldCount = nodeFields.length
const edgeFieldCount = edgeFields.length
const strings = snap.strings
const nodeCount = snap.nodes.length / nodeFieldCount
const edgeCount = snap.edges.length / edgeFieldCount

const typeIdx = nodeFields.indexOf('type')
const nameIdx = nodeFields.indexOf('name')
const sizeIdx = nodeFields.indexOf('self_size')
const edgeCountIdx = nodeFields.indexOf('edge_count')
const nodeTypeNames = meta.node_types[typeIdx]
const edgeTypeIdx = edgeFields.indexOf('type')
const edgeNameIdx = edgeFields.indexOf('name_or_index')
const edgeTypeNames = meta.edge_types[edgeTypeIdx]

console.log('--- phase 1: parse + counts ---')
console.log('  read + JSON.parse   ' + (tParse - t0).toFixed(0) + 'ms')
console.log('  nodes ' + nodeCount.toLocaleString() + '  edges ' + edgeCount.toLocaleString() + '  strings ' + strings.length.toLocaleString())
console.log('  nodes/MB ' + (nodeCount / (statSync(file).size / 1024 / 1024)).toFixed(0) + '   (probe 10 synthetic: 15,700 nodes/MB)')

const nodeType = new Uint8Array(nodeCount)
const nodeName = new Uint32Array(nodeCount)
const nodeSelf = new Float64Array(nodeCount)
for (let i = 0; i < nodeCount; i++) {
  const base = i * nodeFieldCount
  nodeType[i] = snap.nodes[base + typeIdx]
  nodeName[i] = snap.nodes[base + nameIdx]
  nodeSelf[i] = snap.nodes[base + sizeIdx]
}
const firstEdge = new Uint32Array(nodeCount + 1)
for (let i = 0; i < nodeCount; i++) firstEdge[i + 1] = firstEdge[i] + snap.nodes[i * nodeFieldCount + edgeCountIdx]
const edgeTo = new Uint32Array(edgeCount)
const edgeType = new Uint8Array(edgeCount)
const edgeName = new Uint32Array(edgeCount)
const edgeToIdx = edgeFields.indexOf('to_node')
for (let e = 0; e < edgeCount; e++) {
  const base = e * edgeFieldCount
  edgeTo[e] = snap.edges[base + edgeToIdx] / nodeFieldCount
  edgeType[e] = snap.edges[base + edgeTypeIdx]
  edgeName[e] = snap.edges[base + edgeNameIdx]
}
snap.nodes = null
snap.edges = null

// ---------------------------------------------------------------------------
// Phase 2: where does plugin identity live?
// ---------------------------------------------------------------------------
const PATTERNS = [
  ['dsh package', /@deepseek-ai\/dsh-[a-z0-9-]+/],
  ['perf-lens', /dsh-perf-lens/],
  ['other plugin', /dsh-(context|chat-import|claude-style|market)/],
  ['script path', /[^\s"'\\]+\.(ts|mjs|cjs|js)$/],
]
const stringHits = new Map(PATTERNS.map(([label]) => [label, { count: 0, samples: [] }]))
for (let s = 0; s < strings.length; s++) {
  const value = strings[s]
  if (typeof value !== 'string' || value.length === 0) continue
  for (const [label, pattern] of PATTERNS) {
    if (pattern.test(value)) {
      const entry = stringHits.get(label)
      entry.count += 1
      if (entry.samples.length < 4) entry.samples.push(value.slice(0, 100))
    }
  }
}

const nameHit = new Map(PATTERNS.map(([label]) => [label, 0]))
const nameTypeHist = new Map(PATTERNS.map(([label]) => [label, new Map()]))
const seenName = new Uint8Array(strings.length)
for (let i = 0; i < nodeCount; i++) {
  const index = nodeName[i]
  if (seenName[index] === 1) continue
  seenName[index] = 1
  const value = strings[index]
  if (typeof value !== 'string') continue
  for (const [label, pattern] of PATTERNS) {
    if (pattern.test(value)) {
      nameHit.set(label, nameHit.get(label) + 1)
      const hist = nameTypeHist.get(label)
      const type = nodeTypeNames[nodeType[i]] ?? String(nodeType[i])
      hist.set(type, (hist.get(type) ?? 0) + 1)
    }
  }
}

// Property-name identity: an edge of type 'property'/'internal' whose name is a
// package/module string means its SOURCE node holds that property — a plausible
// anchor even when node names are generic constructor names.
const PROPERTY_TYPES = new Set(['property', 'internal'])
const propAnchorCount = new Map(PATTERNS.map(([label]) => [label, 0]))
const propSampleByPattern = new Map(PATTERNS.map(([label]) => [label, []]))
let propertyEdges = 0
for (let node = 0; node < nodeCount; node++) {
  for (let e = firstEdge[node]; e < firstEdge[node + 1]; e++) {
    if (!PROPERTY_TYPES.has(edgeTypeNames[edgeType[e]])) continue
    propertyEdges += 1
    const value = strings[edgeName[e]]
    if (typeof value !== 'string') continue
    for (const [label, pattern] of PATTERNS) {
      if (pattern.test(value)) {
        propAnchorCount.set(label, propAnchorCount.get(label) + 1)
        const samples = propSampleByPattern.get(label)
        if (samples.length < 3) samples.push(value.slice(0, 100))
      }
    }
  }
}

console.log('\n--- phase 2: identity inventory ---')
console.log('  strings (global string table):')
for (const [label, entry] of stringHits) {
  console.log('    ' + label.padEnd(14) + ' ' + String(entry.count).padStart(8))
  for (const sample of entry.samples) console.log('        | ' + sample)
}
console.log('  node NAMES (distinct name strings, by node type):')
for (const [label, count] of nameHit) {
  const hist = [...nameTypeHist.get(label)].sort((a, b) => b[1] - a[1]).slice(0, 4)
  console.log('    ' + label.padEnd(14) + ' ' + String(count).padStart(8) + '   ' + hist.map(([t, n]) => t + '×' + n).join(', '))
}
console.log('  property/internal edges total: ' + propertyEdges.toLocaleString())
console.log('  property-name identity hits (edges whose property name matches):')
for (const [label, count] of propAnchorCount) {
  console.log('    ' + label.padEnd(14) + ' ' + String(count).padStart(8))
  for (const sample of propSampleByPattern.get(label)) console.log('        | ' + sample)
}

if (process.env.PROBE_SKIP_DOM === '1') {
  console.log('\nPROBE_SKIP_DOM=1: stopping after phase 2')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Phase 3: dominator ownership vs DFS-parent ownership.
// ---------------------------------------------------------------------------
const tDom = performance.now()
const dfsOrder = new Uint32Array(nodeCount)
const dfsIndex = new Int32Array(nodeCount).fill(-1)
const dfsParent = new Int32Array(nodeCount).fill(-1)
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
        dfsParent[reachable] = dfsIndex[v]
        reachable += 1
        stack.push(w)
      }
    }
  }
}
const predCount = new Uint32Array(reachable + 1)
for (let i = 1; i < reachable; i++) predCount[dfsParent[i] + 1] += 1
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
  const path = []
  let u = v
  while (ancestor[ancestor[u]] !== 0) { path.push(u); u = ancestor[u] }
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
  ancestor[i] = dfsParent[i]
  for (let v = bucketHead[dfsParent[i]]; v !== -1; v = bucketNext[v]) {
    const u = evalNode(v)
    idom[v] = semi[u] < semi[v] ? u : dfsParent[i]
  }
  bucketHead[dfsParent[i]] = -1
}
for (let i = 1; i < reachable; i++) if (idom[i] !== semi[i]) idom[i] = idom[idom[i]]
const tDomEnd = performance.now()

// Anchors that can actually OWN heap: a 'code' node carries the script that
// defines a plugin's functions; an object holding a property whose NAME is a
// module path is a registry/cache entry. Bare identity STRING nodes are
// excluded on purpose — they carry identity but dominate nothing (phase 2
// showed they are ~99% of pattern hits, which is exactly why probe 10's
// object-name rule does not translate to a real heap).
function ownerLabel(value) {
  let match = /@deepseek-ai[\\/](dsh-[a-z0-9-]+)/.exec(value)
  if (match !== null) return match[1]
  match = /node_modules[\\/](@[a-z0-9-]+[\\/][a-z0-9-]+)/.exec(value)
  if (match !== null) return match[1]
  match = /node_modules[\\/]([a-z0-9-]+)/.exec(value)
  if (match !== null) return match[1]
  match = /(dsh-[a-z0-9-]+)/.exec(value)
  if (match !== null) return match[1]
  match = /([a-z0-9-]+)\.(ts|js|mjs|cjs)$/.exec(value)
  if (match !== null) return match[1]
  return null
}

const anchor = new Uint8Array(nodeCount)
const anchorLabel = new Map()
let anchorCount = 0
const codeType = nodeTypeNames.indexOf('code')
for (let i = 0; i < nodeCount; i++) {
  if (nodeType[i] !== codeType) continue
  const label = ownerLabel(strings[nodeName[i]] ?? '')
  if (label !== null) { anchor[i] = 1; anchorLabel.set(i, label); anchorCount += 1 }
}
for (let node = 0; node < nodeCount; node++) {
  if (anchor[node] === 1) continue
  for (let e = firstEdge[node]; e < firstEdge[node + 1]; e++) {
    if (!PROPERTY_TYPES.has(edgeTypeNames[edgeType[e]])) continue
    const label = ownerLabel(strings[edgeName[e]] ?? '')
    if (label !== null) { anchor[node] = 1; anchorLabel.set(node, label); anchorCount += 1; break }
  }
}

// Ownership by idom chain (review's correction) vs DFS parent (probe 10).
const ownerByIdom = new Int32Array(nodeCount).fill(-1)
const ownerByDfs = new Int32Array(nodeCount).fill(-1)
const byIdom = new Map()
const byDfs = new Map()
let attributedIdom = 0
let attributedDfs = 0
let totalBytes = 0
let disagreement = 0
for (let i = 0; i < reachable; i++) {
  const node = dfsOrder[i]
  totalBytes += nodeSelf[node]
  const idomOwner = anchor[node] === 1 ? node : (i === 0 ? -1 : ownerByIdom[dfsOrder[idom[i]]])
  const dfsOwner = anchor[node] === 1 ? node : (i === 0 ? -1 : ownerByDfs[dfsOrder[dfsParent[i]]])
  ownerByIdom[node] = idomOwner
  ownerByDfs[node] = dfsOwner
  if (idomOwner >= 0) {
    attributedIdom += nodeSelf[node]
    byIdom.set(anchorLabel.get(idomOwner), (byIdom.get(anchorLabel.get(idomOwner)) ?? 0) + nodeSelf[node])
  }
  if (dfsOwner >= 0) {
    attributedDfs += nodeSelf[node]
    byDfs.set(anchorLabel.get(dfsOwner), (byDfs.get(anchorLabel.get(dfsOwner)) ?? 0) + nodeSelf[node])
  }
  if (idomOwner !== dfsOwner) disagreement += nodeSelf[node]
}

// Retained sizes + the shape of the ownership landscape: is there a registry
// super-node that could serve as a real anchor?
const retained = new Float64Array(nodeCount)
for (let i = 0; i < reachable; i++) retained[dfsOrder[i]] = nodeSelf[dfsOrder[i]]
for (let i = reachable - 1; i >= 1; i--) retained[dfsOrder[idom[i]]] += retained[dfsOrder[i]]

console.log('\n--- phase 3a: retained-size landscape (who dominates the heap?) ---')
const topRetained = []
for (let i = 0; i < reachable; i++) {
  const node = dfsOrder[i]
  topRetained.push([node, retained[node]])
}
topRetained.sort((a, b) => b[1] - a[1])
for (const [node, bytes] of topRetained.slice(0, 10)) {
  const type = nodeTypeNames[nodeType[node]] ?? String(nodeType[node])
  const name = String(strings[nodeName[node]] ?? '').slice(0, 70)
  console.log('    ' + mb(bytes).padStart(9) + 'MB  ' + type.padEnd(9) + ' ' + name)
}
const anchorRetained = []
for (let i = 0; i < reachable; i++) {
  const node = dfsOrder[i]
  if (anchor[node] === 1) anchorRetained.push([anchorLabel.get(node), retained[node]])
}
anchorRetained.sort((a, b) => b[1] - a[1])
console.log('  top anchors by retained size (an anchor that dominates nothing cannot own):')
for (const [label, bytes] of anchorRetained.slice(0, 5)) {
  console.log('    ' + mb(bytes).padStart(9) + 'MB  ' + label)
}

console.log('\n--- phase 3: ownership (dominator vs DFS parent) ---')
console.log('  Lengauer-Tarjan + idom     ' + (tDomEnd - tDom).toFixed(0) + 'ms   reachable ' + reachable.toLocaleString() + ' / ' + nodeCount.toLocaleString())
console.log('  ownership anchors          ' + anchorCount.toLocaleString() + '  (code nodes + module-path property holders)')
console.log('  total reachable bytes      ' + mb(totalBytes) + 'MB')
console.log('  attributed by idom chain   ' + mb(attributedIdom) + 'MB  (' + pct(attributedIdom, totalBytes) + ')')
console.log('  attributed by DFS parent   ' + mb(attributedDfs) + 'MB  (' + pct(attributedDfs, totalBytes) + ')')
console.log('  bytes where the two owners DIFFER: ' + mb(disagreement) + 'MB  (' + pct(disagreement, totalBytes) + ')')

const top = [...byIdom].sort((a, b) => b[1] - a[1]).slice(0, 15)
console.log('\n  top owners by dominator attribution (idom):')
for (const [label, bytes] of top) {
  console.log('    ' + String(label).padEnd(34) + mb(bytes).padStart(9) + 'MB   (DFS parent: ' + mb(byDfs.get(label) ?? 0).padStart(9) + 'MB)')
}

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) }
function pct(part, whole) { return whole === 0 ? '0%' : (part / whole * 100).toFixed(1) + '%' }
