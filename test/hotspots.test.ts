// Hot-function aggregation and the in-memory-only store.
//
// The privacy half matters as much as the arithmetic: these are frame-level
// facts, so the tests assert they never reach a serialized snapshot.

import { describe, expect, test } from 'vitest'
import { aggregateHotspots, HotspotStore } from '../src/host/hotspots'
import { createOwnerIndex, type ProfileNode } from '../src/host/attribute'
import type { PerfSnapshot } from '../src/shared/contract'

const INDEX = createOwnerIndex([{ kind: 'plugin', name: 'pluginA', prefix: '/p/a' }])

// root -> doWork(2) -> read(4); root -> other(3); root -> foreign(5)
const NODES: ProfileNode[] = [
  { id: 1, callFrame: { url: '', functionName: '(root)' }, children: [2, 3, 5] },
  { id: 2, callFrame: { url: '/p/a/index.js', functionName: 'doWork', lineNumber: 10 }, children: [4] },
  { id: 3, callFrame: { url: '/p/a/index.js', functionName: 'other', lineNumber: 20 } },
  { id: 4, callFrame: { url: 'node:fs', functionName: 'read' } },
  { id: 5, callFrame: { url: '/elsewhere/x.js', functionName: 'foreign' } },
]

describe('aggregateHotspots', () => {
  test('groups leaf frames per plugin, keeping the owning ancestor', () => {
    // 2x doWork, 3x read (a runtime frame whose ancestor is pluginA), 1x other,
    // 1x foreign (unattributed, must be dropped).
    const samples = [2, 2, 4, 4, 4, 3, 5]
    const table = aggregateHotspots(samples, NODES, INDEX, 0.25)
    const rows = table.get('plugin:pluginA')
    expect(rows?.map(row => row.functionName)).toEqual(['read', 'doWork', 'other'])
    expect(rows?.[0]).toMatchObject({ functionName: 'read', samples: 3, selfMs: 0.75 })
    expect(rows?.[1]).toMatchObject({ functionName: 'doWork', lineNumber: 10, samples: 2, selfMs: 0.5 })
    expect(table.has('unattributed')).toBe(false)
  })

  test('honours the per-plugin limit', () => {
    const table = aggregateHotspots([2, 4, 4, 3], NODES, INDEX, 1, 2)
    expect(table.get('plugin:pluginA')?.map(row => row.functionName)).toEqual(['read', 'doWork'])
  })

  test('an empty sample list yields an empty table', () => {
    expect(aggregateHotspots([], NODES, INDEX, 1).size).toBe(0)
  })

  test('harness packages and self get their own tables, idle stays out', () => {
    const index = createOwnerIndex([
      { kind: 'harness', name: '@deepseek-ai/dsh-client-hmr', prefix: '/h/hmr' },
      { kind: 'self', name: 'dsh-perf-lens', prefix: '/s/lens' },
    ])
    const nodes: ProfileNode[] = [
      { id: 1, callFrame: { url: '', functionName: '(root)' }, children: [2, 3, 4] },
      { id: 2, callFrame: { url: '/h/hmr/lib/index.js', functionName: 'tick', lineNumber: 5 } },
      { id: 3, callFrame: { url: '/s/lens/lib/index.js', functionName: 'sample', lineNumber: 9 } },
      { id: 4, callFrame: { url: '', functionName: '(idle)' } },
    ]
    const table = aggregateHotspots([2, 3, 4], nodes, index, 1)
    expect(table.get('harness:@deepseek-ai/dsh-client-hmr')?.[0]?.functionName).toBe('tick')
    expect(table.get('self')?.[0]?.functionName).toBe('sample')
    expect(table.has('idle')).toBe(false)
  })
})

describe('HotspotStore', () => {
  test('replace, get and clear', () => {
    const store = new HotspotStore()
    expect(store.get('pluginA')).toBeNull()
    store.replace(new Map([['plugin:pluginA', [{ functionName: 'doWork', url: '/p/a/index.js', lineNumber: 10, selfMs: 1, samples: 1 }]]]))
    expect(store.get('pluginA')?.map(row => row.functionName)).toEqual(['doWork'])
    store.clear()
    expect(store.get('pluginA')).toBeNull()
  })

  test('resolves a raw owner key for the harness breakdown and self rows', () => {
    const store = new HotspotStore()
    store.replace(new Map([
      ['harness:@deepseek-ai/dsh-client-hmr', [{ functionName: 'tick', url: '/h/hmr/lib/index.js', lineNumber: 5, selfMs: 1, samples: 1 }]],
      ['self', [{ functionName: 'sample', url: '/s/lens/lib/index.js', lineNumber: 9, selfMs: 1, samples: 1 }]],
    ]))
    expect(store.get('harness:@deepseek-ai/dsh-client-hmr')?.[0]?.functionName).toBe('tick')
    expect(store.get('self')?.[0]?.functionName).toBe('sample')
    // The folded row aggregates packages, so it has no table of its own.
    expect(store.get('harness')).toBeNull()
  })

  test('frame-level data never appears in a serialized snapshot', () => {
    const store = new HotspotStore()
    store.replace(new Map([['plugin:pluginA', [{ functionName: 'doWork', url: '/p/a/index.js', lineNumber: 10, selfMs: 1, samples: 1 }]]]))
    const snapshot: PerfSnapshot = {
      windowStartedAt: 1, mode: 'duty',
      global: {
        rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0,
        eventLoopLagP99Ms: 0, gcPauseMs: 0, fsOpsTotal: 0,
        sampleWindowMs: 5000, sampleCount: 1, idleSamples: 0,
      },
      plugins: [], unattributedShare: 0, selfShare: 0,
    }
    expect(JSON.stringify(snapshot)).not.toContain('doWork')
  })
})
