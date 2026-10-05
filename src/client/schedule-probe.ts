// Scheduler probe: per-plugin main-thread cost for the desktop origin, where
// Long Animation Frames report every long frame with an empty scripts array and
// Document Policy disables V8's in-page profiler.
//
// The probe wraps the seven registrars through which page code puts work on the
// main thread. A wrap captures ONE stack at registration time (1.15us at
// Error.stackTraceLimit=3) to learn which bundle called the scheduler, and the
// per-invocation path is two performance.now() clocks and a running total. It
// cannot see inside a callback — nothing on this origin can — so the figure it
// reports is "the page spent N ms inside callbacks registered at this position".
//
// Everything is transparent: same arity, name, `this`, return value and
// cancellation pairing, and disable() restores the exact original function
// objects. The probe is off until the panel's switch turns it on.

import type { RawScheduleSite, RawSourcePosition, ScheduleReport } from '../shared/contract'

/** Registrars the probe wraps. Each is a writable own property of the global. */
const REGISTRARS = [
  'requestAnimationFrame',
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
] as const

type RegistrarName = (typeof REGISTRARS)[number]

/** A plugins/-relative resource reference, with the position V8 reported. */
const PLUGIN_FRAME = /(?:dsh-app:\/\/app\/)?(plugins\/[^()\s]*?):(\d+):(\d+)/

/**
 * Function names this probe contributes between the capture and the position
 * that matters.
 *
 * Skipping by NAME rather than by frame count: the wrapper is a Proxy trap, the
 * self-test goes through a helper, and a count would have to be right for each
 * path. A name list stays right when a helper is added. These names are local
 * functions of one module, so a plugin cannot collide with them on the way in.
 */
const OWN_FRAME_NAMES = new Set(['captureSelfTest', 'captureTrap', 'apply', 'construct'])

/** The function name of one V8 frame line ("at name (url:line:col)" shape). */
function frameNameOf(line: string): string | undefined {
  const match = /^\s*at\s+(.*?)\s*(?:\(|$)/.exec(line)
  return match?.[1]
}

/**
 * True for a stack line that belongs to this probe rather than to a plugin.
 *
 * Two frame shapes reach this: a plain function ("at captureTrap (…)") and a
 * method ("at Object.construct (…)"), which V8 qualifies with the receiver.
 * Comparing the parsed name alone missed the qualified form and attributed the
 * construct trap's own frame to the probe, which is the defect evidence 18
 * records; the unqualified name is therefore also compared as the last dotted
 * segment.
 */
export function isOwnFrame(line: string): boolean {
  const name = frameNameOf(line)
  if (name === undefined) return false
  if (OWN_FRAME_NAMES.has(name)) return true
  const dot = name.lastIndexOf('.')
  return dot !== -1 && OWN_FRAME_NAMES.has(name.slice(dot + 1))
}

/** The one line of a stack the probe reads: the first plugins/ frame past its own. */
export function registrationSiteOf(stack: string | undefined): RawSourcePosition | undefined {
  if (stack === undefined) return undefined
  for (const frame of stack.split('\n')) {
    const trimmed = frame.trim()
    if (!trimmed.startsWith('at ')) continue
    if (isOwnFrame(trimmed)) continue
    const match = PLUGIN_FRAME.exec(trimmed)
    if (match === null) continue
    const [, url, lineText, columnText] = match
    if (url === undefined || lineText === undefined || columnText === undefined) return undefined
    const line = Number(lineText)
    const column = Number(columnText)
    if (!Number.isFinite(line) || !Number.isFinite(column)) return undefined
    return { url, line, column }
  }
  return undefined
}

/** One registration site's running totals. */
interface SiteTotals {
  readonly position: RawSourcePosition
  calls: number
  selfMs: number
  maxMs: number
}

/** What the panel reads to render its switch. */
export interface ScheduleProbeState {
  readonly active: boolean
  /** Sites seen since the last window fold. */
  readonly sites: number
  /** True once a window has been folded with the probe on. */
  readonly everFolded: boolean
}

export interface ScheduleProbe {
  readonly state: ScheduleProbeState
  /** Install the wrappers. Idempotent. */
  enable(): void
  /** Restore every original function object. Idempotent. */
  disable(): void
  /**
   * Fold and return the current window. Called once per vitals window; while
   * the probe is off it answers `{ active: false }` rather than zeroed rows.
   */
  takeReport(windowMs: number): ScheduleReport
}

/**
 * Storage key for the probe's on/off state.
 *
 * The probe must be on BEFORE the plugins register their callbacks, and the page
 * only lets the panel run after the plugins are up. Without persistence the only
 * way to reach the state the probe exists for would be: turn it on, then reload
 * by hand. Remembering the choice makes that reload automatic, and it is what
 * lets the entry install the probe at load time on the next page.
 */
const ENABLED_KEY = 'dsh-perf-lens.scheduleProbe'

/**
 * The stored preference, or false when storage is unavailable.
 *
 * Storage access is guarded because a page can run with it disabled; a probe
 * that cannot remember its state still works, it just does not auto-install.
 */
export function probeEnabledFromStorage(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  if (storage === undefined) return false
  try {
    return storage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

/** Record the preference; a storage failure must not break the switch. */
export function rememberProbeEnabled(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined,
  enabled: boolean,
): void {
  if (storage === undefined) return
  try {
    if (enabled) storage.setItem(ENABLED_KEY, '1')
    else storage.removeItem(ENABLED_KEY)
  } catch {
    // A page with storage disabled still gets a working probe for this load.
  }
}

/** The subset of the global object the probe touches; injectable for tests. */
export interface ProbeGlobal {
  readonly requestAnimationFrame?: unknown
  readonly setTimeout?: unknown
  readonly setInterval?: unknown
  readonly queueMicrotask?: unknown
  readonly MutationObserver?: unknown
  readonly ResizeObserver?: unknown
  readonly IntersectionObserver?: unknown
  readonly performance?: unknown
  readonly Error?: unknown
}

function nowOf(target: ProbeGlobal): () => number {
  const perf = target.performance as { now?: () => number } | undefined
  if (typeof perf?.now === 'function') return () => perf.now?.() ?? Date.now()
  return () => Date.now()
}

/**
 * Build one window of scheduler instrumentation.
 *
 * @param target - global object to wrap; defaults to the page's own globalThis.
 * @param now - injectable clock, for tests.
 */
export function createScheduleProbe(
  target: ProbeGlobal = globalThis as unknown as ProbeGlobal,
  now: () => number = nowOf(target),
): ScheduleProbe {
  const sites = new Map<string, SiteTotals>()
  let originals: Partial<Record<RegistrarName, unknown>> = {}
  let installed = false
  let everFolded = false
  let selfTest: RawSourcePosition | undefined

  const keyOf = (position: RawSourcePosition): string =>
    `${position.url}#${String(position.line)}#${String(position.column)}`

  const record = (position: RawSourcePosition | undefined, ms: number): void => {
    if (position === undefined) return
    const key = keyOf(position)
    const entry = sites.get(key) ?? { position, calls: 0, selfMs: 0, maxMs: 0 }
    entry.calls += 1
    entry.selfMs += ms
    if (ms > entry.maxMs) entry.maxMs = ms
    sites.set(key, entry)
  }

  /** The self-test capture, inlined at its call site for the same reason. */
  const captureSelfTest = (): RawSourcePosition | undefined =>
    registrationSiteOf(new (target.Error as new () => { stack?: string })().stack)

  /** The capture inside a Proxy trap; the trap's own frame is this function. */
  const captureTrap = (): RawSourcePosition | undefined =>
    registrationSiteOf(new (target.Error as new () => { stack?: string })().stack)

  const wrapCallback = (
    callback: unknown,
    site: RawSourcePosition | undefined,
    onDone: (ms: number, site: RawSourcePosition | undefined) => void,
  ): unknown => {
    if (typeof callback !== 'function') return callback
    const fn = callback as (...args: unknown[]) => unknown
    return function wrapped(this: unknown, ...args: unknown[]): unknown {
      const started = now()
      try {
        return fn.apply(this, args)
      } finally {
        onDone(now() - started, site)
      }
    }
  }

  /**
   * Wrap one registrar so its callback argument is instrumented.
   *
   * A Proxy, not a hand-written function: `length`, `name` and `prototype`
   * forward to the target automatically, `instanceof` keeps answering yes for
   * instances built through it, and a construct of an ES class is forwarded as
   * a construct rather than an `apply` (which throws on classes). A
   * hand-written function would have to rebuild each of those surfaces, and a
   * function declaration's non-configurable `prototype` makes the class case
   * impossible to get right.
   */
  const wrapRegistrar = (name: RegistrarName): void => {
    const original = target[name] as ((...args: unknown[]) => unknown) | undefined
    if (typeof original !== 'function') return
    const handler: ProxyHandler<typeof original> = {
      apply(inner, thisArg, args) {
        // Inlined on purpose: the first stack frame must be this trap, so the
        // position after the probe's own frames is the registering caller.
        const site = captureTrap()
        if (args.length > 0) args[0] = wrapCallback(args[0], site, (ms, at) => { record(at, ms) })
        return Reflect.apply(inner, thisArg, args)
      },
      construct(inner, args, newTarget) {
        const site = captureTrap()
        if (args.length > 0) args[0] = wrapCallback(args[0], site, (ms, at) => { record(at, ms) })
        // Constructing an observer is itself work charged to the constructing
        // site: an observer whose callback never fires still spent this time.
        const started = now()
        try {
          return Reflect.construct(inner, args, newTarget)
        } finally {
          record(site, now() - started)
        }
      },
    }
    ;(target as Record<string, unknown>)[name] = new Proxy(original, handler)
  }

  const enable = (): void => {
    if (installed) return
    installed = true
    for (const name of REGISTRARS) {
      originals[name] = (target as Record<string, unknown>)[name]
      wrapRegistrar(name)
    }
    // Self-test: one capture made from this bundle, which travels in every
    // report so the host can verify that its segment table still resolves a
    // position this probe produced back to `self`. It is the same capture path
    // the wrappers use, taken while the wrappers are already installed, so a
    // changed concatenation rule shows up as a mismatch rather than as silently
    // wrong rows. Nothing is scheduled: the position is the whole test.
    selfTest = captureSelfTest()
  }

  const disable = (): void => {
    if (!installed) return
    installed = false
    for (const name of REGISTRARS) {
      const original = originals[name]
      if (original !== undefined) (target as Record<string, unknown>)[name] = original
    }
    originals = {}
  }

  const takeReport = (windowMs: number): ScheduleReport => {
    if (!installed) return { active: false, sites: [], windowMs }
    const rows: RawScheduleSite[] = []
    for (const entry of sites.values()) {
      rows.push({
        url: entry.position.url,
        line: entry.position.line,
        column: entry.position.column,
        calls: entry.calls,
        selfMs: entry.selfMs,
        maxMs: entry.maxMs,
      })
    }
    sites.clear()
    everFolded = true
    // selfTest persists across windows: it is an install-time fact, not a window
    // measurement, so a host restarted under a new client build still checks it.
    return {
      active: true,
      sites: rows,
      ...(selfTest === undefined ? {} : { selfTest }),
      windowMs,
    }
  }

  return {
    get state(): ScheduleProbeState {
      return { active: installed, sites: sites.size, everFolded }
    },
    enable,
    disable,
    takeReport,
  }
}

/** The page's storage, when the page has one. */
export function pageStorageOf(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

/**
 * The page's one probe.
 *
 * The panel renders the switch and the entry starts the reporter, so both need
 * the same instance; the client half is one bundle, so a module-level singleton
 * is the whole wiring.
 *
 * A remembered "on" installs at first use of this module, which is page load
 * (the entry imports it). That is the only moment the wrappers can be in place
 * before the other plugins register, so it is what makes the probe reach its
 * intended state without a manual reload cycle.
 */
export const scheduleProbe: ScheduleProbe = createScheduleProbe()

/** Install at load when the previous page left the switch on. */
export function installRememberedProbe(): void {
  if (probeEnabledFromStorage(pageStorageOf())) scheduleProbe.enable()
}
