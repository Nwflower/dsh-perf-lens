// Retention semantics: a fixed-capacity ring for the live panel, one JSONL line
// per window on disk, and pruning that never grows without bound.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { PerfSnapshot, PluginMetricRow } from '../src/shared/contract'
import {
  HistoryStore,
  historyFileName,
  NODE_HISTORY_FS,
  parseSnapshot,
  RingBuffer,
  serializeSnapshot,
  type HistoryFs,
} from '../src/host/history'
import { aggregateStats, aggregateTrend } from '../src/host/stats'

function snapshot(at: number): PerfSnapshot {
  return {
    windowStartedAt: at,
    mode: 'duty',
    global: {
      rss: 1, heapUsed: 2, heapTotal: 3, external: 4, arrayBuffers: 5,
      eventLoopLagP99Ms: 6, gcPauseMs: 7, fsOpsTotal: 8, sampleWindowMs: 5000, sampleCount: 9, idleSamples: 0, sampleIntervalMs: 0.5,
    },
    plugins: [],
    unattributedShare: 0,
    selfShare: 0,
  }
}

/** A plugin row with every metric zero unless overridden. */
function row(moduleName: string, overrides: Partial<PluginMetricRow> = {}): PluginMetricRow {
  return {
    moduleName, entryId: moduleName, fiberPhase: 'active', cpuShare: 0, cpuSelfMs: 0,
    liveHeapBytes: 0, allocBytesPerSec: 0, fsReadOps: 0, fsWriteOps: 0,
    fsReadBytes: 0, fsWriteBytes: 0, coverage: 0, listeners: 0,
    diskFootprintBytes: 0,
    ...overrides,
  }
}

/** In-memory HistoryFs so retention is tested without touching the disk. */
class MemoryFs implements HistoryFs {
  readonly files = new Map<string, { content: string; mtimeMs: number }>()
  /** mtime stamped onto files created from now on. */
  nowMs = 0
  /** Every tail read, so a test can see what was (not) re-read. */
  readonly tailReads: { path: string; position: number }[] = []

  mkdirSync(): void { /* directories are implicit */ }

  appendFileSync(path: string, data: string): void {
    const current = this.files.get(path)
    this.files.set(path, {
      content: (current?.content ?? '') + data,
      mtimeMs: current?.mtimeMs ?? this.nowMs,
    })
  }

  readFileSync(path: string): string {
    const file = this.files.get(path)
    if (file === undefined) throw new Error('ENOENT')
    return file.content
  }

  readTailSync(path: string, position: number): Buffer {
    this.tailReads.push({ path, position })
    return Buffer.from(this.readFileSync(path)).subarray(position)
  }

  readdirSync(path: string): string[] {
    const names: string[] = []
    for (const key of this.files.keys()) {
      if (!key.startsWith(path + sep)) continue
      const rest = key.slice(path.length + 1)
      if (!rest.includes(sep)) names.push(rest)
    }
    return names
  }

  statSync(path: string): { size: number; mtimeMs: number } {
    const file = this.files.get(path)
    if (file === undefined) throw new Error('ENOENT')
    return { size: Buffer.byteLength(file.content), mtimeMs: file.mtimeMs }
  }

  unlinkSync(path: string): void {
    this.files.delete(path)
  }
}

describe('RingBuffer', () => {
  test('drops the oldest item on overflow', () => {
    const ring = new RingBuffer<number>(2)
    ring.push(1)
    ring.push(2)
    ring.push(3)
    expect(ring.toArray()).toEqual([2, 3])
    expect(ring.size).toBe(2)
  })

  test('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer<number>(0)).toThrow(RangeError)
  })
})

describe('snapshot records', () => {
  test('round-trips through JSONL', () => {
    const value = snapshot(123)
    expect(parseSnapshot(serializeSnapshot(value))).toEqual(value)
  })

  test('the harness breakdown is live-only and never persisted', () => {
    const value: PerfSnapshot = {
      ...snapshot(1),
      harnessBreakdown: [{
        moduleName: 'harness:@deepseek-ai/dsh-client-hmr',
        cpuShare: 0.1, cpuSelfMs: 1, liveHeapBytes: 0, fsReadOps: 0, fsWriteOps: 0,
      }],
    }
    const line = serializeSnapshot(value)
    // The log keeps the folded harness row, not ten sub-package rows per window.
    expect(line).not.toContain('harnessBreakdown')
    expect(parseSnapshot(line)?.harnessBreakdown).toBeUndefined()
  })

  test('drops all-zero rows and keeps every row with activity', () => {
    const value: PerfSnapshot = {
      ...snapshot(1),
      plugins: [
        row('idle-plugin'),
        row('cpu-plugin', { cpuShare: 0.1, cpuSelfMs: 3 }),
        row('io-plugin', { fsWriteOps: 2 }),
        row('heap-plugin', { liveHeapBytes: 4096 }),
      ],
    }
    const parsed = parseSnapshot(serializeSnapshot(value))
    // Zero rows are the inventory restated, not a measurement: the log keeps
    // only the rows a reader can tell apart from the plugin list.
    expect(parsed?.plugins.map(plugin => plugin.moduleName)).toEqual([
      'cpu-plugin', 'io-plugin', 'heap-plugin',
    ])
  })

  test('round-trips an active row without loss', () => {
    const active = row('active-plugin', { cpuShare: 0.25, cpuSelfMs: 7, fsReadOps: 3, liveHeapBytes: 99 })
    const parsed = parseSnapshot(serializeSnapshot({ ...snapshot(1), plugins: [active] }))
    const persisted = parsed?.plugins[0]
    expect(persisted?.moduleName).toBe('active-plugin')
    expect(persisted?.cpuShare).toBe(0.25)
    expect(persisted?.cpuSelfMs).toBe(7)
    expect(persisted?.fsReadOps).toBe(3)
    expect(persisted?.liveHeapBytes).toBe(99)
    // The live gauges do not survive: they are state, not window cost.
    expect(persisted).not.toHaveProperty('listeners')
    expect(persisted).not.toHaveProperty('diskFootprintBytes')
  })

  test('live gauges are stripped: they are state, not window cost', () => {
    // A listener, an on-disk byte count or a live timer describes the moment the
    // window closed, not what the window cost. Persisting them would make every
    // plugin holding one idle timer an "active" row in every record, so they are
    // stripped and the log's shape stays what the range aggregators expect.
    const value: PerfSnapshot = {
      ...snapshot(1),
      processTree: { at: 1, count: 3, rssBytes: 4096, cpuCoreShare: 2, intervalMs: 30_000, coverage: 1, top: [] },
      diskFootprint: { scannedAt: 1, scannedFiles: 10, scannedBytes: 100, ownedBytes: 50, truncated: false },
      plugins: [row('leaky-plugin', { listeners: 42, diskFootprintBytes: 8192 })],
    }
    const line = serializeSnapshot(value)
    expect(line).not.toContain('processTree')
    expect(line).not.toContain('diskFootprint')
    expect(line).not.toContain('listeners')
    // The row has no window cost, so it is not persisted at all.
    expect(parseSnapshot(line)?.plugins).toEqual([])
  })

  test('ignores blank and malformed lines', () => {
    expect(parseSnapshot('')).toBeNull()
    expect(parseSnapshot('   ')).toBeNull()
    expect(parseSnapshot('{not json')).toBeNull()
    expect(parseSnapshot('42')).toBeNull()
  })

  test('names files per UTC day', () => {
    expect(historyFileName(new Date('2026-09-05T23:59:59Z'))).toBe('metrics-20260905.jsonl')
  })
})

describe('HistoryStore', () => {
  test('records to the ring and to the day file', () => {
    const fs = new MemoryFs()
    const store = new HistoryStore({ dir: 'hist', retentionDays: 14, maxBytes: 1e9 }, fs)
    store.record(snapshot(1), true, new Date('2026-09-05T00:00:00Z'))
    store.record(snapshot(2), true, new Date('2026-09-05T00:00:01Z'))
    expect(store.recent().map(s => s.windowStartedAt)).toEqual([1, 2])
    const lines = [...fs.files.values()][0]?.content.split('\n').filter(Boolean) ?? []
    expect(lines).toHaveLength(2)
    expect(store.read().map(s => s.windowStartedAt)).toEqual([1, 2])
  })

  test('filters reads by since', () => {
    const fs = new MemoryFs()
    const store = new HistoryStore({ dir: 'hist', retentionDays: 14, maxBytes: 1e9 }, fs)
    store.record(snapshot(10), true, new Date('2026-09-05T00:00:00Z'))
    store.record(snapshot(20), true, new Date('2026-09-05T00:00:01Z'))
    expect(store.read(15).map(s => s.windowStartedAt)).toEqual([20])
  })

  test('persist=false keeps the ring only', () => {
    const fs = new MemoryFs()
    const store = new HistoryStore({ dir: 'hist', retentionDays: 14, maxBytes: 1e9 }, fs)
    store.record(snapshot(1), false)
    expect(store.recent()).toHaveLength(1)
    expect(fs.files.size).toBe(0)
  })

  test('prunes files past retention', () => {
    const fs = new MemoryFs()
    const store = new HistoryStore({ dir: 'hist', retentionDays: 1, maxBytes: 1e9 }, fs)
    fs.nowMs = new Date('2026-09-01T00:00:00Z').getTime()
    store.record(snapshot(1), true, new Date('2026-09-01T00:00:00Z'))
    const now = new Date('2026-09-05T00:00:00Z').getTime()
    expect(store.prune(now)).toHaveLength(1)
    expect(fs.files.size).toBe(0)
  })

  test('prunes oldest files when over the size cap', () => {
    const fs = new MemoryFs()
    const store = new HistoryStore({ dir: 'hist', retentionDays: 365, maxBytes: 200 }, fs)
    fs.nowMs = new Date('2026-09-01T00:00:00Z').getTime()
    store.record(snapshot(1), true, new Date('2026-09-01T00:00:00Z'))
    fs.nowMs = new Date('2026-09-02T00:00:00Z').getTime()
    store.record(snapshot(2), true, new Date('2026-09-02T00:00:00Z'))
    const now = new Date('2026-09-03T00:00:00Z').getTime()
    const deleted = store.prune(now)
    expect(deleted.length).toBeGreaterThanOrEqual(1)
    expect(fs.files.size).toBeLessThan(2)
  })
})

describe('HistoryStore.summaries (the range endpoints read path)', () => {
  const DAY = new Date('2026-09-05T00:00:00Z').getTime()
  const at = (offsetMs: number): Date => new Date(DAY + offsetMs)
  const windowAt = (offsetMs: number, plugins: PluginMetricRow[] = []): PerfSnapshot =>
    ({ ...snapshot(DAY + offsetMs), plugins })
  const store = (fs: MemoryFs, maxBytes = 1e9) =>
    new HistoryStore({ dir: 'hist', retentionDays: 14, maxBytes }, fs)
  const times = (history: HistoryStore, since?: number) =>
    history.summaries(since).map(window => window.windowStartedAt - DAY)

  test('feeds the aggregators exactly what a full read does', () => {
    const fs = new MemoryFs()
    const history = store(fs)
    history.record(windowAt(0, [row('a', { cpuShare: 0.5, cpuSelfMs: 5 }), row('b', { cpuShare: 0.25, cpuSelfMs: 2 })]), true, at(5000))
    history.record(windowAt(35_000, [row('a', { cpuShare: 0.1, cpuSelfMs: 1 })]), true, at(40_000))
    history.record(windowAt(70_000, [row('b', { liveHeapBytes: 4096 })]), true, at(75_000))
    const now = DAY + 80_000
    expect(aggregateStats(history.summaries(DAY), '1h', DAY, now))
      .toEqual(aggregateStats(history.read(DAY), '1h', DAY, now))
    expect(aggregateTrend(history.summaries(DAY), '1h', DAY, 120))
      .toEqual(aggregateTrend(history.read(DAY), '1h', DAY, 120))
  })

  test('parses each line once: later calls read only the appended tail', () => {
    const fs = new MemoryFs()
    const history = store(fs)
    history.record(windowAt(0), true, at(5000))
    history.record(windowAt(1000), true, at(6000))
    expect(times(history)).toEqual([0, 1000])
    const path = [...fs.files.keys()][0] ?? ''
    const consumed = Buffer.byteLength(fs.files.get(path)?.content ?? '')

    // Nothing new: no read at all.
    expect(times(history)).toEqual([0, 1000])
    expect(fs.tailReads).toEqual([{ path, position: 0 }])

    history.record(windowAt(2000), true, at(7000))
    expect(times(history)).toEqual([0, 1000, 2000])
    expect(fs.tailReads).toEqual([{ path, position: 0 }, { path, position: consumed }])
  })

  test('a line still being written is picked up once it is finished', () => {
    const fs = new MemoryFs()
    const history = store(fs)
    history.record(windowAt(0), true, at(5000))
    const path = [...fs.files.keys()][0] ?? ''
    const line = serializeSnapshot(windowAt(1000))
    fs.appendFileSync(path, line.slice(0, 20))
    expect(times(history)).toEqual([0])
    fs.appendFileSync(path, line.slice(20) + '\n')
    expect(times(history)).toEqual([0, 1000])
  })

  test('holds only rows with activity, including from windows logged before the writer dropped zeros', () => {
    const fs = new MemoryFs()
    const history = store(fs)
    history.record(windowAt(0), true, at(5000))
    const path = [...fs.files.keys()][0] ?? ''
    // A legacy line: the full inventory, zeros included.
    const legacy = { ...windowAt(1000), plugins: [row('idle'), row('busy', { cpuShare: 1, cpuSelfMs: 4 })] }
    fs.appendFileSync(path, JSON.stringify(legacy) + '\n')
    const [, last] = history.summaries()
    expect(last?.plugins).toEqual([{ moduleName: 'busy', cpuShare: 1, cpuSelfMs: 4 }])
  })

  test('skips a malformed record instead of failing every later read', () => {
    const fs = new MemoryFs()
    const history = store(fs)
    history.record(windowAt(0), true, at(5000))
    const path = [...fs.files.keys()][0] ?? ''
    fs.appendFileSync(path, '{"unexpected":true}\n{broken\n')
    history.record(windowAt(1000), true, at(6000))
    expect(times(history)).toEqual([0, 1000])
  })

  test('does not open day files that ended before the range starts', () => {
    const fs = new MemoryFs()
    const history = store(fs)
    const old = DAY - 4 * 24 * 60 * 60 * 1000
    history.record({ ...snapshot(old), plugins: [] }, true, new Date(old + 5000))
    history.record(windowAt(0), true, at(5000))
    expect(times(history, DAY)).toEqual([0])
    expect(fs.tailReads.map(read => read.path)).toEqual([join('hist', historyFileName(at(0)))])
  })

  test('starts a replaced file over instead of reading it from a stale offset', () => {
    const fs = new MemoryFs()
    const history = store(fs)
    history.record(windowAt(0), true, at(5000))
    history.record(windowAt(1000), true, at(6000))
    expect(times(history)).toEqual([0, 1000])
    const path = [...fs.files.keys()][0] ?? ''
    fs.files.set(path, { content: serializeSnapshot(windowAt(9000)) + '\n', mtimeMs: 0 })
    expect(times(history)).toEqual([9000])
  })

  test('forgets a pruned file even if it regrows past the old offset before the next read', () => {
    const fs = new MemoryFs()
    const history = store(fs, 1)
    history.record(windowAt(0), true, at(5000))
    history.record(windowAt(1000), true, at(6000))
    expect(times(history)).toEqual([0, 1000])
    expect(history.prune(DAY)).toHaveLength(1)
    for (const offset of [2000, 3000, 4000]) history.record(windowAt(offset), true, at(offset + 5000))
    expect(times(history)).toEqual([2000, 3000, 4000])
  })
})

describe('NODE_HISTORY_FS.readTailSync', () => {
  test('returns the bytes from a position to the end of the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-lens-history-'))
    try {
      const path = join(dir, 'tail.jsonl')
      writeFileSync(path, 'first\nsecond\n')
      expect(NODE_HISTORY_FS.readTailSync(path, 6).toString('utf8')).toBe('second\n')
      expect(NODE_HISTORY_FS.readTailSync(path, 13).length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
