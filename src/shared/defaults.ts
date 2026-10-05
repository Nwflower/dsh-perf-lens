import type { SamplingConfig } from './contract'

/**
 * Sampling and presentation defaults. There is no plugin configuration yet
 * (docs/design.md §9), so these are the values in effect.
 *
 * cpuIntervalUs is 250us because a measured CPU-cost sweep found 250us costs the
 * same as 1000us (15ms vs 16ms CPU per idle 3s window) while giving 4x the time
 * resolution, and 100us costs 8x (126ms) — the cliff is between 250us and 100us.
 */
export const DEFAULTS = {
  cpuIntervalUs: 250,
  windowMs: 5000,
  idleMs: 30_000,
  continuousWindowMs: 2000,
  continuousMaxMs: 600_000,
  /**
   * Background profile: coarser interval, short window, long sleep. The point
   * is a cheap always-on record of "which plugin has been costing", not
   * per-frame resolution.
   */
  backgroundCpuIntervalUs: 1000,
  backgroundWindowMs: 2000,
  backgroundIdleMs: 120_000,
  /**
   * Sentinel probe: a short, coarse CPU window whose only job is to answer "is
   * anything running right now". The duty profile runs one after each slice of
   * a long idle backoff, so a spike does not stay invisible for up to two
   * minutes. Probe 16 measured the cost driver: 10ms yields ~100 samples/s
   * against ~1866/s at 250us, so a 1s probe is ~5% of one fine window and can
   * run every 10s without changing the budget.
   */
  sentinelEnabled: true,
  sentinelCpuIntervalUs: 10_000,
  sentinelWindowMs: 1_000,
  sentinelIdleMs: 10_000,
  /** A probe at or above this idle share is "nothing happening"; below it, wake. */
  sentinelActivityThreshold: 0.8,
  /**
   * Deep-mode async-context CPU re-attribution (mechanism C). Off the hot path:
   * it only takes effect while deep mode is on, and it is the single most
   * expensive option (async_hooks before/after plus a stack per async init).
   */
  asyncAttribution: true,
  /**
   * Below this range coverage the scoreboard hides its whole-range estimate.
   * At 5% the estimate is already a 20x scale-up of the sampled windows; a
   * background-profile range (2s per ~2min, ~1.6%) would be 60x, which says
   * more about the multiplier than about the plugin.
   */
  estimateMinCoverage: 0.05,
  unattributedWarnThreshold: 0.15,
  /**
   * On an idle host nearly every sample is idle, so windows cost CPU and add no
   * information. When a window is mostly idle, stretch the duty-cycle sleep by
   * this factor (capped) instead of keeping the sampling cadence.
   */
  idleBackoffFactor: 4,
  idleBackoffMaxMs: 120_000,
  /** A window at or above this idle share counts as idle for the backoff. */
  idleBackoffThreshold: 0.8,
  /**
   * A plugin whose peak cpuShare over a trend range is below this never enters
   * the trend chart. It is the "hide 0% plugins" rule, kept just above zero so
   * a plugin that merely idled is not drawn as a flat line.
   */
  trendHideThreshold: 0.005,
  /**
   * Ceiling on trend-chart points. A chart a few hundred pixels wide cannot show
   * more, and every extra point costs payload and render time.
   */
  trendMaxPoints: 120,
  /** Vitals reporting window; roughly one sampling window. */
  vitalsWindowMs: 5_000,
  /** Foreground reports kept for the mini-trend. */
  vitalsRetain: 60,
  /** A single long task at or above this counts as jank. */
  jankLongTaskMs: 50,
  /** A p95 frame gap at or above this counts as jank. */
  jankRafGapMs: 50,
  /**
   * A wrapped callback at or above this keeps one sample of where its body is
   * defined (the desktop jank probe). Below it only the running totals are kept,
   * which is what bounds the probe's memory and its report size.
   */
  hotCallbackMs: 2,
  /** Slow-callback samples kept per window; the rest fold into slowDropped. */
  slowSamplesPerWindow: 50,
  /**
   * How many harness internal packages the snapshot keeps beside the folded
   * `harness` row. Enough to name the real consumers, few enough that the log
   * and the table do not grow with the package count.
   */
  harnessBreakdownLimit: 10,
} as const

/**
 * Panel default: low-rate intermittent sampling, no background record, CPU
 * only. The cheapest useful setting, because this plugin is installed to watch
 * a host rather than to load one.
 */
export const DEFAULT_SAMPLING: SamplingConfig = { intensity: 'low', background: false, memory: false }

/** Sidebar entry id and the matching main-panel key (dsh 0.1.7 plugin-panel pattern). */
export const PANEL_ID = 'perf-lens'

/** Range key to milliseconds; the client uses it to bound its history query. */
export const RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
} as const
