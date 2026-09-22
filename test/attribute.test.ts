// Locks the decisive attribution rule (docs/evidence.md evidence 5): a sample
// belongs to the nearest plugin frame on its ancestor stack, never to the file
// the sampled frame is defined in. If this test is ever relaxed, the panel will
// systematically blame shared dependencies instead of the plugins that call them.

import { describe, expect, test } from 'vitest'
import {
  attributeFrames,
  attributeNode,
  buildNodeMap,
  buildParentMap,
  classifyFrame,
  classifyFrameUrl,
  createOwnerIndex,
  normalizePath,
  tallySamples,
  type OwnerIndex,
  type ProfileNode,
} from '../src/host/attribute'
import { buildOwnerIndex, directoryPrefixOf, harnessNodeModulesPrefix } from '../src/host/plugin-index'

const INDEX: OwnerIndex = createOwnerIndex([
  { kind: 'plugin', name: 'pluginA', prefix: '/plugins/pluginA/' },
  { kind: 'plugin', name: 'pluginB', prefix: '/plugins/pluginB/' },
])

// Fixture mirroring evidence 5: pluginA calls the shared dependency 200 times,
// pluginB 60 times, so the true ratio is 200 / 60 = 3.33.
const NODES: ProfileNode[] = [
  { id: 1, callFrame: { url: '/plugins/pluginA/index.mjs' }, children: [2] },
  { id: 2, callFrame: { url: '/shared/dep.mjs' }, children: [3] },
  { id: 3, callFrame: { url: '/shared/leaf.mjs' }, children: [] },
  { id: 4, callFrame: { url: '/plugins/pluginB/index.mjs' }, children: [5] },
  { id: 5, callFrame: { url: '/shared/dep.mjs' }, children: [6] },
  { id: 6, callFrame: { url: '/shared/leaf.mjs' }, children: [] },
]

const SAMPLES: number[] = [...Array<number>(200).fill(3), ...Array<number>(60).fill(6)]

describe('ancestor-walk attribution', () => {
  test('attributes shared-dependency samples to the calling plugin', () => {
    const counts = tallySamples(SAMPLES, NODES, INDEX)
    expect(counts.get('plugin:pluginA')).toBe(200)
    expect(counts.get('plugin:pluginB')).toBe(60)
    expect(counts.get('unattributed') ?? 0).toBe(0)
  })

  test('repeated samples of one node count once per sample', () => {
    // The walk is memoised per node; counting must still be per sample.
    const counts = tallySamples([2, 2, 2, 5, 5], NODES, INDEX)
    expect(counts.get('plugin:pluginA')).toBe(3)
    expect(counts.get('plugin:pluginB')).toBe(2)
  })

  test('reproduces the 200:60 ratio within sampling tolerance', () => {
    const counts = tallySamples(SAMPLES, NODES, INDEX)
    const a = counts.get('plugin:pluginA') ?? 0
    const b = counts.get('plugin:pluginB') ?? 0
    expect(a / b).toBeCloseTo(200 / 60, 1)
  })

  test('naive self-frame attribution would lose every shared sample', () => {
    // The failure mode this design exists to prevent: classifying the sampled
    // frame itself drops all 260 samples into the unattributable bucket.
    const lost = SAMPLES.filter(nodeId => {
      const node = NODES.find(candidate => candidate.id === nodeId)
      return classifyFrameUrl(node?.callFrame.url, INDEX).kind !== 'plugin'
    })
    expect(lost).toHaveLength(260)
  })

  test('a runtime leaf under a plugin frame resolves to the plugin', () => {
    const nodes: ProfileNode[] = [
      { id: 1, callFrame: { url: '/plugins/pluginA/index.mjs' }, children: [2] },
      { id: 2, callFrame: { url: 'node:fs' }, children: [] },
    ]
    const owner = attributeNode(2, buildNodeMap(nodes), buildParentMap(nodes), INDEX)
    expect(owner).toEqual({ kind: 'plugin', name: 'pluginA' })
  })

  test('a harness frame outranks a runtime frame when no plugin is on the stack', () => {
    const index = createOwnerIndex([
      { kind: 'harness', name: 'dsh-core', prefix: '/dsh/core/' },
    ])
    const nodes: ProfileNode[] = [
      { id: 1, callFrame: { url: '/dsh/core/loader.mjs' }, children: [2] },
      { id: 2, callFrame: { url: 'node:fs' }, children: [] },
    ]
    const owner = attributeNode(2, buildNodeMap(nodes), buildParentMap(nodes), index)
    expect(owner).toEqual({ kind: 'harness', name: 'dsh-core' })
  })

  test('a stack with neither plugin nor harness is unattributed', () => {
    const nodes: ProfileNode[] = [
      { id: 1, callFrame: { url: 'node:internal/fs' }, children: [2] },
      { id: 2, callFrame: { url: '/shared/dep.mjs' }, children: [] },
    ]
    const owner = attributeNode(2, buildNodeMap(nodes), buildParentMap(nodes), INDEX)
    expect(owner.kind).toBe('runtime')
  })
})

describe('idle separation', () => {
  test('the profiler idle node is idle, not runtime', () => {
    // Observed live: idle samples carry an empty URL and functionName '(idle)'.
    expect(classifyFrame({ url: '', functionName: '(idle)' }, INDEX)).toEqual({ kind: 'idle' })
  })

  test('a native frame with a name but no URL stays runtime', () => {
    expect(classifyFrame({ url: '', functionName: 'dispatch' }, INDEX)).toEqual({ kind: 'runtime' })
  })

  test('an idle stack resolves to idle even though its root is runtime', () => {
    expect(attributeFrames([{ url: '', functionName: '(idle)' }, { url: '', functionName: '(root)' }], INDEX))
      .toEqual({ kind: 'idle' })
  })

  test('a plugin frame above an idle leaf still wins', () => {
    expect(attributeFrames([{ url: '', functionName: '(idle)' }, { url: '/plugins/pluginA/index.mjs' }], INDEX))
      .toEqual({ kind: 'plugin', name: 'pluginA' })
  })
})

describe('frame classification', () => {
  test('treats node internals, native and synthetic roots as runtime', () => {
    for (const url of ['node:fs', 'node:internal/fs/utils', 'native', '(root)', '(program)']) {
      expect(classifyFrameUrl(url, INDEX).kind).toBe('runtime')
    }
  })

  test('picks the most specific prefix when rules nest', () => {
    const nested = createOwnerIndex([
      { kind: 'plugin', name: 'outer', prefix: '/pkg/' },
      { kind: 'plugin', name: 'inner', prefix: '/pkg/node_modules/inner/' },
    ])
    expect(classifyFrameUrl('/pkg/node_modules/inner/lib/index.js', nested)).toEqual({ kind: 'plugin', name: 'inner' })
    expect(classifyFrameUrl('/pkg/lib/index.js', nested)).toEqual({ kind: 'plugin', name: 'outer' })
  })

  test('normalizes file URLs and backslashes before matching', () => {
    expect(normalizePath('file:///D:/Build/x/index.mjs')).toBe('/D:/Build/x/index.mjs')
    expect(classifyFrameUrl('file:///plugins/pluginA/index.mjs', INDEX)).toEqual({ kind: 'plugin', name: 'pluginA' })
  })
})

describe('owner index from loader entries', () => {
  test('classifies self, harness and third-party entries', () => {
    const index = buildOwnerIndex([
      { moduleName: 'dsh-perf-lens', entryId: 'perf-lens', baseUrl: '/plugins/dsh-perf-lens/lib/index.js' },
      { moduleName: '@deepseek-ai/dsh-plugin-inventory', entryId: 'inventory', baseUrl: '/dsh/plugin-inventory/lib/index.js' },
      { moduleName: 'dsh-context', entryId: 'ctx', baseUrl: '/plugins/dsh-context/lib/index.js' },
    ])
    expect(classifyFrameUrl('/plugins/dsh-perf-lens/lib/index.js', index).kind).toBe('self')
    expect(classifyFrameUrl('/dsh/plugin-inventory/lib/index.js', index).kind).toBe('harness')
    expect(classifyFrameUrl('/plugins/dsh-context/lib/client.js', index)).toEqual({ kind: 'plugin', name: 'dsh-context' })
  })

  test('accepts a module file or a directory as the resolved base', () => {
    expect(directoryPrefixOf('/plugins/x/lib/index.js')).toBe('/plugins/x/lib/')
    expect(directoryPrefixOf('/plugins/x/lib')).toBe('/plugins/x/lib/')
    expect(directoryPrefixOf('/plugins/x/lib/')).toBe('/plugins/x/lib/')
  })
})

describe('Windows drive canonicalization', () => {
  test('bare and file-URL drive paths normalize the same', () => {
    expect(normalizePath('D:/Build/x/index.js')).toBe('/D:/Build/x/index.js')
    expect(normalizePath('file:///D:/Build/x/index.js')).toBe('/D:/Build/x/index.js')
    expect(normalizePath('D:\\Build\\x')).toBe('/D:/Build/x')
    expect(normalizePath('/home/me/x')).toBe('/home/me/x')
  })

  test('a bare drive base still matches a file-URL frame', () => {
    const index = buildOwnerIndex([
      { moduleName: 'dsh-context', entryId: 'ctx', baseUrl: 'D:/Build/dsh-context/lib/index.js' },
    ])
    expect(classifyFrameUrl('file:///D:/Build/dsh-context/lib/client.js', index))
      .toEqual({ kind: 'plugin', name: 'dsh-context' })
  })

  test('derives the harness @deepseek-ai directory from the running entry path', () => {
    expect(harnessNodeModulesPrefix('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'))
      .toBe('/C:/Users/me/AppData/Roaming/npm/node_modules/@deepseek-ai/')
    expect(harnessNodeModulesPrefix('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'))
      .toBe('/usr/lib/node_modules/@deepseek-ai/')
    expect(harnessNodeModulesPrefix('/somewhere/else.js')).toBeUndefined()
    expect(harnessNodeModulesPrefix(undefined)).toBeUndefined()
  })

  test('the harness fallback catches core frames from any install copy', () => {
    const index = buildOwnerIndex([], { harnessPrefix: '/npm/node_modules/@deepseek-ai/' })
    expect(classifyFrameUrl('file:///npm/node_modules/@deepseek-ai/dsh/lib/index.js', index).kind).toBe('harness')
  })

  test('skips an unresolved base instead of matching every frame', () => {
    const index = buildOwnerIndex([
      { moduleName: 'mystery', entryId: 'm', baseUrl: '' },
      { moduleName: 'known', entryId: 'k', baseUrl: '/plugins/known/lib/index.js' },
    ])
    expect(index.rules).toHaveLength(1)
    expect(classifyFrameUrl('/plugins/known/lib/x.js', index)).toEqual({ kind: 'plugin', name: 'known' })
    expect(classifyFrameUrl('/elsewhere/x.js', index).kind).toBe('unattributed')
  })
})
