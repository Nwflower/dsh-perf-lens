// Long Animation Frames collection (LoAF, Chromium 123+).
//
// The Long Tasks API says a frame was long but never which script made it
// so. LoAF reports per frame a scripts array naming the script URL,
// the invoker kind, the execution window and the script-forced style/layout
// cost — the browser-side attribution decision #9 was revised for.
// Everything is feature-detected: an engine without the API reports
// supported: false and the panel keeps the correlation fallback.

import type { LoafReport, RawLoafScript } from '../shared/contract'

/** Cap on listed scripts per window; the rest fold into otherCount/otherMs. */
export const LOAF_SCRIPT_CAP = 50

/** Structural minimum of a LoAF script entry; TS lib types lag the spec. */
export interface LoafScriptEntryLike {
  readonly sourceURL?: string | undefined
  readonly sourceCharPosition?: number | undefined
  readonly sourceFunctionName?: string | undefined
  readonly invokerType?: string | undefined
  readonly duration?: number | undefined
  readonly forcedStyleAndLayoutDuration?: number | undefined
}

/** Structural minimum of a long-animation-frame entry. */
export interface LoafFrameLike {
  readonly scripts?: readonly LoafScriptEntryLike[] | undefined
}

/** Normalize one browser script entry to the contract shape. */
export function scriptOfEntry(entry: LoafScriptEntryLike): RawLoafScript {
  return {
    url: entry.sourceURL ?? '',
    // -1 resolves no combo segment: absent stays unresolved, never guessed.
    charPosition: entry.sourceCharPosition ?? -1,
    functionName: entry.sourceFunctionName ?? '',
    invokerType: entry.invokerType ?? '',
    durationMs: entry.duration ?? 0,
    forcedLayoutMs: entry.forcedStyleAndLayoutDuration ?? 0,
  }
}

/**
 * Fold one window of raw script entries into the capped report: the top
 * `cap` scripts by duration are listed, the rest fold into otherCount and
 * otherMs, so the window total survives the cap honestly.
 */
export function aggregateLoaf(
  entries: readonly RawLoafScript[],
  supported: boolean,
  cap = LOAF_SCRIPT_CAP,
): LoafReport {
  if (entries.length <= cap) return { supported, scripts: entries, otherCount: 0, otherMs: 0 }
  const sorted = [...entries].sort((a, b) => b.durationMs - a.durationMs)
  let otherMs = 0
  for (let index = cap; index < sorted.length; index += 1) otherMs += sorted[index]?.durationMs ?? 0
  return { supported, scripts: sorted.slice(0, cap), otherCount: sorted.length - cap, otherMs }
}

export interface LoafObserverHandle {
  /** False on engines without long-animation-frame (pre-Chromium-123). */
  readonly supported: boolean
  readonly stop: () => void
}

/**
 * Observe long animation frames, delivering each frame's script entries.
 * buffered:true catches frames just before the observer attached. The frame
 * threshold lives in the browser (50ms); a quiet page costs nothing.
 */
export function startLoafObserver(
  onScripts: (scripts: readonly RawLoafScript[]) => void,
): LoafObserverHandle {
  if (typeof PerformanceObserver === 'undefined') return { supported: false, stop: () => {} }
  if (!(PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame') ?? false)) {
    return { supported: false, stop: () => {} }
  }
  const observer = new PerformanceObserver((list) => {
    const scripts: RawLoafScript[] = []
    for (const frame of list.getEntries() as unknown as readonly LoafFrameLike[]) {
      for (const entry of frame.scripts ?? []) scripts.push(scriptOfEntry(entry))
    }
    if (scripts.length > 0) onScripts(scripts)
  })
  observer.observe({ type: 'long-animation-frame', buffered: true })
  return { supported: true, stop: () => { observer.disconnect() } }
}
