// Probe 17: how much of the persisted JSONL is all-zero plugin rows.
//
// Reads a real history file (or the newest one under $DSH_HOME/perf-lens) and
// re-serializes every window through the production serializeSnapshot, so the
// reported reduction is exactly what the product change buys. One-off evidence
// for docs/evidence.md, evidence 10; not product code.
//
// Needs Node >= 23.6 (or 22.18) for TypeScript type stripping, because it
// imports the real history.ts rather than a copy of the predicate.

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseSnapshot, serializeSnapshot } from '../src/host/history.ts'

function newestHistoryFile() {
  const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'perf-lens')
  const files = readdirSync(dir)
    .filter((name) => name.startsWith('metrics-') && name.endsWith('.jsonl'))
    .sort()
  const last = files.at(-1)
  if (last === undefined) throw new Error(`no metrics-*.jsonl under ${dir}`)
  return join(dir, last)
}

const file = process.argv[2] ?? newestHistoryFile()
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)

let oldBytes = 0
let newBytes = 0
let rowsBefore = 0
let rowsAfter = 0
let kept = 0
for (const line of lines) {
  oldBytes += Buffer.byteLength(line) + 1
  const snapshot = parseSnapshot(line)
  if (snapshot === null) continue
  rowsBefore += snapshot.plugins.length
  const out = serializeSnapshot(snapshot)
  newBytes += Buffer.byteLength(out) + 1
  const after = JSON.parse(out).plugins.length
  rowsAfter += after
  if (after > 0) kept += 1
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2)
console.log(`file:             ${file}`)
console.log(`windows:          ${lines.length}`)
console.log(`rows/window:      ${(rowsBefore / lines.length).toFixed(1)} -> ${(rowsAfter / lines.length).toFixed(1)}`)
console.log(`windows w/ rows:  ${kept}/${lines.length}`)
console.log(`bytes/window:     ${Math.round(oldBytes / lines.length)} -> ${Math.round(newBytes / lines.length)}`)
console.log(`total:            ${mb(oldBytes)} MB -> ${mb(newBytes)} MB`)
console.log(`reduction:        ${(100 * (1 - newBytes / oldBytes)).toFixed(1)}%`)
