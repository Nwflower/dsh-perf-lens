// Retention semantics: a fixed-capacity ring for the live panel, one JSONL line
// per window on disk, and pruning that never grows without bound.

import { sep } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { PerfSnapshot } from '../src/shared/contract'
import {
  HistoryStore,
  historyFileName,
  parseSnapshot,
  RingBuffer,
  serializeSnapshot,
  type HistoryFs,
} from '../src/host/history'

function snapshot(at: number): PerfSnapshot {
  return {
    windowStartedAt: at,
    mode: 'duty',
    global: {
      rss: 1, heapUsed: 2, heapTotal: 3, external: 4, arrayBuffers: 5,
      eventLoopLagP99Ms: 6, gcPauseMs: 7, fsOpsTotal: 8, sampleWindowMs: 5000, sampleCount: 9, idleSamples: 0,
    },
    plugins: [],
    unattributedShare: 0,
    selfShare: 0,
  }
}

/** In-memory HistoryFs so retention is tested without touching the disk. */
class MemoryFs implements HistoryFs {
  readonly files = new Map<string, { content: string; mtimeMs: number }>()
  /** mtime stamped onto files created from now on. */
  nowMs = 0

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
    return { size: file.content.length, mtimeMs: file.mtimeMs }
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
