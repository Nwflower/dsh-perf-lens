/**
 * Sampling and presentation defaults; every value is overridable by plugin
 * config.
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
  coverageWarnThreshold: 0.6,
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
  /** Vitals reporting window; roughly one sampling window. */
  vitalsWindowMs: 5_000,
  /** Foreground reports kept for the mini-trend. */
  vitalsRetain: 60,
  /** A single long task at or above this counts as jank. */
  jankLongTaskMs: 50,
  /** A p95 frame gap at or above this counts as jank. */
  jankRafGapMs: 50,
} as const

/** Sidebar entry id and the matching main-panel key (dsh 0.1.7 plugin-panel pattern). */
export const PANEL_ID = 'perf-lens'

/** Range key to milliseconds; the client uses it to bound its history query. */
export const RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
} as const
