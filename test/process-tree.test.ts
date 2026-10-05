// Descendant process tree: platform parsers, the tree walk, and the sampler's
// delta arithmetic (roadmap item 1a).

import { describe, expect, test } from 'vitest'
import {
  DEFAULT_PROCESS_TREE_OPTIONS,
  ProcessTreeSampler,
  descendantsOf,
  parseCpuTime,
  parsePsOutput,
  parseWindowsProcessJson,
  type ProcessSample,
} from '../src/host/process-tree'

describe('parseCpuTime', () => {
  test('accepts mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
    expect(parseCpuTime('01:30')).toBe(90_000)
    expect(parseCpuTime('02:01:30')).toBe(7_290_000)
    expect(parseCpuTime('1-00:00:10')).toBe(86_410_000)
  })

  test('accepts the fractional seconds macOS prints', () => {
    expect(parseCpuTime('00:01.50')).toBe(1_500)
  })

  test('rejects a field it cannot read rather than guessing zero', () => {
    expect(parseCpuTime('')).toBeNull()
    expect(parseCpuTime('n/a')).toBeNull()
    expect(parseCpuTime('1:2:3:4')).toBeNull()
  })
})

describe('parsePsOutput', () => {
  test('reads pid, ppid, rss in KB and cumulative CPU', () => {
    const samples = parsePsOutput([
      '    1     0   4096 00:00:12 /sbin/init',
      '  640     1  20480 00:01:30.50 node /app/server.js --port 3000',
      '',
    ].join('\n'))
    expect(samples).toEqual([
      { pid: 1, ppid: 0, rssBytes: 4096 * 1024, cpuMs: 12_000, name: '/sbin/init' },
      { pid: 640, ppid: 1, rssBytes: 20480 * 1024, cpuMs: 90_500, name: 'node /app/server.js --port 3000' },
    ])
  })

  test('skips a header or an unparseable row instead of emitting NaN', () => {
    expect(parsePsOutput('  PID  PPID    RSS     TIME COMMAND\nnot a row\n')).toEqual([])
  })
})

describe('parseWindowsProcessJson', () => {
  test('reads the CIM projection and converts 100ns units to ms', () => {
    const json = JSON.stringify([
      { ProcessId: 100, ParentProcessId: 1, Name: 'node.exe', UserModeTime: 10_000, KernelModeTime: 5_000, WorkingSetSize: 2048 },
    ])
    expect(parseWindowsProcessJson(json)).toEqual([
      { pid: 100, ppid: 1, name: 'node.exe', cpuMs: 1.5, rssBytes: 2048 },
    ])
  })

  test('accepts the single-row object shape ConvertTo-Json produces', () => {
    const json = JSON.stringify({ ProcessId: 7, ParentProcessId: 1, Name: 'pwsh.exe', UserModeTime: 0, KernelModeTime: 0, WorkingSetSize: 1 })
    expect(parseWindowsProcessJson(json).map(sample => sample.pid)).toEqual([7])
  })

  test('returns nothing for empty or malformed output', () => {
    expect(parseWindowsProcessJson('')).toEqual([])
    expect(parseWindowsProcessJson('Get-CimInstance : Access denied')).toEqual([])
  })
})

describe('descendantsOf', () => {
  const table: ProcessSample[] = [
    { pid: 10, ppid: 1, name: 'node', cpuMs: 100, rssBytes: 1 },
    { pid: 20, ppid: 10, name: 'git', cpuMs: 50, rssBytes: 1 },
    { pid: 30, ppid: 20, name: 'rg', cpuMs: 25, rssBytes: 1 },
    { pid: 40, ppid: 1, name: 'unrelated', cpuMs: 999, rssBytes: 1 },
    { pid: 50, ppid: 10, name: 'powershell', cpuMs: 5, rssBytes: 1 },
  ]

  test('walks the whole subtree and stops at the host boundary', () => {
    // 50 is the poller's own process-table reader, so it is excluded by design
    // (asserted on its own below); 40 belongs to a different parent entirely.
    expect(descendantsOf(table, 10).map(sample => sample.pid)).toEqual([20, 30])
  })

  test('excludes the poller own child, so the panel cannot see its own cost', () => {
    expect(descendantsOf(table, 10).some(sample => sample.pid === 50)).toBe(false)
  })

  test('is empty when the root has no children', () => {
    expect(descendantsOf(table, 999)).toEqual([])
  })
})

describe('ProcessTreeSampler', () => {
  function deps(now: () => number, table: () => readonly ProcessSample[]) {
    return { listProcesses: async () => table(), now, rootPid: 10 }
  }

  test('the first poll reports shape but no CPU rate, and says coverage is 0', async () => {
    const now = 1_000
    const sampler = new ProcessTreeSampler(deps(() => now, () => [
      { pid: 20, ppid: 10, name: 'git', cpuMs: 500, rssBytes: 2048 },
    ]))
    const reading = await sampler.poll()
    expect(reading?.count).toBe(1)
    expect(reading?.rssBytes).toBe(2048)
    // No baseline exists yet: 0% CPU would be a measurement of nothing.
    expect(reading?.cpuCoreShare).toBe(0)
    expect(reading?.coverage).toBe(0)
  })

  test('the second poll turns the CPU delta into a share of one core', async () => {
    let now = 1_000
    let cpu = 500
    const sampler = new ProcessTreeSampler(deps(() => now, () => [
      { pid: 20, ppid: 10, name: 'git', cpuMs: cpu, rssBytes: 2048 },
    ]))
    await sampler.poll()
    now = 3_000
    cpu = 3_500
    const reading = await sampler.poll()
    // 3000ms of CPU over a 2000ms gap is 1.5 cores.
    expect(reading?.intervalMs).toBe(2_000)
    expect(reading?.cpuCoreShare).toBeCloseTo(1.5, 6)
    expect(reading?.coverage).toBe(1)
  })

  test('a newly appeared process has no delta and lowers coverage', async () => {
    let now = 1_000
    let table: ProcessSample[] = [{ pid: 20, ppid: 10, name: 'git', cpuMs: 500, rssBytes: 1 }]
    const sampler = new ProcessTreeSampler(deps(() => now, () => table))
    await sampler.poll()
    now = 2_000
    table = [
      { pid: 20, ppid: 10, name: 'git', cpuMs: 600, rssBytes: 1 },
      { pid: 30, ppid: 10, name: 'rg', cpuMs: 900, rssBytes: 1 },
    ]
    const reading = await sampler.poll()
    expect(reading?.coverage).toBe(0.5)
    expect(reading?.cpuCoreShare).toBeCloseTo(0.1, 6)
  })

  test('an unreadable process table keeps the previous reading', async () => {
    const sampler = new ProcessTreeSampler({
      listProcesses: async () => { throw new Error('ps not found') },
      now: () => 0,
      rootPid: 10,
    })
    expect(await sampler.poll()).toBeNull()
    expect(sampler.reading).toBeNull()
  })

  test('names the busiest descendants first, capped by topLimit', async () => {
    let now = 1_000
    let table: ProcessSample[] = [
      { pid: 20, ppid: 10, name: 'a', cpuMs: 0, rssBytes: 1 },
      { pid: 30, ppid: 10, name: 'b', cpuMs: 0, rssBytes: 1 },
    ]
    const sampler = new ProcessTreeSampler(deps(() => now, () => table), { topLimit: 1 })
    await sampler.poll()
    now = 2_000
    table = [
      { pid: 20, ppid: 10, name: 'a', cpuMs: 100, rssBytes: 1 },
      { pid: 30, ppid: 10, name: 'b', cpuMs: 900, rssBytes: 1 },
    ]
    const reading = await sampler.poll()
    expect(reading?.top).toHaveLength(1)
    expect(reading?.top[0]?.pid).toBe(30)
  })

  test('the default cadence is a poll, not a sampling rate', () => {
    expect(DEFAULT_PROCESS_TREE_OPTIONS.intervalMs).toBeGreaterThanOrEqual(10_000)
  })
})