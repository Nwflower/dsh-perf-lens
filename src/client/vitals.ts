// Foreground jank measurement for the browser tab the panel runs in.
//
// Two cheap signals: the Long Tasks API (main-thread stalls >= 50ms) and the
// gap between animation frames (a 60fps frame is ~16.7ms). Neither can name the
// plugin that caused a stall, so the panel correlates them with host CPU in
// time and labels the result "correlation, not causation".

import type { ClientVitals, RawLoafScript, ScheduleReport } from '../shared/contract'
import { percentile } from '../shared/math'
import { aggregateLoaf, startLoafObserver } from './loaf'

/**
 * A frame gap this large means the tab was hidden (rAF is paused in hidden
 * tabs), not that one frame took seconds. Keeping it would poison the p95
 * with a visibility artifact, so such gaps are dropped.
 */
export const MAX_FRAME_GAP_MS = 2000

/** Fold one window of raw observations into a report. Pure and testable. */
export function summarizeVitals(
  longTaskDurations: readonly number[],
  rafGaps: readonly number[],
  windowMs: number,
  at: number,
): ClientVitals {
  const sorted = rafGaps.filter(gap => gap <= MAX_FRAME_GAP_MS).sort((a, b) => a - b)
  return {
    longTaskCount: longTaskDurations.length,
    longTaskTotalMs: longTaskDurations.reduce((total, duration) => total + duration, 0),
    rafGapP95Ms: percentile(sorted, 0.95),
    windowMs,
    at,
  }
}

export interface VitalsReporterOptions {
  readonly windowMs: number
  readonly onReport: (report: ClientVitals) => void
  /** Injectable clock for tests. */
  readonly now?: () => number
  /**
   * Scheduler probe window for the report.
   *
   * A supplier, not a fixed value: the panel's switch installs and removes the
   * wrappers at any moment, and whether a report carries scheduler data must
   * reflect the probe's state at flush time. Returns undefined when the probe is
   * off, which leaves `schedule` absent from the report.
   */
  readonly schedule?: (windowMs: number) => ScheduleReport | undefined
}

/**
 * Start observing long tasks and frame gaps, reporting one aggregate per
 * window. Returns a stop function; every browser API is feature-detected so a
 * non-DOM environment degrades to zeroed reports instead of throwing.
 */
export function startVitalsReporter(options: VitalsReporterOptions): () => void {
  const now = options.now ?? ((): number => Date.now())
  const longTasks: number[] = []
  const rafGaps: number[] = []
  let observer: PerformanceObserver | null = null
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration)
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      observer = null
    }
  }
  let rafId = 0
  let lastFrame = now()
  const tick = (): void => {
    const current = now()
    rafGaps.push(current - lastFrame)
    lastFrame = current
    if (typeof requestAnimationFrame !== 'undefined') rafId = requestAnimationFrame(tick)
  }
  if (typeof requestAnimationFrame !== 'undefined') rafId = requestAnimationFrame(tick)
  // LoAF script entries accumulate across the window and fold at flush time;
  // an unsupported engine reports supported:false and the panel keeps the
  // correlation fallback instead of a table of zeros.
  const loafScripts: RawLoafScript[] = []
  const loaf = startLoafObserver(scripts => { loafScripts.push(...scripts) })
  const timer = setInterval(() => {
    const schedule = options.schedule?.(options.windowMs)
    options.onReport({
      ...summarizeVitals(longTasks.splice(0), rafGaps.splice(0), options.windowMs, now()),
      loaf: aggregateLoaf(loafScripts.splice(0), loaf.supported),
      ...(schedule === undefined ? {} : { schedule }),
    })
  }, options.windowMs)
  return () => {
    clearInterval(timer)
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafId)
    observer?.disconnect()
    loaf.stop()
  }
}
