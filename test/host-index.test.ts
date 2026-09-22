// Owner-prefix resolution. The loader's baseUrl is the profile include root, not
// the plugin's own directory, so the entry directory must be resolved from the
// module name against that anchor; a failure must yield '' (unattributable),
// never a catch-all prefix.

import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import { resolveEntryDir } from '../src/host/index'

describe('resolveEntryDir', () => {
  test('resolves an installed package against the anchor', () => {
    const dir = resolveEntryDir('@deepseek-ai/cordis', process.cwd())
    expect(dir).not.toBe('')
    expect(dir.replace(/\\/g, '/')).toContain('cordis')
  })

  test('accepts the loader directory file URL as the anchor', () => {
    // ctx.baseUrl = pathToFileURL(process.cwd()).href + '/' — a directory URL,
    // not a path. Joining it with a filename used to throw and empty the panel.
    const base = `${pathToFileURL(process.cwd()).href}/`
    const dir = resolveEntryDir('@deepseek-ai/cordis', base)
    expect(dir).not.toBe('')
    expect(dir.replace(/\\/g, '/')).toContain('cordis')
  })

  test('a malformed or unresolvable anchor degrades to empty, never throws', () => {
    expect(resolveEntryDir('@deepseek-ai/cordis', 'file:///no-such-dir-xyz/')).toBe('')
    expect(resolveEntryDir('@deepseek-ai/cordis', ':::not a path:::')).toBe('')
  })

  test('returns empty for an unresolvable module instead of a catch-all', () => {
    expect(resolveEntryDir('definitely-not-a-real-package-xyz', process.cwd())).toBe('')
  })

  test('returns empty without an anchor', () => {
    expect(resolveEntryDir('@deepseek-ai/cordis', '')).toBe('')
    expect(resolveEntryDir('@deepseek-ai/cordis', undefined)).toBe('')
  })
})
