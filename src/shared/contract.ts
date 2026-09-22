// Metric contract: the single source of truth shared by the host collector and
// the browser panel. Every non-exact metric carries the fact that it is an
// estimate, because a value that looks precise but is not is worse than a gap.

/** How a metric was obtained. Presentation must keep these visually distinct. */
export type MetricQuality =
  /** Directly counted; safe to show as an exact value. */
  | 'exact'
  /** Statistical estimate from sampled call trees; always shown with window and sample count. */
  | 'sampled'
  /** Measured over a subset of call sites; must be shown with a coverage ratio. */
  | 'partial'

/** Sampling mode of the lens, driven by panel visibility and user controls. */
export type SampleMode =
  /** Duty cycle: sample a window, sleep, repeat. The default. */
  | 'duty'
  /** Back-to-back windows while the panel is open; bounded by continuousMaxMs. */
  | 'continuous'
  /** Explicitly paused by the user. */
  | 'paused'

/** Per-plugin metric row for one sampling window. */
export interface PluginMetricRow {
  /** Module name from ctx.loader.entries(). */
  readonly moduleName: string
  readonly entryId: string
  /** cordis fiber phase at collection time. */
  readonly fiberPhase: string
  /** Share of process CPU over the window, 0..1. Sampled. */
  readonly cpuShare: number
  /** Attributed CPU milliseconds over the window. Sampled. */
  readonly cpuSelfMs: number
  /** Live sampled heap bytes attributed to this plugin. Sampled. */
  readonly liveHeapBytes: number
  readonly allocBytesPerSec: number
  /** File operations, exact via async_hooks. */
  readonly fsReadOps: number
  readonly fsWriteOps: number
  /** File bytes, partial: only I/O mediated by the harness ctx.fs service. */
  readonly fsReadBytes: number
  readonly fsWriteBytes: number
  /** Coverage 0..1 for the partial byte metrics above. */
  readonly coverage: number
  readonly timers: number
  readonly listeners: number
  readonly handles: number
  /** Bytes on disk owned by this plugin, exact via directory scan. */
  readonly diskFootprintBytes: number
}

/** Process-wide metrics for one sampling window. */
export interface GlobalMetricRow {
  readonly rss: number
  readonly heapUsed: number
  readonly heapTotal: number
  readonly external: number
  readonly arrayBuffers: number
  readonly eventLoopLagP99Ms: number
  readonly gcPauseMs: number
  /** Process-level fs operation count, exact (process.resourceUsage). */
  readonly fsOpsTotal: number
  readonly sampleWindowMs: number
  /** Total CPU-profile samples in the window, including idle. */
  readonly sampleCount: number
  /**
   * Samples taken while the thread was idle. Per-plugin cpuShare is computed
   * over `sampleCount - idleSamples` so an idle host does not dilute every
   * plugin's share toward zero.
   */
  readonly idleSamples: number
}

/** One window snapshot served to the panel and appended to the history log. */
export interface PerfSnapshot {
  readonly windowStartedAt: number
  readonly mode: SampleMode
  readonly global: GlobalMetricRow
  readonly plugins: readonly PluginMetricRow[]
  /** Share of samples that resolved to no owner, 0..1. Surfaced, never hidden. */
  readonly unattributedShare: number
  /** Own overhead of the lens over the window, 0..1. Excluded from plugin rows. */
  readonly selfShare: number
}

/** Body of POST /api-perf/control. */
export interface PerfControlRequest {
  readonly action?: 'pause' | 'resume'
  readonly mode?: SampleMode
  /** Deep mode toggles heap sampling on top of CPU sampling. */
  readonly deep?: boolean
}

/** Body of GET /api-perf/history. */
export interface PerfHistoryQuery {
  readonly plugin?: string
  /** Epoch milliseconds; defaults to the retention horizon. */
  readonly since?: number
}

/** One resolved owner rule, for troubleshooting attribution. */
export interface OwnerRuleView {
  readonly kind: string
  readonly name: string
  readonly prefix: string
}

/**
 * Attribution health facts. Exists because the duty loop must swallow window
 * errors to stay alive, which would otherwise make a broken profiler look
 * exactly like an idle one.
 */
export interface PerfDiagnostics {
  /** Last window error swallowed by the loop, if any. */
  readonly lastError: string | null
  readonly windowStartedAt: number
  readonly sampleCount: number
  /** Owner keys present in the last CPU tally. */
  readonly ownerKeys: readonly string[]
  /** Path-prefix rules the owner index resolved. */
  readonly ownerRules: readonly OwnerRuleView[]
}
