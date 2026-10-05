// Combo URL parsing, segment arithmetic, owner resolution and jank folding.
//
// The fixtures replicate the modules package combo assembly
// (buildComboScript: prepareSource(part) + ";\n" per part, in URL order),
// because a drifted table misattributes every frame after the drift.

import { describe, expect, test } from 'vitest'
import {
  buildSegmentTable,
  clientExportOf,
  createClientSourceReader,
  LoafResolver,
  OTHER_OWNER,
  parsePluginUrl,
  pathOnDisk,
  prepareComboSource,
  resolveJankView,
  resolveScheduleView,
  segmentOwnerOf,
  segmentOwnerOfPosition,
  UNRESOLVED_OWNER,
  type LoafFs,
} from '../src/host/loaf-map'
import type { LoafReport, RawLoafScript, RawScheduleSite } from '../src/shared/contract'

describe('parsePluginUrl', () => {
  test('parses the one-resource combo form', () => {
    expect(parsePluginUrl('dsh-app://app/plugins/??dsh-claude-style/client.js&rev=69f7847450da'))
      .toEqual({ kind: 'single', id: 'dsh-claude-style' })
  })

  test('parses a relative one-resource form', () => {
    expect(parsePluginUrl('plugins/??dsh-context/client.js&rev=5085b2a6b0ef'))
      .toEqual({ kind: 'single', id: 'dsh-context' })
  })

  test('parses a multi-plugin batch, scoped names included', () => {
    const url = 'dsh-app://app/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js,@alm-allen/dsh-chat-ux/client.js,dsh-claude-style/client.js&rev=abc'
    expect(parsePluginUrl(url)).toEqual({
      kind: 'batch',
      ids: ['@deepseek-ai/dsh-client-ui-chat', '@alm-allen/dsh-chat-ux', 'dsh-claude-style'],
    })
  })

  test('parses a package chunk', () => {
    expect(parsePluginUrl('dsh-app://app/plugins/@scope/name/client.terminal.js?rev=abc'))
      .toEqual({ kind: 'chunk', id: '@scope/name' })
  })

  test('treats shell assets and foreign URLs as other', () => {
    expect(parsePluginUrl('dsh-app://app/assets/index-Q6zc2uHV.js')).toEqual({ kind: 'other' })
    expect(parsePluginUrl('https://example.test/x.js')).toEqual({ kind: 'other' })
    expect(parsePluginUrl('')).toEqual({ kind: 'other' })
  })

  test('rejects malformed combo members', () => {
    expect(parsePluginUrl('plugins/??/client.js&rev=x')).toEqual({ kind: 'other' })
    expect(parsePluginUrl('plugins/??a/client.js,b/other.js&rev=x')).toEqual({ kind: 'other' })
  })
})

describe('prepareComboSource', () => {
  test('strips both trailers and ensures a trailing newline', () => {
    expect(prepareComboSource('code();\n//# sourceURL=x\n')).toBe('code();\n')
    expect(prepareComboSource('code();\n//# sourceMappingURL=x\n')).toBe('code();\n')
    expect(prepareComboSource('code();')).toBe('code();\n')
  })

  test('strips a sourceURL trailer sitting after code without a newline', () => {
    expect(prepareComboSource('code();//# sourceURL=x')).toBe('code();\n')
  })
})

describe('buildSegmentTable + segmentOwnerOf', () => {
  // part a: prepared "aaa\n" (4) + ";\n" → [0, 6); part b: "bb\n" (3) + ";\n" → [6, 11)
  const sources = new Map([
    ['a', 'aaa'],
    ['b', 'bb'],
  ])
  const sourceOf = (id: string): string | undefined => sources.get(id)

  test('offsets accumulate deterministically in URL order', () => {
    const table = buildSegmentTable(['a', 'b'], sourceOf)
    expect(table.complete).toBe(true)
    expect(table.segments).toEqual([
      { id: 'a', start: 0, end: 6, known: true },
      { id: 'b', start: 6, end: 11, known: true },
    ])
  })

  test('resolves positions to the owning segment', () => {
    const table = buildSegmentTable(['a', 'b'], sourceOf)
    expect(segmentOwnerOf(table, 0)).toBe('a')
    expect(segmentOwnerOf(table, 5)).toBe('a')
    expect(segmentOwnerOf(table, 6)).toBe('b')
    expect(segmentOwnerOf(table, 10)).toBe('b')
    expect(segmentOwnerOf(table, 11)).toBeUndefined()
  })

  test('a missing part makes its own and later extents unknowable', () => {
    const table = buildSegmentTable(['a', 'missing', 'b'], sourceOf)
    expect(table.complete).toBe(false)
    expect(segmentOwnerOf(table, 0)).toBe('a')
    expect(segmentOwnerOf(table, 6)).toBeUndefined()
    expect(segmentOwnerOf(table, 7)).toBeUndefined()
  })
})

describe('LoafResolver', () => {
  const batchUrl = 'dsh-app://app/plugins/??a/client.js,b/client.js&rev=r1'
  const resolver = (sources: ReadonlyMap<string, string>) => new LoafResolver({
    clientSourceOf: (id) => sources.get(id),
  })

  test('single and chunk resolve without touching the filesystem', () => {
    const r = resolver(new Map())
    expect(r.resolve('plugins/??dsh-claude-style/client.js&rev=x', 0)).toBe('plugin:dsh-claude-style')
    expect(r.resolve('plugins/@alm-allen/dsh-chat-ux/client.main.js?rev=x', 3)).toBe('plugin:@alm-allen/dsh-chat-ux')
    expect(r.resolve('plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&rev=x', 0))
      .toBe('harness:@deepseek-ai/dsh-client-ui-chat')
  })

  test('batch positions resolve through the segment table', () => {
    const r = resolver(new Map([['a', 'aaa'], ['b', 'bb']]))
    expect(r.resolve(batchUrl, 2)).toBe('plugin:a')
    expect(r.resolve(batchUrl, 8)).toBe('plugin:b')
    expect(r.resolve(batchUrl, 11)).toBeUndefined()
  })

  test('tables cache per URL and stay within the bound', () => {
    const r = new LoafResolver({
      clientSourceOf: () => 'x',
      maxTables: 2,
    })
    const url = (n: number): string => `plugins/??a/client.js,b/client.js&rev=r${n}`
    r.resolve(url(1), 0)
    r.resolve(url(1), 0)
    expect(r.cachedTables).toBe(1)
    r.resolve(url(2), 0)
    r.resolve(url(3), 0)
    expect(r.cachedTables).toBe(2)
  })

  test('non-plugin URLs do not resolve', () => {
    const r = resolver(new Map())
    expect(r.resolve('dsh-app://app/assets/index.js', 0)).toBeUndefined()
  })
})

describe('clientExportOf', () => {
  test('reads the string and conditional forms', () => {
    expect(clientExportOf({ exports: { './client': './lib/client.js' } })).toBe('./lib/client.js')
    expect(clientExportOf({ exports: { './client': { default: './lib/client.js' } } })).toBe('./lib/client.js')
    expect(clientExportOf({})).toBeUndefined()
    expect(clientExportOf(null)).toBeUndefined()
  })
})

describe('createClientSourceReader', () => {
  // Measured layout: the loader anchors baseUrl at the resolved ENTRY directory
  // (…/pkg/lib/), so the manifest is one level up and only the name match proves
  // which package owns the directory.
  const files = new Map<string, string>([
    ['C:/prof/node_modules/dsh-claude-style/package.json', JSON.stringify({ name: 'dsh-claude-style', exports: { './client': './lib/client.js' } })],
    ['C:/prof/node_modules/dsh-claude-style/lib/client.js', 'bundle'],
  ])
  const fs: LoafFs = { readFile: (path) => files.get(path) }

  test('walks up from the entry directory to the owning manifest', () => {
    const dirs = new Map([['dsh-claude-style', '/C:/prof/node_modules/dsh-claude-style/lib/']])
    const read = createClientSourceReader(() => dirs, fs)
    expect(read('dsh-claude-style')).toBe('bundle')
    expect(read('absent')).toBeUndefined()
  })

  test('a package root directory still resolves', () => {
    const dirs = new Map([['dsh-claude-style', '/C:/prof/node_modules/dsh-claude-style/']])
    expect(createClientSourceReader(() => dirs, fs)('dsh-claude-style')).toBe('bundle')
  })

  test('a manifest whose name belongs to another package is rejected', () => {
    const dirs = new Map([['other-name', '/C:/prof/node_modules/dsh-claude-style/lib/']])
    expect(createClientSourceReader(() => dirs, fs)('other-name')).toBeUndefined()
  })

  test('an unreadable manifest or entry yields undefined, never a guess', () => {
    const empty: LoafFs = { readFile: () => undefined }
    const read = createClientSourceReader(() => new Map([['x', '/tmp/x/lib/']]), empty)
    expect(read('x')).toBeUndefined()
  })

  test('a manifest with no exports["./client"] yields undefined', () => {
    const bare: LoafFs = { readFile: (path) => path.endsWith('package.json') ? JSON.stringify({ name: 'x' }) : undefined }
    const read = createClientSourceReader(() => new Map([['x', '/tmp/x/lib/']]), bare)
    expect(read('x')).toBeUndefined()
  })
})

describe('pathOnDisk', () => {
  test('strips the leading slash before a Windows drive only', () => {
    expect(pathOnDisk('/D:/x/y')).toBe('D:/x/y')
    expect(pathOnDisk('/usr/lib/x')).toBe('/usr/lib/x')
    expect(pathOnDisk('D:/x')).toBe('D:/x')
  })
})

function script(url: string, charPosition: number, durationMs: number, forcedLayoutMs = 0): RawLoafScript {
  return { url, charPosition, functionName: 'f', invokerType: 'user-callback', durationMs, forcedLayoutMs }
}

describe('resolveJankView', () => {
  test('folds entries per owner, sorts by duration and reports coverage', () => {
    const loaf: LoafReport = {
      supported: true,
      scripts: [
        script('plugins/??a/client.js&rev=1', 0, 30, 5),
        script('plugins/??a/client.js&rev=1', 0, 10),
        script('plugins/??b/client.js&rev=1', 0, 20),
        script('dsh-app://app/assets/index.js', 0, 40),
      ],
      otherCount: 2,
      otherMs: 8,
    }
    const view = resolveJankView(loaf, (url) =>
      url.includes('a/client') ? 'plugin:a'
        : url.includes('b/client') ? 'plugin:b'
          : undefined)
    expect(view.rows).toEqual([
      { owner: 'plugin:a', durationMs: 40, forcedLayoutMs: 5, count: 2 },
      { owner: UNRESOLVED_OWNER, durationMs: 40, forcedLayoutMs: 0, count: 1 },
      { owner: 'plugin:b', durationMs: 20, forcedLayoutMs: 0, count: 1 },
      { owner: OTHER_OWNER, durationMs: 8, forcedLayoutMs: 0, count: 2 },
    ])
    // covered 60 of 108 total milliseconds.
    expect(view.attributedShare).toBeCloseTo(60 / 108, 6)
  })

  test('an empty window reports full coverage', () => {
    const view = resolveJankView({ supported: true, scripts: [], otherCount: 0, otherMs: 0 }, () => undefined)
    expect(view.rows).toEqual([])
    expect(view.attributedShare).toBe(1)
  })
})

describe('buildSegmentTable lineStarts', () => {
  // part a: "aaa\n" + ";\n"  → offsets 0..6, one newline at 3
  // part b: "bb\n" + ";\n"   → offsets 6..11
  const sources = new Map([['a', 'aaa'], ['b', 'bb']])
  const table = buildSegmentTable(['a', 'b'], (id) => sources.get(id))

  test('records the first offset of every generated line', () => {
    // aaa\n;\nbb\n;\n  → 5 lines, the last one empty after the final newline
    expect(table.lineStarts).toEqual([0, 4, 6, 9, 11])
  })

  test('resolves a line and column to the owning segment', () => {
    // line 1 col 1 → offset 0 (a); line 3 col 1 → offset 6 (b)
    expect(segmentOwnerOfPosition(table, 1, 1)).toBe('a')
    expect(segmentOwnerOfPosition(table, 2, 1)).toBe('a')
    expect(segmentOwnerOfPosition(table, 3, 1)).toBe('b')
    expect(segmentOwnerOfPosition(table, 3, 2)).toBe('b')
  })

  test('out-of-range and malformed positions resolve to nothing', () => {
    expect(segmentOwnerOfPosition(table, 99, 1)).toBeUndefined()
    expect(segmentOwnerOfPosition(table, 0, 1)).toBeUndefined()
    expect(segmentOwnerOfPosition(table, 1, 0)).toBeUndefined()
    expect(segmentOwnerOfPosition(table, 1.5, 1)).toBeUndefined()
  })

  test('an unreadable part keeps its position unknowable', () => {
    const partial = buildSegmentTable(['a', 'missing', 'b'], (id) => sources.get(id))
    expect(segmentOwnerOfPosition(partial, 3, 1)).toBeUndefined()
  })
})

describe('LoafResolver.resolvePosition', () => {
  const batchUrl = 'dsh-app://app/plugins/??a/client.js,b/client.js&rev=r1'
  const sources = new Map([['a', 'aaa'], ['b', 'bb']])

  test('a line and column resolve to the owning plugin key', () => {
    const resolver = new LoafResolver({ clientSourceOf: (id) => sources.get(id) })
    expect(resolver.resolvePosition(batchUrl, 1, 1)).toBe('plugin:a')
    expect(resolver.resolvePosition(batchUrl, 3, 1)).toBe('plugin:b')
  })

  test('single and chunk rows resolve by id without reading a file', () => {
    const resolver = new LoafResolver({ clientSourceOf: () => { throw new Error('must not read') } })
    expect(resolver.resolvePosition('plugins/??dsh-claude-style/client.js&rev=x', 1, 1))
      .toBe('plugin:dsh-claude-style')
    expect(resolver.resolvePosition('plugins/@scope/name/client.main.js?rev=x', 1, 1))
      .toBe('plugin:@scope/name')
  })

  test('non-plugin and out-of-range positions resolve to nothing', () => {
    const resolver = new LoafResolver({ clientSourceOf: (id) => sources.get(id) })
    expect(resolver.resolvePosition('dsh-app://app/assets/index.js', 1, 1)).toBeUndefined()
    expect(resolver.resolvePosition(batchUrl, 99, 1)).toBeUndefined()
  })
})

function scheduleSite(line: number, column: number, calls: number, selfMs: number, maxMs: number): RawScheduleSite {
  return { url: 'plugins/??a/client.js,b/client.js&rev=r1', line, column, calls, selfMs, maxMs }
}

describe('resolveScheduleView', () => {
  /** Lines 1-2 are plugin:a, line 3 is plugin:b, every other line is unowned. */
  const ownerOf = (url: string, line: number): string | undefined =>
    url.includes('a/client') ? (line <= 2 ? 'plugin:a' : line === 3 ? 'plugin:b' : undefined) : undefined

  test('folds sites per owner, keeps the longest call and reports coverage', () => {
    const view = resolveScheduleView({
      active: true,
      sites: [
        scheduleSite(1, 1, 2, 10, 6),
        scheduleSite(3, 1, 1, 30, 30),
        scheduleSite(5, 1, 1, 40, 40),
      ],
      windowMs: 5000,
    }, ownerOf)
    expect(view.rows).toEqual([
      { owner: UNRESOLVED_OWNER, scheduledMs: 40, calls: 1, maxMs: 40 },
      { owner: 'plugin:b', scheduledMs: 30, calls: 1, maxMs: 30 },
      { owner: 'plugin:a', scheduledMs: 10, calls: 2, maxMs: 6 },
    ])
    expect(view.attributedShare).toBeCloseTo(40 / 80, 6)
    expect(view.contract).toBe('untested')
  })

  test('an empty window reports full coverage and an untested contract', () => {
    const view = resolveScheduleView({ active: true, sites: [], windowMs: 5000 }, () => undefined)
    expect(view.rows).toEqual([])
    expect(view.attributedShare).toBe(1)
    expect(view.contract).toBe('untested')
  })

  test('the self-test passing reports ok, resolving anywhere else reports mismatch', () => {
    const selfTest = { url: 'plugins/??a/client.js,b/client.js&rev=r1', line: 1, column: 1 }
    const ok = resolveScheduleView({ active: true, sites: [], selfTest, windowMs: 5000 }, () => 'self')
    expect(ok.contract).toBe('ok')
    const wrong = resolveScheduleView({ active: true, sites: [], selfTest, windowMs: 5000 }, () => 'plugin:other')
    expect(wrong.contract).toBe('mismatch')
    const unresolved = resolveScheduleView({ active: true, sites: [], selfTest, windowMs: 5000 }, () => undefined)
    expect(unresolved.contract).toBe('mismatch')
  })
})
