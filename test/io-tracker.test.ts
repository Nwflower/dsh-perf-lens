// Locks zero-patch fs attribution (evidence 7) and its documented limit: async
// file operations are attributed to the calling plugin, synchronous ones are not
// counted at all.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { createOwnerIndex, normalizePath } from '../src/host/attribute'
import {
  classifyFsOperation,
  IoTracker,
  isFsAsyncType,
  ownerOfFsInit,
} from '../src/host/io-tracker'

const TEST_DIR = normalizePath(fileURLToPath(new URL('.', import.meta.url)))
const HOST_DIR = normalizePath(fileURLToPath(new URL('../src/host/', import.meta.url)))
const INDEX = createOwnerIndex([
  { kind: 'self', name: 'dsh-perf-lens', prefix: HOST_DIR },
  { kind: 'plugin', name: 'testplugin', prefix: TEST_DIR },
])

describe('fs resource classification', () => {
  test('recognizes the async types the fs implementation creates', () => {
    expect(isFsAsyncType('FSREQPROMISE')).toBe(true)
    expect(isFsAsyncType('FSREQCALLBACK')).toBe(true)
    expect(isFsAsyncType('FILEHANDLECLOSEREQ')).toBe(true)
    expect(isFsAsyncType('Timeout')).toBe(false)
    expect(isFsAsyncType('TCPWRAP')).toBe(false)
  })

  test('splits read from write by call site', () => {
    expect(classifyFsOperation('at writeFile (node:fs/promises)')).toBe('write')
    expect(classifyFsOperation('at createWriteStream (node:fs)')).toBe('write')
    expect(classifyFsOperation('at readFile (node:fs/promises)')).toBe('read')
    expect(classifyFsOperation('at stat (node:fs)')).toBe('read')
  })
})

describe('async fs attribution', () => {
  test('drops the hook plumbing and finds the calling plugin', () => {
    const stack = [
      'Error',
      `    at IoTracker.#onInit (${HOST_DIR}io-tracker.ts:10:5)`,
      '    at emitInitNative (node:internal/async_hooks:200:7)',
      '    at readFile (node:internal/fs/promises:400:3)',
      `    at run (${TEST_DIR}io-tracker.test.ts:20:3)`,
    ].join('\n')
    expect(ownerOfFsInit(stack, INDEX)).toEqual({ kind: 'plugin', name: 'testplugin' })
  })

  test('counts a real async read against the calling plugin', async () => {
    const tracker = new IoTracker()
    tracker.setOwnerIndex(INDEX)
    tracker.enable()
    const dir = await mkdtemp(join(tmpdir(), 'perf-lens-io-'))
    try {
      const file = join(dir, 'payload.txt')
      await writeFile(file, 'hello')
      tracker.take() // drain the setup write
      await readFile(file, 'utf8')
      tracker.disable()
      const sample = tracker.take()
      expect(sample.total).toBeGreaterThanOrEqual(1)
      expect(sample.perOwner.get('plugin:testplugin')?.read ?? 0).toBeGreaterThanOrEqual(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('disable stops counting', () => {
    const tracker = new IoTracker()
    tracker.enable()
    expect(tracker.enabled).toBe(true)
    tracker.disable()
    expect(tracker.enabled).toBe(false)
  })
})
