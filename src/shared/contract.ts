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

/** Sampling mode of the lens, chosen with the panel's controls. */
export type SampleMode =
  /** Duty cycle: sample a window, sleep, repeat. The default. */
  | 'duty'
  /** Back-to-back windows while someone is watching; ends after continuousMaxMs. */
  | 'continuous'
  /**
   * Low-rate always-on capture: a coarser sampling interval and a long sleep,
   * so the host keeps a history even while nobody is looking at the board.
   */
  | 'background'
  /** Explicitly paused by the user. */
  | 'paused'

/** Per-plugin metric row for one sampling window. */
export interface PluginMetricRow {
  /** Module name from ctx.loader.entries(). */
  readonly moduleName: string
  readonly entryId: string
  /** cordis fiber phase at collection time. */
  readonly fiberPhase: string
  /** Share of the window's active (non-idle) samples, 0..1. Sampled. */
  readonly cpuShare: number
  /** Attributed CPU milliseconds over the window. Sampled. */
  readonly cpuSelfMs: number
  /** Live sampled heap bytes attributed to this plugin. Sampled. */
  readonly liveHeapBytes: number
  readonly allocBytesPerSec: number
  /** File operations, exact via async_hooks. */
  readonly fsReadOps: number
  readonly fsWriteOps: number
  /**
   * File bytes, partial: only I/O mediated by the harness ctx.fs service.
   * Planned; always 0 until the ctx.fs wrapper exists.
   */
  readonly fsReadBytes: number
  readonly fsWriteBytes: number
  /** Coverage 0..1 for the partial byte metrics above (0 until they exist). */
  readonly coverage: number
  /** Planned: timer, listener and handle counts; always 0 for now. */
  readonly timers: number
  readonly listeners: number
  readonly handles: number
  /** Bytes on disk owned by this plugin, exact via directory scan. Planned; always 0. */
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
  /**
   * CPU actually consumed by the whole process during the window, in
   * milliseconds (user + system, from process.cpuUsage). Exact apart from the
   * platform clock's granularity (Windows ticks at ~15.6ms), and the one
   * process-level reading that says whether a quiet window was quiet.
   *
   * Optional because records written before this field existed lack it, and
   * because a platform may not expose it; consumers must treat absence as
   * "unknown", never as zero.
   */
  readonly processCpuMs?: number
  /** Total CPU-profile samples in the window, including idle. */
  readonly sampleCount: number
  /**
   * Milliseconds of CPU one sample stands for in this window: the interval the
   * profiler actually achieved, which can be far above the configured one
   * (Windows floors it at ~0.54ms; docs/evidence.md, evidence 13). Every
   * cpuSelfMs in the window is its sample count times this.
   */
  readonly sampleIntervalMs: number
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
  /** The lens's own share of the window, 0..1. Never charged to a plugin; the `self` row carries it. */
  readonly selfShare: number
  /**
   * Top harness internal packages by sampled CPU, biggest first.
   *
   * The fold into one `harness` row is deliberate — 200+ internal packages
   * would bury the real consumers — but it also deletes the only actionable
   * ranking: which internal package costs what (docs/design-overnight-analyzer
   * §6.5). The host keeps the top few here so the panel can show them under the
   * harness line without re-flooding the table.
   *
   * Live snapshots only: history strips it (see history.serializeSnapshot), so
   * the JSONL log keeps one folded row per window instead of ten. Snapshots
   * replayed from disk therefore have it absent.
   */
  readonly harnessBreakdown?: readonly HarnessBreakdownRow[]
}

/**
 * One harness internal package, measured on the same basis as a plugin row.
 * Deliberately a lighter shape than PluginMetricRow: a harness package has no
 * loader entry, fiber phase, coverage or allocation figure to report.
 */
export interface HarnessBreakdownRow {
  /** Raw owner key, e.g. `harness:@deepseek-ai/dsh-client-hmr`. */
  readonly moduleName: string
  readonly cpuShare: number
  readonly cpuSelfMs: number
  readonly liveHeapBytes: number
  readonly fsReadOps: number
  readonly fsWriteOps: number
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
 * Per-plugin aggregate over a time range.
 *
 * Shares use the same active-sample denominator as a single window's cpuShare.
 * `avgCpuShare` divides by every window in range (a window with no row counts
 * as zero, because persisted windows drop all-zero rows); `peakCpuShare` and
 * `p95CpuShare` are over the windows the plugin was actually active in.
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
  /** Windows in which this plugin had a row (i.e. showed any activity). */
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

/** One plugin's line over the trend's points, in both cost bases. */
export interface PerfTrendSeries {
  readonly moduleName: string
  /**
   * One averaged share per point, aligned with PerfTrend.times. Share of
   * ACTIVE samples: on an idle host this is inflated
   * (docs/design-overnight-analyzer.md §6.5), so it is the
   * shape view, not the cost view.
   */
  readonly shares: readonly number[]
  /**
   * The same points as sampled CPU milliseconds per second of sampled wall
   * time — the comparable, actionable figure. Present on every series so the
   * chart can switch bases without a second request.
   */
  readonly cpuMsPerSec: readonly number[]
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
  /**
   * Deep mode only: samples that fell inside a plugin-owned async execution
   * window, and how many of those were moved off harness/runtime back to the
   * plugin (mechanism C). Both are 0 when async attribution did not run.
   */
  readonly asyncWindowedSamples?: number
  readonly asyncReattributedSamples?: number
}
