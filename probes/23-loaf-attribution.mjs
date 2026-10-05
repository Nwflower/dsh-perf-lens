/**
 * Probe 23 — LoAF per-plugin jank attribution, two modes.
 *
 * LIVE (default): poll a restarted host's /api-perf/vitals and print the
 * resolved jank rows it reports, then grep the JSONL history for anything
 * function-name or path shaped (the privacy red line).
 *
 * OFFLINE (--capture <file>): resolve raw LoAF script entries captured in a
 * live page (a temporary PerformanceObserver, dumped from window.__loafCapture)
 * against the real published plugin bundles. The resolution functions below
 * mirror src/host/loaf-map.ts (pinned by test/loaf-map.test.ts against the
 * same fixtures); the probe exists to prove the data path on real bytes —
 * the live boot combo URLs, the real client.js files and the charPositions
 * the browser really emitted during a streamed answer.
 *
 * Run:
 *   node probes/23-loaf-attribution.mjs --base http://127.0.0.1:3081 [--token t] [--seconds 30]
 *   node probes/23-loaf-attribution.mjs --capture .tmp/loaf-capture.json
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}
const capturePath = option('capture', '')

if (capturePath !== '') {
  await offline(capturePath)
} else {
  await live()
}

/* ---------------- offline mode ---------------- */

async function offline(file) {
  const capture = JSON.parse(readFileSync(file, 'utf8'))
  const frames = capture.frames ?? []
  const scripts = frames.flatMap(frame => frame.scripts ?? [])
  console.log(`capture: ${frames.length} long frames, ${scripts.length} script entries, started ${new Date(capture.startedAt).toISOString()}`)
  console.log('')

  const dirs = pluginDirs()
  const tables = new Map()
  const resolve = (url, charPosition) => {
    const parsed = parsePluginUrl(url)
    if (parsed.kind === 'other') return undefined
    if (parsed.kind === 'single' || parsed.kind === 'chunk') return ownerKeyOf(parsed.id)
    let table = tables.get(url)
    if (table === undefined) {
      table = buildSegmentTable(parsed.ids, id => clientSourceOf(dirs, id))
      tables.set(url, table)
    }
    const id = segmentOwnerOf(table, charPosition)
    return id === undefined ? undefined : ownerKeyOf(id)
  }

  const rows = new Map()
  let total = 0
  let covered = 0
  const unresolvedSamples = []
  for (const s of scripts) {
    total += s.duration
    const owner = resolve(s.sourceURL, s.sourceCharPosition)
    if (owner === undefined) {
      unresolvedSamples.push(s)
      add(rows, 'unresolved', s.duration, s.forcedStyleAndLayoutDuration)
      continue
    }
    covered += s.duration
    add(rows, owner, s.duration, s.forcedStyleAndLayoutDuration)
  }
  const share = total === 0 ? 1 : covered / total

  console.log('resolved rows:')
  for (const [owner, row] of [...rows.entries()].sort((a, b) => b[1].durationMs - a[1].durationMs)) {
    console.log(`  ${row.durationMs.toFixed(1).padStart(8)}ms  layout ${row.forcedLayoutMs.toFixed(1).padStart(6)}ms  x${String(row.count).padEnd(3)} ${owner}`)
  }
  console.log(`  attributedShare = ${share.toFixed(3)} (bar: 0.8)`)
  console.log('')
  console.log('top raw entries by duration:')
  for (const s of [...scripts].sort((a, b) => b.duration - a.duration).slice(0, 12)) {
    console.log(`  ${s.duration.toFixed(1).padStart(7)}ms  ${(s.invokerType || '?').padEnd(14)} ${(s.sourceFunctionName || '(anon)').slice(0, 28).padEnd(28)} ${s.sourceURL.slice(0, 90)} @${s.sourceCharPosition}`)
  }
  if (unresolvedSamples.length > 0) {
    console.log('')
    console.log(`unresolved sample urls (first 5 of ${unresolvedSamples.length}):`)
    for (const s of unresolvedSamples.slice(0, 5)) console.log(`  ${s.sourceURL.slice(0, 110)} @${s.sourceCharPosition}`)
  }
  const seen = new Set(rows.keys())
  console.log('')
  console.log(`  ${seen.has('plugin:dsh-claude-style') ? 'SEEN' : 'MISSING'}  plugin:dsh-claude-style`)
}

function add(rows, owner, durationMs, forcedLayoutMs) {
  const row = rows.get(owner) ?? { durationMs: 0, forcedLayoutMs: 0, count: 0 }
  row.durationMs += durationMs
  row.forcedLayoutMs += forcedLayoutMs
  row.count += 1
  rows.set(owner, row)
}

function ownerKeyOf(id) {
  if (id === 'dsh-perf-lens') return 'self'
  if (/^@deepseek-ai\/dsh(?:-|$)/.test(id)) return `harness:${id}`
  return `plugin:${id}`
}

function pluginDirs() {
  const roots = [
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop', 'node_modules'),
    // Harness client packages live nested in the dsh CLI's own install.
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'),
  ]
  const dirs = new Map()
  for (const root of roots) {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) collect(root, entry, dirs)
  }
  return dirs
}

function collect(root, entry, dirs) {
  if (entry.name.startsWith('.')) return
  if (entry.name.startsWith('@')) {
    for (const inner of readdirSync(join(root, entry.name), { withFileTypes: true })) {
      dirs.set(`${entry.name}/${inner.name}`, realpathSync(join(root, entry.name, inner.name)).replace(/\\/g, '/'))
    }
    return
  }
  dirs.set(entry.name, realpathSync(join(root, entry.name)).replace(/\\/g, '/'))
}

function clientSourceOf(dirs, id) {
  const dir = dirs.get(id)
  if (dir === undefined) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const client = manifest.exports?.['./client']
    const entry = typeof client === 'string' ? client : client?.default
    if (typeof entry !== 'string') return undefined
    return readFileSync(join(dir, entry), 'utf8')
  } catch {
    return undefined
  }
}

/* --- mirror of src/host/loaf-map.ts (see header) --- */

function parsePluginUrl(url) {
  const hay = url.startsWith('plugins/') ? `/${url}` : url
  const marker = '/plugins/'
  const at = hay.indexOf(marker)
  if (at === -1) return { kind: 'other' }
  const rest = hay.slice(at + marker.length)
  if (rest.startsWith('??')) {
    const list = rest.slice(2).split('&', 1)[0] ?? ''
    if (list === '') return { kind: 'other' }
    const ids = []
    for (const part of list.split(',')) {
      if (!part.endsWith('/client.js') || part.length <= '/client.js'.length) return { kind: 'other' }
      ids.push(part.slice(0, -'/client.js'.length))
    }
    return ids.length === 1 ? { kind: 'single', id: ids[0] } : { kind: 'batch', ids }
  }
  const path = rest.split(/[?#&]/, 1)[0] ?? ''
  const chunk = /^(.*)\/(client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js)$/.exec(path)
  if (chunk !== null && chunk[1] !== '') return { kind: 'chunk', id: chunk[1] }
  return { kind: 'other' }
}

const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/
const SOURCE_URL_TRAILER = /(?:\r?\n)?\/\/# sourceURL=[^\r\n]+(?:\r?\n)?$/

function prepareComboSource(input) {
  let source = input.replace(SOURCE_URL_TRAILER, '').replace(SOURCE_MAP_TRAILER, '')
  if (!source.endsWith('\n')) source += '\n'
  return source
}

function buildSegmentTable(ids, sourceOf) {
  const segments = []
  let offset = 0
  let known = true
  for (const id of ids) {
    const raw = known ? sourceOf(id) : undefined
    if (raw === undefined) {
      known = false
      segments.push({ id, start: offset, end: offset, known: false })
      continue
    }
    const prepared = prepareComboSource(raw)
    const end = offset + prepared.length + 2
    segments.push({ id, start: offset, end, known: true })
    offset = end
  }
  return { segments, complete: known }
}

function segmentOwnerOf(table, charPosition) {
  for (const segment of table.segments) {
    if (!segment.known) return undefined
    if (charPosition < segment.start) return undefined
    if (charPosition < segment.end) return segment.id
  }
  return undefined
}

/* ---------------- live mode ---------------- */

async function live() {
  const base = option('base', 'http://127.0.0.1:3081').replace(/\/$/, '')
  const token = option('token', process.env.DSH_WEB_TOKEN ?? '')
  const seconds = Number(option('seconds', '30'))
  const suffix = token === '' ? '' : `?token=${encodeURIComponent(token)}`
  const EXPECTED = ['plugin:dsh-claude-style', 'plugin:@alm-allen/dsh-chat-ux']
  const polls = []
  const deadline = Date.now() + seconds * 1000
  console.log(`polling ${base}/api-perf/vitals every 5s for ${seconds}s — stream a long answer now`)
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api-perf/vitals${suffix}`)
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      polls.push(await response.json())
    } catch (error) {
      console.log(`  poll failed: ${error.message}`)
    }
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
  let busiest = null
  for (const view of polls) {
    const count = view?.latest?.loaf?.scripts?.length ?? 0
    if (count > (busiest?.latest?.loaf?.scripts?.length ?? 0)) busiest = view
  }
  console.log('')
  if (busiest === null) {
    console.log('no LoAF script entries captured — was an answer streaming?')
  } else {
    const loaf = busiest.latest.loaf
    const jank = busiest.jank
    console.log(`busiest report at ${new Date(busiest.latest.at).toISOString()}: ${loaf.scripts.length} scripts (+${loaf.otherCount} folded, ${loaf.otherMs.toFixed(1)}ms)`)
    console.log('')
    console.log('raw script entries (top 10 by duration):')
    for (const s of [...loaf.scripts].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10)) {
      console.log(`  ${s.durationMs.toFixed(1).padStart(7)}ms  ${s.invokerType.padEnd(14)} ${s.functionName.slice(0, 30).padEnd(30)} ${s.url.slice(0, 100)} @${s.charPosition}`)
    }
    console.log('')
    console.log('resolved jank rows:')
    for (const row of jank?.rows ?? []) {
      console.log(`  ${row.durationMs.toFixed(1).padStart(7)}ms  layout ${row.forcedLayoutMs.toFixed(1).padStart(6)}ms  x${String(row.count).padEnd(3)} ${row.owner}`)
    }
    console.log(`  attributedShare = ${(jank?.attributedShare ?? 0).toFixed(3)}`)
  }
  const seen = new Set()
  let bestShare = 0
  for (const view of polls) {
    for (const row of view?.jank?.rows ?? []) seen.add(row.owner)
    bestShare = Math.max(bestShare, view?.jank?.attributedShare ?? 0)
  }
  console.log('')
  for (const owner of EXPECTED) console.log(`  ${seen.has(owner) ? 'SEEN' : 'MISSING'}  ${owner}`)
  console.log(`  best attributedShare = ${bestShare.toFixed(3)} (bar: 0.8)`)
  const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'perf-lens')
  let files = []
  try {
    files = readdirSync(dir).filter(name => /^metrics-\d{8}\.jsonl$/.test(name))
  } catch {
    console.log(`privacy check: ${dir} unreadable`)
  }
  let violations = 0
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8')
    const hits = text.match(/plugins\/\?\?|functionName|\.js\b/g)
    if (hits !== null) {
      violations += hits.length
      console.log(`  ${name}: ${hits.length} path/function-shaped tokens`)
    }
  }
  console.log('')
  console.log(`privacy check: ${files.length} metrics files, ${violations} violations`)
}
