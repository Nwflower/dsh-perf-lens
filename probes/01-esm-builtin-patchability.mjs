/**
 * Probe 01 — builtin patchability + available v8/inspector APIs.
 *
 * Establishes two facts the design depends on:
 *   1. Replacing a property on `node:fs` does NOT reach ESM named imports,
 *      so "monkey-patch fs" silently under-reports disk I/O.
 *   2. `v8.startSamplingHeapProfiler` is absent on this runtime; heap sampling
 *      must go through the inspector's HeapProfiler domain instead.
 */
import fs from 'node:fs'
import { readFileSync } from 'node:fs'
import * as v8 from 'node:v8'
import * as inspector from 'node:inspector'

const original = fs.readFileSync
fs.readFileSync = (...args) => original(...args)

console.log('ns readFileSync patched? ', fs.readFileSync !== original)
try {
  readFileSync('C:/Windows/win.ini')
  console.log('named-import saw patch: NO')
} catch {
  console.log('named-import saw patch: NO (read failed, binding still original)')
}

console.log(
  'v8 keys:',
  Object.keys(v8).filter(k => /heap|sampling/i.test(k)).join(','),
)
console.log('startSamplingHeapProfiler:', typeof v8.startSamplingHeapProfiler)
console.log('stopSamplingHeapProfiler: ', typeof v8.stopSamplingHeapProfiler)
console.log('writeHeapSnapshot:        ', typeof v8.writeHeapSnapshot)
console.log('inspector.Session:        ', typeof inspector.Session)