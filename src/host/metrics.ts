// Process-wide metrics for one sampling window. Every field here is exact:
// memory and heap figures come from the runtime, fs operation counts from
// process.resourceUsage, and lag/GC from perf_hooks instrumentation.

import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'
import process from 'node:process'
import type { GlobalMetricRow } from '../shared/contract'

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>

/** Injectable runtime readings so the collector can be unit-tested. */
export interface MetricsDeps {
  readonly memoryUsage: () => Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'heapTotal' | 'external' | 'arrayBuffers'>
  readonly resourceUsage: () => { readonly fsRead: number; readonly fsWrite: number }
  /** process.cpuUsage: cumulative microseconds of user + system CPU. */
  readonly cpuUsage: () => { readonly user: number; readonly system: number }
  readonly now: () => number
}

function defaultDeps(): MetricsDeps {
  return {
    memoryUsage: () => process.memoryUsage(),
    resourceUsage: () => process.resourceUsage(),
    cpuUsage: () => process.cpuUsage(),
    now: () => Date.now(),
  }
}

/** Collects global metrics across a sampling window. */
export class GlobalMetrics {
  readonly #deps: MetricsDeps
  #histogram: IntervalHistogram | undefined
  #observer: PerformanceObserver | undefined
  #gcPauseMs = 0
  #fsOpsBaseline: number | undefined
  /** process.cpuUsage at window start, for the process-level CPU delta. */
  #cpuBaseline: { user: number; system: number } | undefined

  constructor(deps: MetricsDeps = defaultDeps()) {
    this.#deps = deps
  }

  /** Start lag/GC instrumentation and record the fs baseline. */
  start(): void {
    if (this.#histogram === undefined) {
      this.#histogram = monitorEventLoopDelay({ resolution: 10 })
      this.#histogram.enable()
    }
    if (this.#observer === undefined) {
      this.#observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) this.#gcPauseMs += entry.duration
      })
      this.#observer.observe({ entryTypes: ['gc'] })
    }
    const usage = this.#deps.resourceUsage()
    this.#fsOpsBaseline = usage.fsRead + usage.fsWrite
    this.#cpuBaseline = this.#deps.cpuUsage()
  }

  /** Stop instrumentation. Safe to call twice. */
  stop(): void {
    this.#histogram?.disable()
    this.#histogram = undefined
    this.#observer?.disconnect()
    this.#observer = undefined
    this.#fsOpsBaseline = undefined
    this.#cpuBaseline = undefined
    this.#gcPauseMs = 0
  }

  /** Read the window's metrics. Drains the GC accumulator and fs delta. */
  read(sampleWindowMs: number, sampleCount: number): GlobalMetricRow {
    const memory = this.#deps.memoryUsage()
    const usage = this.#deps.resourceUsage()
    const fsTotal = usage.fsRead + usage.fsWrite
    const fsOpsTotal = this.#fsOpsBaseline === undefined ? fsTotal : Math.max(0, fsTotal - this.#fsOpsBaseline)
    this.#fsOpsBaseline = fsTotal
    // Process-level CPU for the window: the reading that separates "the host
    // was genuinely idle" from "the sampler missed the work". The platform
    // clock may quantize it (probe 08: ~15.6ms on Windows), so consumers only
    // use it when it is comfortably above that granularity.
    const cpuNow = this.#deps.cpuUsage()
    const baseline = this.#cpuBaseline
    const processCpuMs = baseline === undefined
      ? 0
      : Math.max(0, ((cpuNow.user - baseline.user) + (cpuNow.system - baseline.system)) / 1000)
    this.#cpuBaseline = cpuNow
    const lagP99Ns = this.#histogram?.percentile(99) ?? 0
    const gcPauseMs = this.#gcPauseMs
    this.#gcPauseMs = 0
    return {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      eventLoopLagP99Ms: Number.isFinite(lagP99Ns) ? lagP99Ns / 1e6 : 0,
      gcPauseMs,
      processCpuMs,
      fsOpsTotal,
      sampleWindowMs,
      sampleCount,
      // The metrics collector cannot see the profile; the lens overwrites this
      // with the idle sample count it derived from the CPU profile.
      idleSamples: 0,
    }
  }
}
