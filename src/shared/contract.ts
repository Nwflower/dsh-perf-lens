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

/**
 * How hard the foreground sampler works, chosen with the panel's intensity
 * segment. Deliberately not the same thing as SampleMode: the user picks a
 * tier, and the mode the loop runs also depends on the background switch.
 */
export type SamplingIntensity =
  /** No foreground sampling. The loop is idle unless background sampling is on. */
  | 'paused'
  /** Duty cycle: one window, then a sleep. The default. */
  | 'low'
  /** Back-to-back windows while someone is watching; bounded by continuousMaxMs. */
  | 'high'

/**
 * The three control blocks the panel exposes, which together decide what the
 * sampling loop actually runs (see shared/sampling.ts). They are separate
 * because they are separate cost decisions: how hard to look, whether to keep a
 * cheap record while stopped, and whether to pay for heap sampling.
 */
export interface SamplingConfig {
  readonly intensity: SamplingIntensity
  /**
   * Keep a low-rate always-on record going while the intensity is 'paused'.
   * Inert at 'low' and 'high', where the foreground already samples.
   */
  readonly background: boolean
  /**
   * Sample heap allocation alongside CPU (the host's deep mode). Buys memory
   * attribution, per-plugin hot functions and async re-attribution, at the
   * highest cost of any option.
   */
  readonly memory: boolean
}

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
  /**
   * Live async timers (`Timeout` / `Immediate`) this plugin owns.
   *
   * NOT MEASURED, and deliberately absent rather than 0: the only mechanism is
   * an async_hooks hook, which costs +123% on promise-heavy work when kept on
   * (docs/evidence.md, evidence 15), and a window-scoped gauge would undercount
   * every resource created between windows. Consumers must render a gap, never
   * a zero. `GlobalMetricRow.activeResourceCounts` carries the process-wide
   * counts that are cheap to read.
   */
  readonly timers?: number
  /**
   * Event listeners this plugin has registered on the cordis event bus, counted
   * at window end. Exact, and read straight out of the event service's registry
   * with no patching; 0 means "none registered". Absent only when the registry
   * could not be read at all, which the panel must render as a gap.
   */
  readonly listeners?: number
  /** Live async handles (sockets, servers, pipes, TTYs, signals). Not measured: see `timers`. */
  readonly handles?: number
  /**
   * Bytes on disk owned by this plugin, exact via directory scan. Live only:
   * never persisted, and 0 until the first scan completes (the snapshot's
   * `diskFootprint` says whether one has).
   */
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
  /**
   * CPU milliseconds the profile could not explain: `processCpuMs` minus the
   * CPU the samples account for. The two come from different clocks, so a few
   * milliseconds of residue is normal (the platform's CPU clock quantizes at
   * ~15.6ms on Windows). A sustained large residue means CPU ran in a thread
   * the in-process sampler cannot see — a worker thread, or native code off the
   * main thread (docs/evidence.md, evidence 14). Never a plugin's cost: it is
   * published so the shares are not silently read as the whole story.
   */
  readonly unexplainedCpuMs?: number
  /**
   * Process-wide count of live async resources by type, at window end, from
   * `process.getActiveResourcesInfo()`. Cheap (no async_hooks hook) but has no
   * owner, which is why it is a process reading and not a plugin column: it
   * answers "the process is holding 412 timers and 38 sockets", and its trend
   * across windows is what makes a leak visible.
   */
  readonly activeResourceCounts?: Readonly<Record<string, number>>
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
  /**
   * The mode this window was collected under. Persisted, and the one field a
   * record replayed from disk is guaranteed to carry.
   */
  readonly mode: SampleMode
  /**
   * The control state in force, so the panel can render its controls from the
   * host instead of guessing from local state (a page reload used to show every
   * toggle off while the host was still sampling).
   *
   * Live snapshots always carry it; records replayed from disk do not (history
   * strips it, being derivable from `mode`), so consumers must fall back to
   * configFromMode(mode) rather than assume it is there.
   */
  readonly sampling?: SamplingConfig
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
  /**
   * The host's descendant process tree (item 1a of docs/roadmap-proposals.md).
   *
   * The host is one process, but an agent harness spends much of its time in
   * child processes — every shell command, terminal and language server runs
   * outside it. Without this reading the panel can honestly report an idle host
   * while the machine is saturated. Live only: never persisted (history strips
   * it), and absent until the first poll completes.
   *
   * HONESTY RULE: these bytes and this CPU are NOT attributed to any plugin.
   * The panel must present them as a separate total that explains the gap
   * between "the host is idle" and "the machine is busy", never as a plugin's
   * cost.
   */
  readonly processTree?: ProcessTreeReading
  /**
   * Per-plugin on-disk bytes: when the last scan ran, how much of the scan
   * resolved to an owner, and how much the scan walked. Live only, never
   * persisted — a plugin row's `diskFootprintBytes` is filled from the latest
   * scan, not from the window.
   */
  readonly diskFootprint?: DiskFootprintReading
}

/**
 * One reading of the host's descendant processes.
 *
 * `cpuCoreShare` is a rate over `intervalMs` (the gap between the two polls the
 * delta was computed from), not a per-window figure: the tree is polled far
 * less often than the host is sampled, because every poll costs a process
 * spawn on Windows and macOS.
 */
export interface ProcessTreeReading {
  /** Epoch milliseconds the reading was taken. */
  readonly at: number
  /** Descendants of the host process that were visible. */
  readonly count: number
  /** Resident bytes held by all descendants, summed. */
  readonly rssBytes: number
  /** Descendant CPU as a share of one core over `intervalMs`. */
  readonly cpuCoreShare: number
  /** Wall milliseconds the CPU delta covers. */
  readonly intervalMs: number
  /**
   * Share of descendants whose CPU delta could be computed (a process that
   * appeared in only one of the two polls has no delta). 0 when no previous
   * poll exists yet — the first reading reports RSS and count only.
   */
  readonly coverage: number
  /** Busiest descendants by CPU, biggest first, capped by the sampler. */
  readonly top: readonly ProcessTreeEntry[]
}

/** One descendant process in a tree reading. */
export interface ProcessTreeEntry {
  readonly pid: number
  readonly name: string
  readonly cpuCoreShare: number
  readonly rssBytes: number
}

/** What the last on-disk footprint scan covered. */
export interface DiskFootprintReading {
  /** Epoch milliseconds the scan completed. */
  readonly scannedAt: number
  /** Files and bytes the walk visited. */
  readonly scannedFiles: number
  readonly scannedBytes: number
  /** Bytes that resolved to a plugin or harness owner (the rest is unowned). */
  readonly ownedBytes: number
  /** True when the walk hit its budget and the figures are a lower bound. */
  readonly truncated: boolean
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

/**
 * Body of POST /api-perf/control. Every field is optional and independent, so
 * one request can change one block; omitted fields keep their current value.
 */
export interface PerfControlRequest {
  /** Foreground sampling tier. */
  readonly intensity?: SamplingIntensity
  /** Keep a low-rate record while the intensity is 'paused'. */
  readonly background?: boolean
  /** Sample heap allocation alongside CPU. */
  readonly memory?: boolean
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
 * One script entry of a Long Animation Frame, as the browser reported it.
 * Memory-only end to end: function names and script paths never reach the
 * JSONL history (the privacy red line), and the panel shows at most the
 * resolved plugin owner.
 */
export interface RawLoafScript {
  readonly url: string
  /** UTF-16 offset of the function's start inside its script; resolves combo segments. */
  readonly charPosition: number
  readonly functionName: string
  /** What scheduled the script (observer callback, timer, event listener, ...). */
  readonly invokerType: string
  readonly durationMs: number
  readonly forcedLayoutMs: number
}

/**
 * One window of Long Animation Frame script data, capped client-side: the top
 * scripts by duration are listed, the rest fold into otherCount/otherMs so the
 * window total stays honest. `supported` is false on engines without the API
 * (pre-Chromium-123), where the panel falls back to the correlation view.
 */
export interface LoafReport {
  readonly supported: boolean
  readonly scripts: readonly RawLoafScript[]
  readonly otherCount: number
  readonly otherMs: number
}

/**
 * One registration site of a wrapped scheduler, as the page reported it.
 *
 * Raw by construction: the client half never resolves an owner, it reports the
 * position its own stack gave it and the host resolves it. `calls`/`selfMs`
 * cover every wrapped callback registered from this position that ran in the
 * window, so a site measured at 8 ms across 40 calls is not the same animal as
 * one measured at 8 ms across 1 call; both figures ship.
 */
export interface RawScheduleSite {
  readonly url: string
  readonly line: number
  readonly column: number
  readonly calls: number
  readonly selfMs: number
  readonly maxMs: number
}

/**
 * One window of scheduler instrumentation, posted inside the vitals report.
 *
 * `active` is false when the probe is switched off (or the engine lacks the
 * registrars), and the panel then shows the LoAF view or the correlation
 * fallback rather than a zeroed table. `contract` is the probe's self-test:
 * 'mismatch' means the host's segment table disagreed with a position the probe
 * itself produced, and every row must then be withheld rather than shown wrong.
 */
export interface ScheduleReport {
  readonly active: boolean
  readonly sites: readonly RawScheduleSite[]
  /**
   * The registration site the probe's own self-test produced (one `setTimeout`
   * registered from perf-lens's own bundle at install time).
   *
   * The host resolves it and requires the owner to be `self`. That turns a
   * changed concatenation rule in the modules package into a visible mismatch
   * instead of silently wrong rows. Absent when the probe never installed.
   */
  readonly selfTest?: RawSourcePosition | undefined
  readonly windowMs: number
}

/** One raw script position, exactly as a captured stack reported it. */
export interface RawSourcePosition {
  readonly url: string
  readonly line: number
  readonly column: number
}

/**
 * Foreground health of the browser tab the panel runs in, measured with the
 * Long Tasks API, requestAnimationFrame gaps, Long Animation Frames when the
 * engine reports them, and the scheduler probe that exists for engines which
 * do not.
 *
 * HONESTY RULES. A browser long task cannot be attributed to a plugin bundle,
 * so longTaskCount/longTaskTotalMs are never presented as "plugin X caused the
 * jank". Long Animation Frame script time CAN be attributed (`loaf`, resolved
 * host-side into {@link JankView}) but is empty on the desktop shell's origin.
 * The scheduler probe's `schedule` figures are SAMPLED registrar time: they
 * count nested wrapped callbacks at every level, they cannot separate forced
 * layout from script, and they say "the page spent N ms inside callbacks
 * registered here", never "plugin X cost N ms". Every attributed view therefore
 * carries a coverage ratio.
 */
export interface ClientVitals {
  readonly longTaskCount: number
  readonly longTaskTotalMs: number
  /** 95th percentile gap between animation frames; ~16.7ms is a healthy 60fps. */
  readonly rafGapP95Ms: number
  /** Wall time the sample covers. */
  readonly windowMs: number
  readonly at: number
  readonly loaf?: LoafReport | undefined
  readonly schedule?: ScheduleReport | undefined
}

/** One owner's share of long-frame script time, resolved host-side. */
export interface JankRow {
  /** Owner key in the host vocabulary: plugin:<name>, harness:<name>, self, unresolved, other. */
  readonly owner: string
  readonly durationMs: number
  readonly forcedLayoutMs: number
  /** How many script entries folded into this row. */
  readonly count: number
}

/**
 * Per-owner attribution of one vitals report's long-frame script time.
 * Inexact by construction (combo segments can be unreadable, the client cap
 * folds small entries), so attributedShare is part of the data, not a footnote.
 */
export interface JankView {
  readonly rows: readonly JankRow[]
  /** Share of long-frame script milliseconds that resolved to an owner, 0..1; 1 when the window had none. */
  readonly attributedShare: number
}

/** One owner's scheduler cost, resolved host-side from a ScheduleReport. */
export interface ScheduleRow {
  /** Owner key in the host vocabulary: plugin:<name>, harness:<name>, self, unresolved. */
  readonly owner: string
  /** Total main-thread time of callbacks this owner registered. Sampled. */
  readonly scheduledMs: number
  readonly calls: number
  /** The longest single callback any of this owner's sites produced. */
  readonly maxMs: number
}

/**
 * Per-owner scheduler attribution of one vitals report: which registration
 * sites' callbacks ran, how often, and for how long in total.
 *
 * This is the registrar view — who put the work on the main thread — and it is
 * SAMPLED. It cannot name the statement inside a callback that burned the time,
 * because the only in-flight sampler is gated on the desktop origin; the
 * coverage ratio and the long-task figures beside it are the cross-check.
 */
export interface ScheduleView {
  readonly rows: readonly ScheduleRow[]
  /** Share of reported callback milliseconds that resolved to an owner, 0..1; 1 when the window was empty. */
  readonly attributedShare: number
  /**
   * The probe's self-test as the host resolved it: 'ok' when the probe's own
   * registration resolved to `self`, 'mismatch' when it resolved elsewhere
   * (the panel then shows no rows), 'untested' when the report carried none.
   */
  readonly contract: 'ok' | 'mismatch' | 'untested'
}

/** Response of GET/POST /api-perf/vitals. */
export interface VitalsView {
  readonly latest: ClientVitals | null
  readonly recent: readonly ClientVitals[]
  /** Resolved LoAF attribution of the latest report; null when it carried no loaf field. */
  readonly jank: JankView | null
  /** Resolved scheduler attribution of the latest report; null when it carried no schedule field. */
  readonly schedule: ScheduleView | null
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
  /**
   * Health of the descendant-process poller. `available` is false while no poll
   * has ever succeeded, which is the difference between "the host has no
   * children" and "the process table cannot be read here".
   */
  readonly processTree?: {
    readonly available: boolean
    readonly at: number
    readonly count: number
    readonly coverage: number
  }
  /**
   * Health of the on-disk footprint scan. `null` before the first scan finishes;
   * a `truncated` scan means every per-plugin byte figure is a lower bound.
   */
  readonly diskFootprint?: {
    readonly scannedAt: number
    readonly scannedFiles: number
    readonly ownedBytes: number
    readonly truncated: boolean
  } | null
  /**
   * Whether per-plugin listener counts are readable. False means the cordis
   * event registry was not exposed or not the expected shape, and the panel is
   * showing a gap rather than a number.
   */
  readonly listenersMeasured?: boolean
}
