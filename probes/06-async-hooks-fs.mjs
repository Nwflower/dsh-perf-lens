/**
 * Probe 06 — per-owner file operation counting with zero patching.
 *
 * AsyncLocalStorage marks "which plugin is running"; async_hooks reports every
 * async resource the runtime creates. Filtering for fs resource types yields
 * per-plugin operation counts without monkey-patching any builtin.
 *
 * Limitation: synchronous fs calls create no async resource and are therefore
 * not counted here; they are covered by CPU-sampling attribution instead.
 */
import { AsyncLocalStorage, createHook } from 'node:async_hooks'
import { readFileSync, writeFileSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const storage = new AsyncLocalStorage()
const counts = new Map()

const hook = createHook({
  init(asyncId, type) {
    const owner = storage.getStore()
    if (owner === undefined) return
    if (!/FSREQ|FILEHANDLE|FSEVENTWRAP|STATWATCHER|FSWatcher/i.test(type)) return
    const key = `${owner} :: ${type}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  },
})
hook.enable()

const ioPath = join(tmpdir(), 'dsh-perf-lens-probe-06.bin')
writeFileSync(ioPath, 'x'.repeat(1024))

await storage.run('pluginA', async () => {
  readFileSync(ioPath)
  readFileSync(ioPath)
  await fsp.readFile(ioPath)
  await fsp.readFile(ioPath)
  await fsp.stat(ioPath)
})

await storage.run('pluginB', async () => {
  await fsp.writeFile(ioPath, 'y'.repeat(2048))
  await fsp.appendFile(ioPath, 'z')
  writeFileSync(ioPath, 'w')
})

hook.disable()

console.log('per-owner fs async-resource counts:')
for (const [key, value] of [...counts].sort()) {
  console.log(`  ${String(value).padStart(3)}  ${key}`)
}

console.log('\n(process-level op counts, exact, for calibration)')
const usage = process.resourceUsage()
console.log('  fsRead:', usage.fsRead, ' fsWrite:', usage.fsWrite)

const { rmSync } = await import('node:fs')
rmSync(ioPath, { force: true })