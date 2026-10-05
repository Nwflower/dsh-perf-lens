// The host's descendant processes (roadmap item 1a).
//
// One Node process carries every host plugin, but an agent harness spends much
// of its life outside that process: `dsh-subprocess-local` runs every shell
// command, terminal session and language server through `node:child_process`
// and `node-pty`. A panel that reports the host alone therefore reports an idle
// host while the machine is saturated — the most confidently wrong answer it
// can give.
//
// This sampler does NOT attribute those processes to plugins (that is item 1b).
// It publishes them as one separate, clearly labelled total, which is what turns
// "the host is idle, nothing is wrong" into "the host is idle, its 7 descendants
// are using 3.4 cores".
//
// Cost: a process-table read, which is a spawn on Windows and macOS and a /proc
// walk on Linux. Measured on the reference Windows host: ~330ms of WALL time per
// call, almost none of it the host's own CPU (the host awaits a child), plus a
// PowerShell startup's worth of CPU on the machine. That is far more expensive
// than a sampling window, so it runs on its own low-rate timer rather than per
// window, the CPU figure it reports is a rate over the gap between two polls, and
// the routes refresh it on demand while a panel is open.
//
// The consequence of polling is a MISS WINDOW: a child that starts and exits
// between two polls is never seen. Long-lived descendants (language servers, dev
// servers, terminals, builds) are the ones this reading is for; `git`, `rg` and
// one-shot shell commands mostly are not, and the UI must not imply otherwise.

import { execFile } from 'node:child_process'
import process from 'node:process'
import type { ProcessTreeEntry, ProcessTreeReading } from '../shared/contract'

/** One process-table row, reduced to what the tree reading needs. */
export interface ProcessSample {
  readonly pid: number
  readonly ppid: number
  readonly name: string
  /** Cumulative user + system CPU milliseconds since the process started. */
  readonly cpuMs: number
  /** Resident set size in bytes. */
  readonly rssBytes: number
}

/** Process names that are our own poller, so the reading cannot see itself. */
const POLLER_NAME = /^(?:powershell|pwsh|ps|cmd)(?:\.exe)?$/i

/**
 * Parse `ps -axo pid=,ppid=,rss=,time=,comm=` output.
 *
 * `time` is cumulative CPU in `[[dd-]hh:]mm:ss[.ss]`, and `comm` is last so a
 * command name containing spaces cannot shift the numeric columns.
 */
export function parsePsOutput(stdout: string): ProcessSample[] {
  const samples: ProcessSample[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*\S)\s*$/.exec(line)
    if (match === null) continue
    const [, pid, ppid, rssKb, cpuField, name] = match
    if (pid === undefined || ppid === undefined || rssKb === undefined || cpuField === undefined || name === undefined) continue
    const cpuMs = parseCpuTime(cpuField)
    if (cpuMs === null) continue
    samples.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rssBytes: Number(rssKb) * 1024,
      cpuMs,
      name,
    })
  }
  return samples
}

/** `[[dd-]hh:]mm:ss[.ss]` to milliseconds; null when the field is unparseable. */
export function parseCpuTime(value: string): number | null {
  const days = /^(\d+)-(.+)$/.exec(value)
  const dayCount = days === null ? 0 : Number(days[1])
  const rest = days === null ? value : days[2] ?? ''
  const parts = rest.split(':')
  if (parts.length < 2 || parts.length > 3) return null
  const seconds = Number(parts.at(-1))
  const minutes = Number(parts.at(-2))
  const hours = parts.length === 3 ? Number(parts[0]) : 0
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours)) return null
  return (dayCount * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000
}

/**
 * Parse the JSON of the Windows `Get-CimInstance Win32_Process` projection.
 *
 * `UserModeTime` and `KernelModeTime` are in 100ns units; `ConvertTo-Json`
 * collapses a single-row result to an object, so both shapes are accepted.
 */
export function parseWindowsProcessJson(stdout: string): ProcessSample[] {
  const trimmed = stdout.trim()
  if (trimmed === '') return []
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return []
  }
  const rows = Array.isArray(value) ? value : [value]
  const samples: ProcessSample[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as Record<string, unknown>
    const pid = Number(record.ProcessId)
    if (!Number.isFinite(pid)) continue
    const user = Number(record.UserModeTime ?? 0)
    const kernel = Number(record.KernelModeTime ?? 0)
    samples.push({
      pid,
      ppid: Number(record.ParentProcessId ?? 0),
      name: typeof record.Name === 'string' ? record.Name : '',
      cpuMs: (Number.isFinite(user) ? user : 0) / 10_000 + (Number.isFinite(kernel) ? kernel : 0) / 10_000,
      rssBytes: Number(record.WorkingSetSize ?? 0) || 0,
    })
  }
  return samples
}

/**
 * Every transitive descendant of `rootPid`, excluding the poller's own child.
 *
 * The poller spawns a process-table reader, which is a real child of the host;
 * counting it would make the panel's own cost look like a plugin's workload.
 */
export function descendantsOf(processes: readonly ProcessSample[], rootPid: number): ProcessSample[] {
  const childrenOf = new Map<number, ProcessSample[]>()
  for (const sample of processes) {
    const list = childrenOf.get(sample.ppid)
    if (list === undefined) childrenOf.set(sample.ppid, [sample])
    else list.push(sample)
  }
  const out: ProcessSample[] = []
  const queue = [...(childrenOf.get(rootPid) ?? [])]
  while (queue.length > 0) {
    const current = queue.shift() as ProcessSample
    // Our own poller: a direct child whose name is a process-table reader.
    if (current.ppid === rootPid && POLLER_NAME.test(current.name)) continue
    out.push(current)
    const children = childrenOf.get(current.pid)
    if (children !== undefined) queue.push(...children)
  }
  return out
}

/** Injectable process-table source, so the sampler is testable without spawning. */
export interface ProcessTreeDeps {
  readonly listProcesses: () => Promise<readonly ProcessSample[]>
  readonly now: () => number
  /** The host pid whose descendants are read. */
  readonly rootPid: number
}

export interface ProcessTreeOptions {
  /** Gap between polls. A process spawn per poll, so this is not a sampling rate. */
  readonly intervalMs?: number
  /** How many descendants the reading names individually. */
  readonly topLimit?: number
}

export const DEFAULT_PROCESS_TREE_OPTIONS: Required<ProcessTreeOptions> = {
  intervalMs: 30_000,
  topLimit: 5,
}

const COMMAND_TIMEOUT_MS = 5_000
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024

function runCommand(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER, windowsHide: true }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * The platform's process-table reader.
 *
 * Windows has no `/proc`, so the only built-in source with parent ids is CIM;
 * everything else goes through `ps`, which POSIX guarantees and which reports
 * cumulative CPU directly.
 */
export function defaultListProcesses(): Promise<readonly ProcessSample[]> {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,UserModeTime,KernelModeTime,WorkingSetSize | ConvertTo-Json -Compress'
    return runCommand('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]).then(parseWindowsProcessJson)
  }
  return runCommand('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm=']).then(parsePsOutput)
}

/**
 * Polls the descendant tree on a low-rate timer and keeps the last reading.
 *
 * The reading is a rate over the gap between two polls, so the first poll can
 * only report the tree's shape (count and RSS): there is nothing to subtract
 * yet, and reporting 0% CPU would be a lie of the same kind the sampler exists
 * to avoid. `coverage` says how much of the CPU delta was computable.
 */
export class ProcessTreeSampler {
  readonly #deps: ProcessTreeDeps
  readonly #options: Required<ProcessTreeOptions>
  #reading: ProcessTreeReading | null = null
  #previous = new Map<number, number>()
  #previousAt = 0
  /** Whether a previous poll exists. A timestamp alone cannot say: 0 is a valid clock reading. */
  #hasPrevious = false
  #timer: ReturnType<typeof setInterval> | undefined
  #inFlight = false

  constructor(deps: ProcessTreeDeps, options: ProcessTreeOptions = {}) {
    this.#deps = deps
    this.#options = { ...DEFAULT_PROCESS_TREE_OPTIONS, ...options }
  }

  get reading(): ProcessTreeReading | null { return this.#reading }

  /** Start polling. The first poll runs immediately so the board is never blank. */
  start(): void {
    if (this.#timer !== undefined) return
    void this.poll()
    this.#timer = setInterval(() => { void this.poll() }, this.#options.intervalMs)
    // Never hold the host open for a monitor.
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  /**
   * One poll. Returns the reading, or null when the process table was
   * unreadable — a monitor that cannot see the tree must say nothing rather
   * than report an empty tree as zero cost.
   */
  async poll(): Promise<ProcessTreeReading | null> {
    if (this.#inFlight) return this.#reading
    this.#inFlight = true
    try {
      const all = await this.#deps.listProcesses()
      const descendants = descendantsOf(all, this.#deps.rootPid)
      const at = this.#deps.now()
      const intervalMs = this.#hasPrevious ? at - this.#previousAt : 0
      let rssBytes = 0
      let cpuMs = 0
      let withDelta = 0
      const perProcess: ProcessTreeEntry[] = []
      for (const sample of descendants) {
        rssBytes += sample.rssBytes
        const previousCpu = this.#previous.get(sample.pid)
        // A pid seen for the first time has no baseline; a pid that was reused
        // can produce a negative delta. Neither may be counted as cost.
        const delta = previousCpu === undefined ? 0 : Math.max(0, sample.cpuMs - previousCpu)
        if (previousCpu !== undefined) withDelta += 1
        cpuMs += delta
        perProcess.push({
          pid: sample.pid,
          name: sample.name,
          cpuCoreShare: intervalMs > 0 ? delta / intervalMs : 0,
          rssBytes: sample.rssBytes,
        })
      }
      const next = new Map<number, number>()
      for (const sample of descendants) next.set(sample.pid, sample.cpuMs)
      this.#previous = next
      this.#previousAt = at
      this.#hasPrevious = true
      perProcess.sort((left, right) => right.cpuCoreShare - left.cpuCoreShare || right.rssBytes - left.rssBytes)
      const reading: ProcessTreeReading = {
        at,
        count: descendants.length,
        rssBytes,
        cpuCoreShare: intervalMs > 0 ? cpuMs / intervalMs : 0,
        intervalMs,
        coverage: descendants.length === 0 ? 1 : withDelta / descendants.length,
        top: perProcess.slice(0, this.#options.topLimit),
      }
      this.#reading = reading
      return reading
    } catch {
      // Unreadable process table (missing ps, denied CIM, timeout): keep the
      // previous reading rather than publishing a zero-cost tree.
      return this.#reading
    } finally {
      this.#inFlight = false
    }
  }
}