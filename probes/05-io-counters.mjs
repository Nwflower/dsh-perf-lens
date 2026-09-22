/**
 * Probe 05 — process-level disk I/O counters without native dependencies.
 *
 * `process.resourceUsage()` exposes fsRead/fsWrite operation counts, and
 * `process.report.getReport()` exposes the same via resourceUsage.fsActivity
 * plus rss/maxRss/pageFaults/cpuConsumptionPercent.
 *
 * These are OPERATION COUNTS, not bytes. The panel must not present them as
 * traffic volume.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ioPath = join(tmpdir(), 'dsh-perf-lens-probe-05.bin')
const payload = Buffer.alloc(4 * 1024 * 1024, 3)

const before = process.resourceUsage()
for (let i = 0; i < 20; i++) {
  writeFileSync(ioPath, payload)
  readFileSync(ioPath)
}
const after = process.resourceUsage()

console.log('resourceUsage before:', JSON.stringify({ fsRead: before.fsRead, fsWrite: before.fsWrite }))
console.log('resourceUsage after :', JSON.stringify({ fsRead: after.fsRead, fsWrite: after.fsWrite }))
console.log('delta fsRead:', after.fsRead - before.fsRead, ' delta fsWrite:', after.fsWrite - before.fsWrite)
console.log('(20 writes + 20 reads were issued)\n')

const report = process.report.getReport()
console.log('report keys:', Object.keys(report).join(', '))
console.log('report.resourceUsage:', JSON.stringify(report.resourceUsage))
console.log('report has libuv section:', Array.isArray(report.libuv))

const flat = JSON.stringify(report)
for (const key of ['readTransfer', 'ioCounters', 'rss', 'external']) {
  console.log(`contains ${key}:`, flat.includes(key))
}

rmSync(ioPath, { force: true })