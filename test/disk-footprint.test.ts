// Per-plugin on-disk bytes: the path-to-owner mapping and the budgeted walk
// (roadmap item 4).

import { describe, expect, test } from 'vitest'
import type { Dirent } from 'node:fs'
import { DiskFootprintScanner, ownerKeyOfPath, type FootprintFs } from '../src/host/disk-footprint'
import { createOwnerIndex } from '../src/host/attribute'

const INDEX = createOwnerIndex([
  { kind: 'plugin', name: 'dsh-alpha', prefix: '/home/u/.dsh/profiles/web/node_modules/dsh-alpha/' },
  { kind: 'plugin', name: 'dsh-alpha-deep', prefix: '/home/u/.dsh/profiles/web/node_modules/dsh-alpha/deep/' },
  { kind: 'harness', name: '@deepseek-ai/dsh-core', prefix: '/home/u/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-core/' },
  { kind: 'self', name: 'dsh-perf-lens', prefix: '/home/u/.dsh/profiles/web/node_modules/dsh-perf-lens/' },
])

describe('ownerKeyOfPath', () => {
  test('maps a path to the plugin that owns its directory', () => {
    expect(ownerKeyOfPath('/home/u/.dsh/profiles/web/node_modules/dsh-alpha/lib/index.js', INDEX))
      .toBe('plugin:dsh-alpha')
  })

  test('the most specific prefix wins', () => {
    expect(ownerKeyOfPath('/home/u/.dsh/profiles/web/node_modules/dsh-alpha/deep/x.js', INDEX))
      .toBe('plugin:dsh-alpha-deep')
  })

  test('a harness package is a harness owner, and this plugin is self', () => {
    expect(ownerKeyOfPath('/home/u/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-core/lib/a.js', INDEX))
      .toBe('harness:@deepseek-ai/dsh-core')
    expect(ownerKeyOfPath('/home/u/.dsh/profiles/web/node_modules/dsh-perf-lens/lib/a.js', INDEX))
      .toBe('self')
  })

  test('a path nobody owns is null, never a wrong plugin', () => {
    expect(ownerKeyOfPath('/home/u/.dsh/sessions/abc.jsonl', INDEX)).toBeNull()
  })

  test('Windows paths normalize the same way frame URLs do', () => {
    const windows = createOwnerIndex([
      { kind: 'plugin', name: 'dsh-beta', prefix: '/D:/Build/profile/node_modules/dsh-beta/' },
    ])
    expect(ownerKeyOfPath('D:\\Build\\profile\\node_modules\\dsh-beta\\lib\\x.js', windows)).toBe('plugin:dsh-beta')
  })
})

/** A directory tree expressed as path -> entries, so no disk is touched. */
function fakeFs(tree: Record<string, { name: string; dir?: boolean; size?: number }[]>): FootprintFs {
  return {
    openDir: async (path) => {
      const entries = tree[path]
      if (entries === undefined) throw new Error(`ENOENT ${path}`)
      return (async function * () {
        for (const entry of entries) yield { name: entry.name } as Dirent
      })()
    },
    lstat: async (path) => {
      const name = path.slice(path.lastIndexOf('/') + 1)
      for (const entries of Object.values(tree)) {
        const found = entries.find(entry => entry.name === name)
        if (found !== undefined) {
          return { size: found.size ?? 0, isDirectory: () => found.dir === true, isFile: () => found.dir !== true }
        }
      }
      throw new Error(`ENOENT ${path}`)
    },
  }
}

describe('DiskFootprintScanner', () => {
  const tree = {
    '/root': [
      { name: 'dsh-alpha', dir: true },
      { name: 'loose.txt', size: 10 },
    ],
    '/root/dsh-alpha': [
      { name: 'lib', dir: true },
      { name: 'cache.bin', size: 1000 },
    ],
    '/root/dsh-alpha/lib': [{ name: 'index.js', size: 500 }],
  }
  const index = createOwnerIndex([{ kind: 'plugin', name: 'dsh-alpha', prefix: '/root/dsh-alpha/' }])

  test('totals bytes per owner and reports what it walked', async () => {
    const scanner = new DiskFootprintScanner({ fs: fakeFs(tree), now: () => 5, ownerIndex: () => index })
    const scan = await scanner.scan(['/root'])
    expect(scan.perOwner.get('plugin:dsh-alpha')).toBe(1500)
    expect(scan.reading.scannedFiles).toBe(3)
    expect(scan.reading.scannedBytes).toBe(1510)
    // The loose file belongs to nobody, so it is walked but not owned.
    expect(scan.reading.ownedBytes).toBe(1500)
    expect(scan.reading.truncated).toBe(false)
  })

  test('an unreadable root degrades to an empty scan instead of throwing', async () => {
    const scanner = new DiskFootprintScanner({ fs: fakeFs({}), now: () => 5, ownerIndex: () => index })
    const scan = await scanner.scan(['/missing'])
    expect(scan.reading.scannedFiles).toBe(0)
    expect(scan.perOwner.size).toBe(0)
  })

  test('the entry budget is a floor on the figures and says so', async () => {
    const scanner = new DiskFootprintScanner(
      { fs: fakeFs(tree), now: () => 5, ownerIndex: () => index },
      { maxEntries: 1 },
    )
    const scan = await scanner.scan(['/root'])
    expect(scan.reading.truncated).toBe(true)
    expect(scan.reading.scannedBytes).toBeLessThan(1510)
  })

  test('the per-owner map is empty until the first scan completes', () => {
    const scanner = new DiskFootprintScanner({ fs: fakeFs(tree), now: () => 5, ownerIndex: () => index })
    expect(scanner.reading).toBeNull()
    expect(scanner.perOwner.size).toBe(0)
  })
})