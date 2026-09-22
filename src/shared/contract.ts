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

/** Aggregation window for /api-perf/stats. */
export type PerfRange = '1h' | '24h' | '7d'

/**
 * Per-plugin aggregate over a time range. avg / peak / p95 use the same
 * active-sample denominator as a single window's cpuShare, so a plugin's
 * average is comparable to the number the table shows live.
 */
export interface PluginStatsRow {
  readonly moduleName: string
  readonly avgCpuShare: number
  readonly peakCpuShare: number
  readonly p95CpuShare: number
  /** Sum of attributed CPU ms across sampled windows. Sampled, not wall time. */
  readonly cumulativeCpuMs: number
  /**
   * cumulativeCpuMs scaled by sampling coverage: an estimate of the true cost
   * had sampling been continuous. Always present it as an estimate.
   */
  readonly estimatedCpuMs: number
  /** Sampled window time / range wall time, 0..1. */
  readonly coverage: number
  /** Windows in which this plugin had a row. */
  readonly windows: number
}

/**
 * One hot function for a plugin. Frame-level data: in-memory only, collected
 * only in deep mode, and NEVER persisted (docs/design.md §7).
 */
export interface Hotspot {
  readonly functionName: string
  readonly url: string
  readonly lineNumber: number
  readonly selfMs: number
  readonly samples: number
}

/**
 * Foreground health of the browser tab the panel runs in, measured with the
 * Long Tasks API and requestAnimationFrame gaps. This is the only way to see
 * "is the UI stuttering"; the host CPU sampler cannot see the browser thread.
 *
 * HONESTY RULE: a browser long task cannot be attributed to a plugin bundle, so
 * this is never presented as "plugin X caused the jank". It is time-correlated
 * with host CPU at best, and the UI must say so.
 */
export interface ClientVitals {
  readonly longTaskCount: number
  readonly longTaskTotalMs: number
  /** 95th percentile gap between animation frames; ~16.7ms is a healthy 60fps. */
  readonly rafGapP95Ms: number
  /** Wall time the sample covers. */
  readonly windowMs: number
  readonly at: number
}

/** Response of GET/POST /api-perf/vitals. */
export interface VitalsView {
  readonly latest: ClientVitals | null
  readonly recent: readonly ClientVitals[]
}

/** Response of GET /api-perf/hotspots?plugin=... */
export interface HotspotResponse {
  readonly plugin: string
  /** null when no deep-mode window has collected any yet. */
  readonly hotspots: readonly Hotspot[] | null
}

/** Response of GET /api-perf/stats. */
export interface PerfStats {
  readonly range: PerfRange
  /** Epoch milliseconds the range starts at. */
  readonly since: number
  readonly windowCount: number
  /** Total sampled window time across the range. */
  readonly sampledWindowMs: number
  /** sampledWindowMs / range wall time, 0..1. */
  readonly coverage: number
  /** Sorted by cumulativeCpuMs descending. */
  readonly plugins: readonly PluginStatsRow[]
}

/** One plugin's CPU-share line over the trend's points. */
export interface PerfTrendSeries {
  readonly moduleName: string
  /** One averaged share per point, aligned with PerfTrend.times. */
  readonly shares: readonly number[]
}

/**
 * Compact time series for the trend chart.
 *
 * Deliberately NOT a list of full snapshots: a 24h range over 200+ plugins is
 * tens of megabytes of mostly-unused metric columns, and the chart needs only
 * window time plus one share per plugin. Points are bucket-averaged host-side,
 * so the payload stays bounded no matter how much history accumulated.
 */
export interface PerfTrend {
  readonly range: PerfRange
  /** Epoch milliseconds the range starts at. */
  readonly since: number
  /** Point timestamps, oldest first. */
  readonly times: readonly number[]
  /** Sorted by peak share descending, so the biggest consumers draw first. */
  readonly series: readonly PerfTrendSeries[]
  /** Windows folded into the points, before downsampling. */
  readonly windowCount: number
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
