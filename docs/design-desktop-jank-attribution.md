# Desktop jank attribution: scheduler-instrumented per-plugin cost

**Status: implemented.** All eight plan milestones have landed, the four gates
(`pnpm test` / `typecheck` / `lint` / `build`) are green, and the live resolution
is recorded as [evidence 18](evidence.md#evidence-18-the-scheduler-probe-resolves-positions-on-the-desktop-window).
This document is the design, the implementation plan and the acceptance criteria
for one feature: naming the plugin that made the DeepSeek Harness *desktop*
window stutter.

## 1. Why this exists

The shipped LoAF attribution (docs/design-loaf-attribution.md) resolves
per-plugin browser jank on an ordinary `http` origin and reports `scripts: []`
on the desktop window's `dsh-app://app` origin. Section 17 of docs/evidence.md
measured 900 long frames there with an empty `scripts` array, no nested frame,
and a forced busy loop in both the page and an injected script — Chromium on
`dsh-app://` reports the frame but never its scripts. The desktop window is the
one the user actually works in, so the panel's per-plugin jank table is
permanently empty there and the fallback text ("correlation, not causation")
is the only thing it can honestly show.

This design replaces the platform's script attribution with the plugin's own:
inject instrumentation into the page at plugin apply time, observe which
scheduled callbacks the main thread spends its time in, and resolve the observed
script position back to the plugin through the segment tables the LoAF path
already builds. The figure it produces is "the page spent N ms inside callbacks
registered here", and the panel says exactly that.

## 2. Mechanism facts verified before this design (do not re-litigate)

Each fact was measured on this machine, on the live desktop window (DSH Desktop
0.1.7-rc.2, Electron 44, Chrome 152.0.7977.54) unless stated otherwise.

1. **LoAF is blind on `dsh-app://`.** `PerformanceObserver` delivers
   `long-animation-frame` entries (idle-buffer 200 frames observed,
   `blockingDuration` up to 352 ms) with `scripts.length === 0` for every frame,
   including frames produced by a forced 200 ms busy loop injected into the page
   and into a `blob:` script. `styleAndLayoutDuration` also comes back absent on
   this origin. The frame count and `blockingDuration` stay usable.
2. **In-page JS profiling is gated by Document Policy.** `new Profiler({...})`
   in the page throws `NotAllowedError: Failed to construct 'Profiler': JS
   profiling is disabled by Document Policy`; `console.profile()` is a no-op
   that throws nothing. The gate is the `Document-Policy` response header:
   measured against a local server, **no header → denied**,
   **`document-policy: js-profiling` → allowed** (a `Profiler` constructed and
   sampled), **`document-policy: js-profiling=?0` → denied**. The desktop shell's
   document response sets only `content-type` (apps/desktop/src/web-document.ts).
3. **The packaged desktop app exposes no debugger port.** No process has
   `--remote-debugging-port`; only apps/desktop/scripts/dev.ts passes one. The
   shell registers an invisible `{ role: 'toggleDevTools', accelerator: 'F12' }`
   menu item (apps/desktop/src/main.ts:919-922), so a human can open DevTools and
   record a profile; no external channel exists.
4. **The combo row is a byte-exact concatenation.** The modules package builds a
   batch as `source += prepareSource(resource).source + ';\n'` per part
   (packages/client/modules/src/index.ts:403) over parts read from each package's
   `exports["./client"]`; `prepareSource` strips a `sourceURL`/`sourceMappingURL`
   trailer and guarantees a trailing newline (same file, 305-314). The segment
   offset of part *k* is therefore `sum(len(prepareSource(part_i)) + 2)` for
   *i < k*, and the row's newline offsets turn a captured line/column into that
   offset.
5. **An `Error` carries the resolved position inside a combo.** In the desktop
   page, `new Error().stack` taken inside a `requestAnimationFrame` callback, a
   `MutationObserver` callback and a `setTimeout` callback reports
   `dsh-app://app/plugins/??<id,id,…>&rev=<rev>:LINE:COLUMN` — the position is
   already resolved against the whole concatenated row, which is exactly the
   input the segment table needs.
6. **Capturing that stack is cheap.** Measured in the live page over 20000
   iterations: `performance.now()` 0.11 µs, `new Error().stack` 1.70 µs,
   `new Error().stack` with `Error.stackTraceLimit = 2` 1.15 µs,
   "two clocks plus one stack" 2.25 µs. React schedules one rAF callback per
   frame, so registrar identification costs on the order of 0.01% of one core.
7. **The wrapping shape works, and its blind spot is known.** A wrapper of
   `requestAnimationFrame`, `setTimeout`, `setInterval`, `MutationObserver`,
   `ResizeObserver` and `IntersectionObserver`, installed after page load,
   attributed 1592 idle `dsh-claude-style` callbacks (47 ms total, 0.2 ms max)
   over 5 s, and 310 `@deepseek-ai/dsh-client-ui-deliverables` callbacks
   (394 ms total, 8.8 ms max) during a synthetic mutation storm; `longtask`
   entries in the storm stayed at 2-4 (max 60 ms) while the median animation
   frame gap rose from 6 ms to 34 ms. `MutationObserver` **construction** after
   the wrapper was installed was observed zero times, because every plugin had
   already constructed its observers before the wrapper existed. Installing at
   plugin apply time and wrapping the *registration* is therefore required;
   callbacks registered before the switch flips are missed.
8. **The registration site is the plugin in the motivating case.** The 1592 idle
   callbacks above carried a site inside `dsh-claude-style/client.js` itself, not
   inside React: the theme schedules its own animation-frame pass, so "who
   registered the callback that cost 12 ms" is already the actionable question.
9. **The body of a synchronous callback cannot be observed from the page.** Two
   candidate signals were checked and both fail on this origin: (a) entry-time
   stack capture reports the *invoker* (the wrapper and the browser's scheduler),
   never the callback's own definition, because the callback has not started
   when the wrapper is entered; (b) in-flight stack sampling needs V8's
   `Profiler`, which fact 2 gates. The design therefore stops at the registrar
   view and states it, rather than inventing an execution figure it cannot
   measure (see §3.4).

## 3. Design

### 3.1 Where the probe lives

The probe is part of **perf-lens's own client half**. The panel and the
scheduler wrappers live in the same page and the same bundle; wrapping a global
function from perf-lens's own scope wraps the object every other plugin reads.
No DevTools, no remote-debugging port, no Document-Policy change, no engine
patch, no other plugin's route: on the desktop window these are all unavailable
or forbidden, and none is needed.

Installation happens in `apply()`, at the earliest moment perf-lens controls.
The ordering that matters is "before other plugins register their callbacks";
the plan's live verification measures it. perf-lens declares
`dsh.client.inject: [locale, layout, sidebar]` and third-party rows follow the
framework rows in the composed graph, so perf-lens is expected to apply before
`dsh-claude-style`; if the live order disagrees, the fix is the manifest's
existing `dsh.client.immediately` flag, not a rewrite.

### 3.2 What is wrapped, and what is measured per callback

Wrapped registrars: `requestAnimationFrame`, `setTimeout`, `setInterval`,
`MutationObserver`, `ResizeObserver`, `IntersectionObserver`, and
`queueMicrotask`. Every wrapper is transparent: same arity, same `this`, same
return value, same `cancel*` pairing (handles are returned unchanged, so
`cancelAnimationFrame`/`clearTimeout` keep working), and an uninstall that
restores the exact original function object identity.

For each *registration* the wrapper records a **site**: one `new Error().stack`
with `Error.stackTraceLimit` temporarily set to 3, parsed for the first
`/plugins/` entry. The probe's own wrapper frame is always the innermost frame at
that moment, so it is skipped explicitly. A parse failure resolves to
`unresolved`, never to a guess. The original limit is restored before the call
returns.

For each *invocation* the wrapper records wall time only: a start clock, an end
clock, and an update of the site's `calls`, `selfMs` and `maxMs`. Sites are
folded by position, so a bundle that registers the same callback shape on every
frame produces one row, not thousands.

The wrapper does not call `preventDefault`, does not reorder, and does not
change the callback's arguments.

### 3.3 Identity, resolution and the self-test

The client never names a plugin. It reports raw
`{ url, line, column, calls, selfMs, maxMs }` sites; the host resolves.

The host resolves through the machinery that already exists for LoAF
(`src/host/loaf-map.ts`): `parsePluginUrl` classifies the URL;
`buildSegmentTable` walks the parts through `clientSourceOf` — the same reader
that resolves a plugin's `exports["./client"]` — accumulates segment offsets with
the `prepareSource` replica, and records the line starts of the concatenated
row. Resolution is `offset = lineStarts[line - 1] + column - 1`, then
`segmentOwnerOf(table, offset)`. A batch table is cached per exact URL, and the
rev lives in the URL, so a rebuilt bundle is a new key by construction. Single
and chunk URLs name their plugin directly and read no file.

**Self-test.** If the engine ever changes the concatenation rule, the offsets
would silently mis-attribute every row. The probe therefore verifies itself: at
install time it registers one `setTimeout` callback from perf-lens's own bundle
and keeps that registration site in every report as `selfTest`. The host
resolves it with the same code path it uses for every other site and requires
the owner to be `self`. Anything else — including an unresolved position —
reports `contract: 'mismatch'` and the panel withholds the table rather than
showing rows it believes are wrong. The probe also removes the marker callback
on disable, so the self-test has no behavioural residue.

### 3.4 What the probe can and cannot say

It can say: **which registration site's callbacks ran, how many times, for how
long in total, and the longest single one**. That is a real measurement of main
thread time charged to the bundle that called the scheduler.

It cannot say: which statement inside the callback ran, or how much of the time
was forced layout. Two signals that would have answered it were checked and
both fail on this origin:

- Capturing a stack *at wrapper entry* reports the invoker — the wrapper and the
  browser's scheduler — never the callback's own definition, because the
  callback has not started yet.
- Sampling the stack *while the callback runs* needs V8's `Profiler`, which
  Document Policy gates on `dsh-app://` (fact 2). A page cannot observe the
  inside of its own synchronous block from another thread.

The panel therefore states the registrar basis in its coverage line, and the
long-task and frame-gap figures beside it remain the cross-check.

Two consequences the panel must show rather than hide:

- A callback registered by plugin A may execute plugin B's code. The registrar
  view charges the scheduled time to A, which is the honest reading of "who put
  this work on the main thread", and the column is worded that way.
- Nested wrapped callbacks are charged at every level: a wrapped `setTimeout`
  that synchronously invokes a wrapped `requestAnimationFrame` callback counts
  toward both sites. The call count and the maximum single callback are shown
  beside the total so a nested stack is visible.

### 3.5 Contract additions (shared/contract.ts)

```ts
/** One registration site of a wrapped scheduler, as the page reported it. */
interface RawScheduleSite {
  readonly url: string
  readonly line: number
  readonly column: number
  /** Wrapped callbacks registered from this position that ran in the window. */
  readonly calls: number
  /** Total time those callbacks were on the main thread. */
  readonly selfMs: number
  /** The longest single one of them. */
  readonly maxMs: number
}

/** One raw script position, exactly as a captured stack reported it. */
interface RawSourcePosition {
  readonly url: string
  readonly line: number
  readonly column: number
}

/** One window of scheduler instrumentation, posted with the vitals report. */
interface ScheduleReport {
  /** False when the probe is off or the registrars were unavailable. */
  readonly active: boolean
  readonly sites: readonly RawScheduleSite[]
  /** The probe's own registration site: the host requires it to resolve to self. */
  readonly selfTest?: RawSourcePosition | undefined
  readonly windowMs: number
}
```

`ClientVitals` gains `readonly schedule?: ScheduleReport`, exactly as it gained
`loaf`. `VitalsView` gains a resolved view beside `jank`:

```ts
interface ScheduleRow {
  readonly owner: string
  /** Callbacks this owner registered, summed: the registrar figure. Sampled. */
  readonly scheduledMs: number
  readonly calls: number
  readonly maxMs: number
}

interface ScheduleView {
  readonly rows: readonly ScheduleRow[]
  /** Share of reported callback milliseconds that resolved to an owner, 0..1. */
  readonly attributedShare: number
  /** 'ok' when the self-test resolved to self; 'mismatch' withholds the table. */
  readonly contract: 'ok' | 'mismatch' | 'untested'
}
```

The honesty comment on `ClientVitals` is extended with §3.4's limits: the figure
is sampled registrar time, it counts nested wrapped callbacks at every level,
and it says "the page spent N ms inside callbacks registered here", never
"plugin X cost N ms".

### 3.6 Host resolution and storage

`LoafResolver` gains `resolvePosition(url, line, column)` beside
`resolve(url, charPosition)`; `src/host/vitals.ts` parses the new optional field
and resolves at `record()` time, so the ring never holds an unresolved report
(the LoAF path's existing rule). Persistence is unchanged: vitals are in-memory
only, and neither the schedule rows nor the raw sites reach the JSONL history —
they would carry script paths, which the privacy line forbids.

### 3.7 Panel

One new table under the existing jank card: **who is scheduling the main
thread**, per owner, with columns for scheduled milliseconds, call count and the
maximum single callback. A coverage line states the attributed share and the
registrar basis; when `contract !== 'ok'` the table is replaced by the contract
warning. All strings go into `src/client/i18n.ts` beside the existing jank
keys. The probe has a switch in the control bar next to the sampling controls,
and it is **off by default**: the panel that measures must itself be observable
as silent.

Turning it on triggers a reload. That is not a convenience: the plugins register
their callbacks during their own `apply()`, so a probe installed after page load
can never see them. The choice is written to `localStorage`, the entry installs
the probe from it at the start of `apply()` on the next load — before the other
plugins apply — and the switch then reports the running state.

### 3.8 Cost budget

| Item | Per event | Rate | Cost |
| --- | --- | --- | --- |
| Site capture on registration | 1.15 µs (limit 3) | ~60/s (React rAF) + timers | < 0.02% of a core |
| Two clocks per callback | 0.22 µs | every wrapped invocation | negligible at any page rate |
| Table fold per site | — | distinct sites only | bounded by plugin count |
| Report | — | one per 5 s window | a few hundred bytes |

The probe's own cost is visible in the host sampler's `self` row, so acceptance
requires that row to stay below the unattributed warning threshold while the
probe is on and the page is idle.

### 3.9 What this deliberately does not do

- **No stack capture on every invocation.** One capture per registration; the
  per-callback path is two `performance.now()` calls.
- **No statement-level or layout attribution.** Not available on this origin
  (fact 9); the panel states the registrar basis instead of implying more.
- **No long-task attribution.** Long Tasks still carry no owner; the schedule
  rows are the owner-bearing figure.
- **No cross-origin reach.** Registrations made by scripts outside the page
  (`dsh-app://shell`, Electron internals, extensions) report no resolvable
  position and fold into `unresolved`; the coverage ratio makes the size of that
  bucket visible.
- **No replacement for the LoAF path.** On `http` origins both run; the LoAF
  rows are exact script durations and the schedule rows are the registrar view.
  The panel labels which is which.

## 4. Implementation plan

One milestone per commit; each lands with its tests.

1. **Host line/column resolution.** Extend `SegmentTable` with line starts, add
   `segmentOwnerOfPosition` and `LoafResolver.resolvePosition`. Unit tests: a
   synthetic batch whose second part owns a known line/column; a chunk URL
   resolves by id; unknown URLs, a line past the end and a zero column resolve to
   undefined.
2. **Contract.** Add the types of §3.5, extend the honest comment, and extend
   `parseVitals` with the new optional field. Tests for each malformed shape.
3. **Client probe.** `src/client/schedule-probe.ts`: transparent wrappers, the
   site capture, the self-test, `enable`/`disable`, and a `state` object for the
   panel. Unit tests in jsdom for transparency (arity, `this`, return value,
   cancellation identity), for uninstall restoring identity, and for the report
   fold.
4. **Reporting.** Fold the probe's window into the existing vitals report;
   `ScheduleReport.active === false` when the probe is off.
5. **Host view.** Parse and resolve at record time; `VitalsView.schedule`.
6. **Panel.** The table, the coverage line, the contract warning, the switch,
   bilingual keys, and panel tests for each state.
7. **Live verification.** Reproduce the streaming scenario that motivated this
   work with the probe on, and write the observed numbers into docs/evidence.md
   as new evidence: per-owner scheduled milliseconds, attributed share, the
   `self` row, and the same window's frame-gap percentile. This is the
   acceptance evidence.
8. **Documentation.** docs/design.md (a new decision in §13 and the API row),
   CHANGELOG, README, and this document's status line.

## 5. Acceptance criteria

1. With the probe on, a rAF callback registered from a known bundle resolves to
   that bundle's owner key on the live desktop window (unit test plus one live
   run recorded in docs/evidence.md).
2. The self-test passes on the live window; a unit test that shifts one part's
   length makes it report `mismatch` and the view refuse to publish rows.
3. On a real page the panel shows owners beside `self`, together with an
   attributed share, and the `self` row stays inside the cost budget. Measured
   in ordinary use, without synthetic work: consecutive windows carried
   `harness:@deepseek-ai/dsh-api-session-controller` at 380 and 358 calls and
   `plugin:dsh-desktop-bridge`, with `self` at 0.3-0.5 ms and a 2.3% share
   (evidence 18c). A "dominant owner" comparison is not asserted, because which
   plugin dominates depends on what the page is doing and is not a contract.
4. The probe off means no wrapper: `requestAnimationFrame` and
   `MutationObserver` are the original objects, asserted in a unit test and by
   the state object.
5. Wrappers preserve arity, `this`, return value and cancellation pairing for
   every wrapped registrar (unit tests, one per registrar), and `instanceof`
   keeps working for the three observer classes.
6. Over a 60-second idle sample with the probe on, the `self` row stays below
   the unattributed warning threshold.
7. No schedule data appears in the JSONL history (grep the log).
8. The four gates pass: `pnpm test`, `pnpm typecheck`, `pnpm lint`,
   `pnpm build`.

## 6. Risks and open items

- **Registrar ordering.** If perf-lens's client applies after a plugin registers
  its callbacks, that plugin's registrations are invisible until reload. The plan
  measures the order; `dsh.client.immediately` is the manifest-level fix.
- **Missed observers.** An observer constructed before the probe installs keeps
  its unwrapped callback for the life of the page. The coverage line reports the
  unresolved share, and a reload with the probe on closes the gap. The switch
  therefore states the reload requirement when it flips.
- **Concatenation-rule drift.** Caught by the self-test, never silently wrong.
- **Double counting.** Nested wrapped callbacks charge every level; the panel
  reports the maximum single callback and the call count beside the total so a
  nested stack is visible rather than hidden.
- **A registrar is not a cost.** Plugin A can schedule plugin B's work. The
  panel words the column as "callbacks registered here" and the coverage line
  restates it; the LoAF table remains the exact-duration view where it is
  available.
- **The desktop shell's own frame.** Chromium reports long frames the page did
  not cause (the mandatory-update overlay, the caption). They carry no resolvable
  site and land in `unresolved`, which is the honest place for them.
