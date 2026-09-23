# Overnight plan: trends and ranking, hot functions, foreground jank

> Status: **done** (all tracks shipped; see the changelog in the README). Kept as the record of what
> was agreed.
> Originally the working brief for the development agent: tracks are loosely coupled and ran in
> order 0 → 1 → 2 → 3 → 4, with the four gates (test / typecheck / build / lint) after each.
> The hard constraints still applied: the six in AGENTS.md plus design.md §7's privacy line
> (frame-level data is never persisted).

## Track 0 · Baseline fixes (first, < 0.5h)

1. **Commit a baseline.** src/, test/ and all implementation code were untracked, and git held a
   single docs commit. Commit the green state (82 tests) before starting, or the night's work has no
   rollback point.
2. Change the README header to "implemented"; update the test count 57 → 82; record this round's
   sampling changes (250µs default / idle backoff / per-node memoization).
3. De-duplicate the client file table in design.md §1.2 (api.ts and others were listed twice).

## Track 1 · Ranking and trends (core, ~3–4h)

The request: capture cumulative share continuously in the background, chart share over time (hiding
0% plugins), and compare peak with average.

### host

- Per-plugin cumulative `cumulativeCpuMs` (core-time within sampled windows) plus sampling coverage
  (sampled time / wall time; must be shown under the duty cycle, and any extrapolation labelled
  "estimate").
- New `GET /api-perf/stats?range=1h|24h|7d`: aggregate the ring buffer + JSONL into per-plugin
  `{ avgCpuShare, peakCpuShare, p95CpuShare, cumulativeCpuMs, coverage }`.
- Matching types in contract.ts. **Peak and average use the active-sample `cpuShare`**, the same
  denominator as everywhere else.
- The aggregation must be pure functions with no ctx (like attribute.ts), with unit tests locking
  avg/peak/p95 for known input sequences and the edges of the hide rule (below).

### client

- A trend chart component: hand-drawn SVG (like the sparkline; no chart library), share over time,
  sourced from `/api-perf/history`. **Hide rule: a plugin whose max(cpuShare) over the range is under
  0.5% is not drawn** (configurable; the default covers "hide 0%").
- A ranking block: sorted by cumulativeCpuMs, each row with avg / p95 / peak.
- Polling follows the existing pollMs logic.

(As built, the chart reads a dedicated compact `/api-perf/trend` instead of `/history`; see
design.md §13 #12.)

## Track 2 · Hot functions, top N (~2h)

- host: **only while deep mode is on**, aggregate per-plugin self time by `functionName + url:line`,
  top N; new `GET /api-perf/plugin/:name/hotspots` (built as `/api-perf/hotspots?plugin=`).
- **Hard constraint: memory only, deep mode only, never in the JSONL** (frame-level data, design.md
  §7). Add a privacy regression test asserting the persisted output contains no functionName.
- Source maps: best-effort only when the package has `*.map` files, falling back to the raw
  `functionName (file:line)`. dsh-context ships only client.js.map and host-side packages have
  almost none, so **map coverage is not an acceptance criterion** and the UI promises nothing.
- client: a plugin row expands to its top hot functions (by self time).

## Track 3 · Foreground jank bridge (~2h)

The request: compare foreground time (animation-killing jank) with background cost, in numbers.

- client: `PerformanceObserver('longtask')` plus rAF frame-gap sampling (panel page only, negligible
  cost), aggregated per window into `{ longTaskCount, longTaskTotalMs, rafGapP95Ms }`.
- New `POST /api-perf/vitals`: report that aggregate with a timestamp; the host keeps a ring buffer.
- The panel shows the current window's jank figures next to the host's top 3 plugins by cpuShare at
  the time.
- **The UI must say "correlation ≠ causation"**: the browser cannot attribute a long task to a
  plugin bundle, only line it up in time. This joins the coverage badge's existing warning system.
- Unit tests: pure functions for the vitals aggregate and the correlation.

## Track 4 · Wrap-up gates (~0.5h)

- All four gates green (pnpm test / typecheck / build / lint).
- Update the README status; add three rows to design.md's decisions table: what the ranking counts
  (sampled cumulative with coverage), the vitals correlation label, and hot functions never persisted.
- One git commit per track, commit messages in English.

## Explicitly out of scope (to keep this round on track)

Always-on 100µs deep sampling; child-process sampling; worker-thread attribution; moving attribution
into a worker thread; async-root aggregation; report export (JSON / Markdown); the card dashboard
redesign (wait until Track 1's data exists); activity-triggered sampling (CPU gating).
