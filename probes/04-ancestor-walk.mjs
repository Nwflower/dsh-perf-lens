/**
 * Probe 04 — decisive attribution experiment.
 *
 * Two synthetic "plugins" share one dependency module and call it 200 and 60
 * times. The true cost ratio is 3.33.
 *
 *   - Charging samples to the sampled frame's own file collapses into an
 *     unattributable bucket (573 of 574 samples).
 *   - Walking up the call tree to the nearest plugin-owned frame recovers the
 *     ratio within ~1.5%.
 *
 * This is why attribution must be stack-based, not file-based.
 */
import inspector from 'node:inspector'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = join(tmpdir(), 'dsh-perf-lens-probe-04')
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'shared'), { recursive: true })

writeFileSync(
  join(root, 'shared', 'dep.mjs'),
  'export function hot() { let s = 0; for (let i = 0; i < 4e5; i++) s += Math.sin(i); return s }\n',
)
writeFileSync(
  join(root, 'pluginA.mjs'),
  "import { hot } from './shared/dep.mjs'\nexport function runA(n) { let s = 0; for (let i = 0; i < n; i++) s += hot(); return s }\n",
)
writeFileSync(
  join(root, 'pluginB.mjs'),
  "import { hot } from './shared/dep.mjs'\nexport function runB(n) { let s = 0; for (let i = 0; i < n; i++) s += hot(); return s }\n",
)

const pluginA = await import(pathToFileURL(join(root, 'pluginA.mjs')).href)
const pluginB = await import(pathToFileURL(join(root, 'pluginB.mjs')).href)

const session = new inspector.Session()
session.connect()
const post = (method, params) =>
  new Promise((resolve, reject) =>
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result))),
  )

await post('Profiler.enable')
await post('Profiler.start')
pluginA.runA(200)
pluginB.runB(60)
const { profile } = await post('Profiler.stop')

const nodeById = new Map(profile.nodes.map(node => [node.id, node]))
const parentOf = new Map()
for (const node of profile.nodes) {
  for (const child of node.children ?? []) parentOf.set(child, node.id)
}

const OWNERS = [
  ['pluginA.mjs', 'pluginA'],
  ['pluginB.mjs', 'pluginB'],
]
const ownerOf = url => OWNERS.find(([fragment]) => url.includes(fragment))?.[1]

const ticksById = new Map()
for (const id of profile.samples) ticksById.set(id, (ticksById.get(id) ?? 0) + 1)

const direct = new Map()
const walked = new Map()
for (const [id, ticks] of ticksById) {
  const url = nodeById.get(id)?.callFrame?.url ?? ''
  const directKey = ownerOf(url) ?? '(shared/other)'
  direct.set(directKey, (direct.get(directKey) ?? 0) + ticks)

  let cursor = id
  let owner
  while (cursor !== undefined) {
    owner = ownerOf(nodeById.get(cursor)?.callFrame?.url ?? '')
    if (owner !== undefined) break
    cursor = parentOf.get(cursor)
  }
  const walkedKey = owner ?? '(unattributed)'
  walked.set(walkedKey, (walked.get(walkedKey) ?? 0) + ticks)
}

const dump = (title, map) => {
  console.log(`${title}:`)
  for (const [key, value] of [...map].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(value).padStart(4)}  ${key}`)
  }
}

console.log('true call ratio pluginA:pluginB = 200:60 = 3.33\n')
dump('direct (self-frame) attribution', direct)
console.log()
dump('ancestor-walk attribution', walked)

const a = walked.get('pluginA') ?? 0
const b = walked.get('pluginB') ?? 0
if (b > 0) console.log(`\nancestor-walk ratio = ${(a / b).toFixed(2)}`)

session.disconnect()
rmSync(root, { recursive: true, force: true })