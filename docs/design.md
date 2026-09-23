# Architecture

> Status: **final** (reviewed 2026-09; the four key decisions — tech stack, history retention,
> dashboard form and panel location — are settled). Items marked *planned* below are designed but not
> built yet.
> Feasibility: [feasibility.md](feasibility.md). Measurements: [evidence.md](evidence.md).
> Division of labour: feasibility.md answers "can it be done", this document answers "how".

---

## 1. Tech stack

The two reference repositories each represent a proven route. After comparing them:

| Aspect | Plain JS ESM (the dsh-chat-import route) | **TypeScript + tsdown (the dsh-context route) ✔ chosen** |
| --- | --- | --- |
| Host source | Hand-written lib/*.mjs shipped as is, no build | src/host/*.ts → tsdown → lib/index.js |
| Client output | A home-grown fragment-joining script (contract by convention) | tsdown, one entry → self-contained lib/client.js |
| Type safety | None | **Yes** — the sampling state machine, profile-tree walk and metric contract are the complex parts |
| Unit tests | node --test | **vitest** (fake timers, coverage; proven in dsh-context) |
| Lint | eslint | **oxlint** |

Why: the core of this plugin is **a sampling state machine, a call-tree walk and a metric contract
shared by both halves** — the most type-heavy code in the whole workspace. Tables, badges and charts
are far easier to maintain as TSX than as string assembly. One tsdown config builds both the host and
the client output, replacing a fragile fragment-joining contract.

### 1.1 Dependencies

**Runtime dependencies: none.** Only Node built-ins (node:inspector / node:async_hooks / node:v8 /
node:perf_hooks) and services injected by cordis. No npm runtime package: a tool that measures other
plugins' cost has to carry none of its own.

**peerDependencies:** @deepseek-ai/cordis, @deepseek-ai/dsh, @deepseek-ai/dsh-client-locale,
@deepseek-ai/dsh-client-ui-layout, @deepseek-ai/dsh-client-ui-sidebar, react (≥ 18).

**devDependencies:** typescript (following dsh-context's version line), tsdown, vitest,
@vitest/coverage-v8, oxlint, react / react-dom / @types/react / @types/react-dom, @types/node,
jsdom and @testing-library for the client tests.

**Client build externals** (mirroring the harness's platform module table; they come from the
injected `require` and are never inlined): react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives.

**No tailwind, no chart library.** The panel is one stylesheet (`src/client/styles/panel.css`, built
on the harness theme's `--dsw-alias-*` tokens) that tsdown inlines into the client bundle, and every
chart is hand-drawn SVG. A whole CSS or charting toolchain is not worth it for one panel.

### 1.2 Layout

```
src/
  host/                    // host process (Node)
    index.ts               // composition root: name / inject / apply
    ctx.ts                 // structural HostCtx types (loader / webServer)
    plugin-index.ts        // ctx.loader.entries() -> path prefix -> owner map
    attribute.ts           // ancestor-walk attribution (pure, no ctx)
    async-attribution.ts   // deep mode: async-context re-attribution (mechanism C)
    sampler.ts             // inspector state machine, paired start/stop
    io-tracker.ts          // async_hooks counters + read/write split
    metrics.ts             // process metrics (heap / lag / GC / resourceUsage)
    history.ts             // ring buffer + JSONL persistence + incremental read cache
    lens.ts                // duty / continuous / background orchestration + snapshots
    routes.ts              // /api-perf/* routes (late webServer injection)
    stats.ts               // range aggregation (avg / peak / p95 / cumulative / trend)
    hotspots.ts            // hot-function Top-N (in memory only, never persisted)
    vitals.ts              // browser foreground-vitals ring (in memory only)
    footprint.ts           // planned: directory byte scan (path -> owner)
    self-monitor.ts        // planned: measure and report the lens's own overhead
  client/                  // browser
    index.tsx              // entry: sidebar.panellist + main registration
    ctx.ts                 // structural ClientCtx types (slots / locale / layout)
    sidebar-entry.tsx      // sidebar.panellist icon row (dsh >= 0.1.7 panel pattern)
    panel.tsx              // main-panel dashboard
    api.ts                 // /api-perf/* client
    format.ts              // byte / percent / duration / ms-per-second formatting
    global-bar.tsx         // process overview tiles + coverage and resolution chips
    composition.tsx        // process-level CPU and heap composition bars
    plugin-cards.tsx       // top-consumer cards (current / average / peak)
    trend-chart.tsx        // multi-plugin CPU trend, hides sub-threshold plugins
    scoreboard.tsx         // cumulative-cost ranking (avg / p95 / peak / estimate)
    metrics-table.tsx      // grouped, sortable per-plugin table with folds
    control-bar.tsx        // pause / continuous / background / deep controls
    coverage-badge.tsx     // partial-metric marker
    sparkline.tsx          // inline SVG sparkline
    vitals.ts              // long-task + rAF foreground reporter
    error-boundary.tsx     // keeps a render error from blanking the host page
    palette.ts             // chart series colours
    i18n.ts                // zh / en dictionaries
    styles/panel.css       // the panel's one stylesheet
    plugin-detail.tsx      // planned: per-plugin detail view
  shared/
    contract.ts            // metric contract types (single source of truth)
    defaults.ts            // window lengths / duty cycle / thresholds
    grouping.ts            // owner groups and the "no cost this window" rule
    math.ts                // shared percentile helper
test/                      // host specs in node, test/client/ specs in jsdom
```

`attribute.ts`, `stats.ts` and `shared/` stay **pure functions with no ctx dependency** and are the
main unit-test targets. The other host modules are thin shells around ctx (the same split as
dsh-chat-import's "pure lib/convert/*, thin shells elsewhere").

---

## 2. Layers

```
+-- Client (browser) --------------------------------------------------+
|  lib/client.js                                                       |
|    sidebar-entry -> sidebar.panellist (left nav row, like Plugins)   |
|    panel         -> main (keyed panel, dashboard)                    |
|    polls /api-perf/* (interval follows the active sample window)     |
+----------------------------------------------------------------------+
                    ^ HTTP (webServer.register, late injection)
+-- Host (single Node process) ---------------------------------------+
|  dsh-perf-lens (cordis plugin, inject = [loader])                    |
|                                                                      |
|  PluginIndex       ctx.loader.entries() -> module path -> plugin     |
|  Sampler           inspector state machine: CPU / heap, duty cycle   |
|  Attributor        ancestor stack walk -> per-plugin attribution     |
|  AsyncRecorder     deep mode: async windows -> re-attribution        |
|  IoTracker         async_hooks counts + process-level calibration    |
|  Metrics           process metrics                                   |
|  HistoryStore      ring buffer + JSONL persistence (on by default)   |
|  FootprintScanner  planned: directory byte scan (path -> owner)      |
|  SelfMonitor       planned: own-overhead measurement                 |
+----------------------------------------------------------------------+
```

Host entry conventions (same shape as dsh-chat-import, verified):

- `inject = ['loader']`. **webServer is not in `inject`**: it is an optional, late-mounted host
  service, and a hard dependency would stop the plugin from activating in a headless profile. Routes
  are registered inside `apply` through `ctx.inject(['webServer'], ...)`.
- Route API: `ws.register({ kind: 'exact' | 'prefix', path, handler })` returns a disposer, which is
  handed to a cordis effect.
- Unloading the plugin **stops sampling unconditionally** (cordis effect disposer). Nothing keeps
  sampling in the background.

Client entry conventions (aligned with the plugin panel dsh 0.1.7 introduced,
@deepseek-ai/dsh-client-ui-plugin-manager, whose lib/client.js registration code and sidebar/layout
slot contracts were checked):

- **Location = a left-nav entry plus a main-column panel** (the same shape as the built-in Plugins
  panel; needs dsh ≥ 0.1.7-alpha.1):
  1. `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist',
     id: PANEL_ID, order: 10, label: () => t('title'), locale: NS }, SidebarEntry))`
     — `sidebar.panellist` is a `kind: 'list'` slot of global panel icons. Its `id` matches the main
     panel's `key`; the sidebar owns the button and resolves the label, and `SidebarEntry` receives
     `{ size, active }`.
  2. `ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS },
     PerfPanel))`
     — `main` is a `kind: 'keyed'` slot. A key other than the reserved `conversation` is not bound to
     a session.
- Navigation: `ctx.layout.selectPanel(PANEL_ID)` (`ctx.layout` is the ILayout service exposing
  `activePanelId` / `selectPanel`).
- The client module exports `inject = ['slots', 'locale']`. `package.json` declares
  `dsh.client.inject = ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar']` (which pins the load order of the packages providing those
  services) and `dsh.client.platform = 'web'`.
- **Bilingual (zh / en).** `i18n.ts` exports `DICT_ZH` and `DICT_EN`. The English dictionary is typed
  as a full `Record<MessageKey, string>`, so a missing or extra key is a compile error; the harness
  also rejects an unbalanced pair at registration. `apply()` registers the dictionaries through
  `ctx.effect` (stop/HMR disposes them; a duplicate namespace/locale registration would throw) and
  pushes the active locale into `setActiveLocale` via `ctx.locale.subscribe`. `t()` reads the current
  dictionary at call time and the panel re-renders on a switch, so **changing language needs no
  reload**. The module defaults to Chinese (for tests and a host without a locale service); unknown
  locales fall back to English, like the harness's `FALLBACK_LOCALE`. Messages with parameters use
  `{name}` placeholders (for example `moreLines`) so components never assemble sentences in a fixed
  word order.
- **Copy rules (after the 2026-09 review).** No label may contain jargon a reader cannot decode.
  Everyday developer abbreviations (CPU, GC, p95) stay, but each has a `*Hint` entry, shown as a
  `title` tooltip on KPI tiles, control buttons and table headers, that says what the number is and
  how to read it — never what the code is doing. Replaced wording: 占空比 → 间歇采样 (duty cycle →
  intermittent sampling), 自身开销 → 本插件开销 (self cost → this plugin's overhead), harness 内核 →
  harness 内置 (harness kernel → harness built-ins), 存活堆 → 存活对象 (live heap → live objects),
  未归属 → 无法归属 (unattributed → cannot be attributed), 原生 / libuv → 原生 / 系统调用 (native /
  libuv → native / syscalls). Tests lock both "retired words never return" and "every dense label has
  a hint".
- A compact right-sidebar view (`sidebar.right.pane.tab`) is an optional Phase 2 form and does not
  block v1.

---

## 3. The dashboard (the v1 core)

**Fully feasible with existing mechanisms.** The dashboard is not a new data source; it is a
continuous rendering of the collectors in §2.

### 3.1 Where the panel lives

| Form | Slot | Content |
| --- | --- | --- |
| **Left-nav entry** | `sidebar.panellist` | Icon plus the label "Perf Lens" (性能透镜), next to the built-in Plugins panel (dsh ≥ 0.1.7) |
| **Main dashboard** | `main` (keyed; key = the entry's id) | Overview, composition, cards, trend, ranking, grouped table and controls (§10.1) |
| Compact view (optional, Phase 2) | `sidebar.right.pane.tab` | An always-visible sortable table in the right sidebar |

### 3.2 How "live" it can honestly be

Sampling works in windows, so "real time" can never be finer than one window. No WebSocket is
needed: polling `/api-perf/snapshot` is enough, at an interval that follows the current window.

### 3.3 Continuous sampling

Under the default duty cycle (sample 5s, sleep 30s or longer) the dashboard can feel frozen. So:

- The control bar's **Continuous sampling** button sends `POST /api-perf/control
  { mode: 'continuous' }`: the host drops the sleep to 0 and shortens the window (2s by default),
  giving a task-manager feel with updates every couple of seconds. Clicking it again returns to
  `duty`.
- Continuous mode has a **cost ceiling**: after `continuousMaxMs` (10 minutes by default) the host
  falls back to the duty cycle on its own, so it cannot be left on by accident.
- The header chip always shows the active mode. The cost is paid only while someone is looking —
  which is how the feasibility conclusion "deep sampling on demand" becomes a product feature.
- *Planned:* switch to continuous automatically while the panel is visible and back when it is
  hidden, and show the remaining time before the automatic fallback.

### 3.4 Sparklines and history

- Sparklines: the panel keeps each plugin's last 30 CPU-share readings, seeded from
  `/api-perf/trend` on mount so a reload does not start blank.
- History: the trend chart and ranking read the JSONL log (§7) over a selectable range.
- All hand-drawn SVG, no dependencies.

---

## 4. Attribution (the core)

### 4.1 Plugin index

Built from `ctx.loader.entries()`: moduleName → resolution anchor `baseUrl` + package directory → a
set of path prefixes.

Frame classes:

| Class | Rule | Shown as |
| --- | --- | --- |
| `plugin:<name>` | The path is inside a plugin's package directory | Its own row |
| `harness:<pkg>` | The path is inside a `@deepseek-ai/dsh-*` harness package | Folded into one "Harness built-ins" row, with the top internal packages listed beneath it |
| dependency of a plugin | Inside shared `node_modules`, reached by walking up to a plugin | **Charged to that plugin** (no separate row) |
| `runtime:*` | `node:*`, native frames, GC, `(program)` / `(root)` | Split into GC / native / Node internals / event loop, with a `runtime` remainder (evidence 9) |
| `self` | This plugin's own paths | Its own "This plugin's overhead" row, never charged to anyone else |
| `idle` | `(idle)` samples | Not a row; removed from the share denominator (§5) |

### 4.2 Assigning a sample

The CPU profile's `nodes[]` is a call tree; `children[]` gives the child links, so a reverse parent
map has to be built. For each sample:

```
walk(node):
  if owner(node.callFrame.url) is a plugin: return that plugin
  if node has no parent: return UNATTRIBUTED
  return walk(parent)
```

The heap sampling tree works the same way (`selfSize` is added to the owner the walk returns).

**Why not by file:** see
[evidence 5](evidence.md#evidence-5-decisive-attribution-must-walk-the-ancestor-stack) — naive
per-file attribution drops 573 of 574 samples into a bucket nobody owns. The fixture in
`test/attribute.test.ts` (pluginA 200 calls and pluginB 60 calls through a shared dependency,
asserting a ratio of about 3.33) **locks this rule in**; no refactor may fall back to per-frame
attribution.

### 4.3 Async boundaries

Sampling is **stack-driven**, so it naturally works across `await`: when a plugin's async function
resumes, its frames are back on the stack. That is why sampling was chosen over attributing by
AsyncLocalStorage context — in an event-driven plugin architecture, a listener's context is decided
when it is **registered**, not when it **fires**, which would misattribute systematically.

The one case the stack walk cannot see is a plugin handing work to a harness timer or callback
("mechanism C"). In deep mode only, `async-attribution.ts` records async_hooks execution windows and
hands samples inside them back to the plugin that created the resource
([evidence 11](evidence.md#evidence-11-mechanism-c-async-boundaries-is-attributable),
[design-overnight-analyzer.md §13.8](design-overnight-analyzer.md)). Otherwise async_hooks is used
only for **file operation counts** (the caller is on the stack at `init`).

---

## 5. Metric contract

Single source of truth for the types: `src/shared/contract.ts`. One row per plugin per window:

| Field | Unit | Precision | Source |
| --- | --- | --- | --- |
| cpuShare | % | sampled estimate | CPU profiler |
| cpuSelfMs | ms | sampled estimate | CPU profiler: samples × the window's achieved interval (`sampleIntervalMs`) |
| liveHeapBytes | B | sampled estimate | heap sampling (`stopSampling`) |
| allocBytesPerSec | B/s | sampled estimate | heap sampling tree deltas |
| fsReadOps / fsWriteOps | count | **exact** | async_hooks |
| fsReadBytes / fsWriteBytes | B | **partial coverage** | planned: `ctx.fs` wrapper (with coverage); currently 0 |
| timers / listeners / handles | count | exact | planned: cordis lifecycle wrappers; currently 0 |
| diskFootprintBytes | B | **exact** | planned: directory scan; currently 0 |
| fiberPhase | enum | exact | ctx.loader |
| coverage | % | — | required on every partially covered field |

Plus one process row: rss / heapUsed / heapTotal / external / arrayBuffers / eventLoopLagP99Ms /
gcPauseMs / fsOpsTotal (exact, process-wide) / sampleWindowMs / sampleCount / idleSamples /
sampleIntervalMs / processCpuMs.

**Idle must be kept apart from runtime.** The CPU profiler samples idle time as nodes with an empty
URL and the function name `(idle)` (measured: 1715 of 1716 samples in an idle 3s window). Counting
the empty URL as runtime would make an idle host look like 90% runtime cost. Therefore:
- `idle` is its own owner and never a plugin row;
- each plugin's `cpuShare` uses **active samples** (`sampleCount - idleSamples`) as the denominator,
  or idle time would dilute every share towards 0;
- the overview shows "active samples N/M" and "idle %".

Because active samples can be a small fraction on an idle host, a share can look large while the
absolute cost is tiny. The panel therefore shows ms of CPU per second and "% of one core" next to
every share ([design-overnight-analyzer.md §6.5](design-overnight-analyzer.md)).

### Coverage rules (a hard product constraint)

- Every inexact metric must carry a **visual marker** in the UI; it may not sit next to exact figures
  looking equally trustworthy.
- Below the coverage threshold (default **60%**) a byte column shows "≥ N (insufficient coverage)"
  rather than a value.
- When the unattributed share passes its threshold (default **15%**) the overview warns about it
  instead of showing it quietly.
- The panel always states the current sampling mode, window length and sample count.

---

## 6. Sampling state machine

```
        +----------+  start   +-----------+  window elapsed  +----------+
        |  IDLE    |--------->| SAMPLING  |----------------->| COLLECT  |
        +----------+          +-----------+                  +-----+----+
             ^                                                      |
             |                  duty-cycle sleep                    |
             +------------------------------------------------------+

  CONTINUOUS = no sleep between IDLE and SAMPLING (idleMs = 0).
```

- `Profiler.stop` throws `ERR_INSPECTOR_COMMAND` when nothing is recording (evidence 8), so the state
  is tracked explicitly and stop is never called blindly.
- The heap sampling tree grows with the window, so every window must call `stopSampling` to release
  it; nothing may accumulate indefinitely.
- Defaults: CPU sampling interval **250µs**, window 5s, sleep 30s; heap sampling off until deep mode
  is turned on. 250µs was chosen by measurement: on an idle 3s window it costs the same as 1000µs
  (15 vs 16ms of CPU) with four times the resolution, while 100µs jumps to 126ms (8×). The cliff is
  between 250µs and 100µs. (On Windows the achieved interval floors at about 540µs regardless;
  see design-overnight-analyzer.md §13.3.) CPU time is therefore always charged at the interval the
  profile actually achieved — its span over its sample count — never the configured one
  (evidence 13).
- **Idle backoff:** when a window is at least 80% idle, the duty-cycle sleep stretches by 4× (up to
  120s). On an idle host nearly every sample is idle, and keeping the cadence only burns CPU and
  disk. (Basis: evidence 8's only stable trend is "both samplers together cost the most", so by
  default only CPU sampling runs.)
- **Sentinel probes:** during a long backoff, a coarse 10ms-interval probe runs for 1s every 10s and
  triggers a real window as soon as it sees activity. Probes are never recorded
  (design-overnight-analyzer.md §13.7).
- Continuous mode: `idleMs = 0`, 2s windows, and an automatic fallback after `continuousMaxMs`
  (10 minutes).
- Background mode: 1000µs interval, 2s window, 120s sleep — a cheap always-on record.
- Every switch **takes effect immediately**, and unloading the plugin stops sampling unconditionally
  (cordis effect disposer).
- The state machine is fully tested with vitest fake timers and a mock inspector session, including
  four failure paths: stopping a session that never started, `apply` failing halfway, a repeated
  start, and the continuous-mode timeout.

---

## 7. Persistence (decided: on by default)

**Decision:** v1 writes a JSONL log by default (settled in review), to answer "which plugin started
getting worse last week".

- Path: `$DSH_HOME/perf-lens/metrics-YYYYMMDD.jsonl`, one file per UTC day.
- Content: **one aggregated snapshot per window** (process row plus the plugin rows that did
  something). **Raw profile trees and call frames are never written** (for size and privacy).
  All-zero rows are not written either: they only restate the plugin inventory
  (`ctx.loader.entries()` lists 200+ harness-internal packages as plugin rows). Measured: 214 of 220
  rows were all zero, and writing them made each line about 46× larger (evidence 10).
- Aggregation rule: **a row missing from a persisted window means zero activity in that window.**
  The range `avgCpuShare` therefore averages over **every window in the range**, not only the windows
  where the plugin appears — otherwise a plugin that spiked once would look like a constant consumer.
- Retention: **14 days** and at most **200 MB** in total by default; beyond that the oldest day
  files are deleted.
- Privacy: only read/write **counts** are persisted. File paths are not collected at all.
- Write discipline: a single appending writer. The lens's own writes are counted by the IoTracker,
  but self-frame exclusion keeps them out of every plugin's attribution; they land on the `self` row.
- In memory there is also a short ring buffer (about the last hour at full resolution) for the live
  view.
- Read path: `/stats` and `/trend` read through `HistoryStore.summaries`, an incremental cache that
  parses each line once, then only the bytes appended since the last read, and keeps only the fields
  the aggregators use. Day files that ended before the requested range are not opened. Before this,
  every call re-parsed the whole log on the event loop (evidence 12).

---

## 8. HTTP API

| Route | Method | Content | Status |
| --- | --- | --- | --- |
| `/api-perf/snapshot` | GET | Current window (process row + plugin rows + unattributed/self shares + harness breakdown) | shipped |
| `/api-perf/control` | POST | `{ action: 'pause' \| 'resume' }`, `{ mode: 'duty' \| 'continuous' \| 'background' }`, `{ deep: boolean }`; takes effect immediately | shipped |
| `/api-perf/diagnostics` | GET | Sampler state, last error, owner rules and keys — for troubleshooting | shipped |
| `/api-perf/history?plugin=&since=` | GET | Raw persisted windows (ring + JSONL) | shipped |
| `/api-perf/stats?range=1h\|24h\|7d` | GET | Range aggregate per plugin: avg / peak / p95 / cumulative core-time / coverage | shipped |
| `/api-perf/trend?range=1h\|24h\|7d` | GET | **Compact series** for the trend chart: bucket-averaged to ≤ 120 points, share and ms/s per plugin | shipped |
| `/api-perf/hotspots?plugin=` | GET | A plugin's hot functions; deep mode only, in memory only | shipped |
| `/api-perf/vitals` | GET / POST | Foreground jank reports; POST bodies are validated before entering an in-memory ring | shipped |
| `/api-perf/export` | GET | Report export (JSON / Markdown) | planned (Phase 2) |
| `/api-perf/heap-snapshot` | POST | Take a heap snapshot to disk and return its path | planned (Phase 2) |

Every response type comes from `src/shared/contract.ts`, shared by host and client.

---

## 9. Plugin configuration (planned)

No configuration schema is exported yet: the values below are constants in
`src/shared/defaults.ts` (and, for history, `src/host/index.ts`). This is the planned schemastery
schema.

| Key | Default | Meaning |
| --- | --- | --- |
| cpuIntervalUs | 250 | CPU sampling interval (250µs costs the same as 1000µs with 4× the resolution) |
| windowMs | 5000 | Duty-cycle window length |
| idleMs | 30000 | Duty-cycle sleep |
| continuousWindowMs | 2000 | Continuous-mode window length |
| continuousMaxMs | 600000 | Continuous mode falls back after this long |
| heapSampling | off | off \| deep; deep mode turns on dual sampling |
| history.persist | true | Write the JSONL log |
| history.retentionDays | 14 | Days to keep |
| history.maxBytes | 200MB | Total size cap |
| idleBackoffThreshold | 0.8 | Idle share that triggers backoff |
| idleBackoffFactor | 4 | Sleep multiplier during backoff |
| idleBackoffMaxMs | 120000 | Longest backoff sleep |
| coverageWarnThreshold | 0.6 | Coverage warning threshold |
| unattributedWarnThreshold | 0.15 | Unattributed-share warning threshold |
| estimateMinCoverage | 0.05 | Below this range coverage the ranking hides its whole-range estimate |

---

## 10. Dashboard layout

### 10.1 Main panel

Redrawn 2026-09 as cards: the harness theme's `--dsw-alias-*` tokens (the same source dsh-context
uses), one stylesheet (`styles/panel.css`) inlined through tsdown's global-CSS channel, and a flat
`pl-*` class namespace. The root is `height: 100%; overflow-y: auto`, so the whole page scrolls like
the built-in panels. Still no chart library and no CSS toolchain (no minifier; a few KB of CSS is
embedded as is).

```
+-- Perf Lens [Intermittent] ------------ [Pause|Continuous|Background|Deep sampling] -+
| Process overview: [RSS][Heap][Lag p99][GC][Window][Active samples][Idle]             |
|                   sampled coverage · resolution · unattributed · this plugin's cost  |
+--------------------------------------------------------------------------------------+
| Cost composition: CPU ====stacked bar==== | Memory ====stacked bar====               |
|   top 5 plugins + other plugins + unattributed + own overhead + idle/unsampled       |
+--------------------------------------------------------------------------------------+
| Foreground jank: ● smooth/janky  long tasks  frame gap p95  correlation ≠ causation  |
+--------------------------------------------------------------------------------------+
| Top consumers: [up to 6 cards: name, current %, sparkline, core %, avg, peak, heap]  |
+--------------------------------------------------------------------------------------+
| Trend: [Share|Absolute] [1h|24h|7d] ≤ 12 lines by peak, ≤ 8 legend chips, hover tip  |
+--------------------------------------------------------------------------------------+
| Cumulative cost ranking: # plugin cumulative absolute avg p95 peak estimate          |
|   top 10 with "show all"; idle plugins counted in a footnote                         |
+--------------------------------------------------------------------------------------+
| Plugin detail: grouped table (sticky header, 52vh scroll, folds, hot-function rows)  |
+--------------------------------------------------------------------------------------+
```

Key rules: the composition bars answer "how much of the whole process is plugin X" (CPU normalised by
active samples, heap by heapUsed, unattributed heap shown as its own segment, estimates never
presented as exact); `self` / `unattributed` rows are merged with their bookkeeping fields so nothing
is counted twice; the trend caps both lines and legend chips and counts what it left out in a
footnote; the ranking lists only plugins with sampled CPU.

### 10.2 Compact view (optional, Phase 2)

An always-visible table in the right sidebar (`sidebar.right.pane.tab`) without sparklines or
controls; clicking it opens the main panel through `ctx.layout.selectPanel(PANEL_ID)`. Not in v1.

### Interaction rules

- Sorted by `cpuShare` descending by default; memory, disk and allocation rate are also sortable.
- The coverage column marks anything under the threshold with a warning style and explains it on
  hover.
- The header chip names the active sampling mode (continuous mode is highlighted).
- A full analysis page under `settings.section`: Phase 2.

---

## 11. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Misattribution (blaming dependencies) | The dashboard points at the wrong plugin | Mandatory ancestor walk; the 3.33 ratio is locked by a unit test |
| Sampling cost underestimated | The host slows down and users uninstall | Conservative duty cycle; the `self` row shows the lens's own cost; continuous mode capped at 10 minutes; one-click pause |
| Continuous mode left on | A lasting +15% to +26% overhead | Automatic fallback after `continuousMaxMs`, and the mode chip is always visible |
| Microbenchmark numbers quoted as facts | Design decisions built on noise | Rely only on the stable "both samplers cost most" trend; show sample count and window length |
| False precision (bytes) | Users optimise the wrong thing | Coverage markers; "≥ N" when coverage is low |
| Heap snapshots exhausting memory | Host OOM | Write to disk and parse in another process, never in the host; rate-limit (Phase 2) |
| Bundling / worker boundaries | Some frames cannot be attributed | Counted as unattributed, **shown explicitly**, warned about past the threshold |
| Clashing with other inspector users | Debug port conflicts | Uses its own `inspector.Session`; no port needed |
| Self-sampling amplification | The lens tops its own ranking | Self paths excluded from every plugin and shown as their own row |
| JSONL disk growth | Fills `$DSH_HOME` | Daily files, retention period, total size cap, unit-tested pruning |
| File-path privacy | Leaks the user's directory layout | Only counts are persisted; paths are never collected |
| Panel reads costing the host | The panel becomes a top consumer | Incremental history cache; refresh only after a new window is recorded (evidence 12) |

---

## 12. Scope by phase

### v1 (this document)

Plugin inventory, process metrics, per-plugin CPU sampling, retained-heap sampling (deep mode), file
operation counts, **the dashboard (sidebar.panellist entry + main panel + continuous sampling +
sparklines)**, `/api-perf/snapshot|control|history`, and **the JSONL log with history charts**.

Still open from the v1 list: timer/listener/handle counts, the directory byte scan, `ctx.fs` byte
wrapping and the SelfMonitor.

### Phase 2

On-demand heap snapshots with offline parsing, a per-plugin detail view (hot functions / allocation
sites / files touched), report export, a full `settings.section` page, and baseline comparison (diff
against a known-good state).

### Phase 3 (opt-in, experimental)

Byte-level disk I/O through a `node:fs` loader hook, child-process sampling (dsh-subprocess-local /
node-pty / LSP) and renderer metrics. Off by default and labelled experimental. **v1 explicitly
leaves child processes out.**

---

## 13. Decisions (formerly open questions)

| # | Question | Decision |
| --- | --- | --- |
| 1 | History retention | **JSONL on disk by default** (§7); only counts are persisted |
| 2 | Add a `settings.section` page? | Phase 2; v1 uses sidebar.panellist + main, like the Plugins panel |
| 3 | Child processes in v1? | **No**; v1 covers plugin frames inside the host process only |
| 4 | Coverage / unattributed thresholds | 60% / 15% by default |
| 5 | Baseline comparison | Phase 2 |
| 6 | Live dashboard form | **v1**: sidebar.panellist entry + main dashboard + continuous sampling (§3) |
| 7 | Panel location | **Same shape as the dsh 0.1.7 plugin panel**: sidebar.panellist + main + `ctx.layout.selectPanel` (needs dsh ≥ 0.1.7-alpha.1) |
| 8 | What the ranking counts | Cumulative core-time **within sampled windows** (sum of `cpuSelfMs`), shown with the sampling coverage. Any extrapolation is labelled an estimate; nothing is scaled up silently |
| 9 | Foreground jank attribution | The browser cannot attribute a long task to a plugin bundle, so the panel only shows its **time correlation** with host CPU and always says "correlation ≠ causation" |
| 10 | Persisting hot functions | **Never** (frame-level data, the §7 red line); in memory only, deep mode only, cleared when deep mode is turned off |
| 11 | Source maps for hot functions | Not done; host-side third-party packages ship almost no maps, and the raw `functionName` + `file:line` is already usable |
| 12 | Trend data source | **A dedicated compact `/api-perf/trend`**, not `/api-perf/history`: 24h of full snapshots measured 31.5MB per poll against 119KB for the compact series (259×), and bucket averaging keeps peaks |
| 13 | Panel layout | Trend and ranking sit **above** the plugin table, which scrolls inside 52vh: a real host has 200+ plugins and the table would push the trend thousands of pixels down |
| 14 | Merging and grouping | The host merges every `harness:*` owner **into one `harness` row** (diagnostic `ownerKeys` keep the raw keys); the panel groups rows as `external / harness / runtime / self / other` |
| 15 | Folding idle rows | Rows with zero CPU, heap, disk and allocation in the current window fold into "No cost this window N" per group. This is decided **per window**, not a permanent label |
| 16 | Background profile | `SampleMode = 'background'`: 1000µs interval / 2s window / 120s sleep, a low-rate always-on record that keeps writing JSONL while the panel is closed |
| 17 | Sparkline seeding | On mount the panel seeds each series with the last 30 points of `/api-perf/trend`; before, series lived only in component state and a reload cleared them |
| 18 | Splitting runtime | `runtime` is no longer one row: `runtime:gc` / `runtime:native` / `runtime:node` / `runtime:event-loop`, with the remainder left in `runtime`. Basis: [evidence 9](evidence.md#evidence-9-the-runtime-bucket-must-be-split) — the bucket measured 19% GC, 14% Node internals and a tail of native frames |
| 19 | History read path | `/stats` and `/trend` read through an incremental in-memory cache (`HistoryStore.summaries`) instead of re-parsing the log per call; the panel refetches only after a new window is recorded ([evidence 12](evidence.md#evidence-12-re-parsing-history-on-every-panel-refresh)) |
| 20 | Ranking length and estimate | The ranking lists only plugins with sampled CPU, top 10 by default with "show all". The whole-range estimate is hidden below 5% sampling coverage (`estimateMinCoverage`), where it would be a 20× or larger scale-up |
| 21 | What one sample is worth | Each window charges its samples at the **achieved** interval (profile span / sample count, published as `global.sampleIntervalMs`), not the configured one. Charging at the configured 250µs understated every absolute figure about 2.2× on Windows ([evidence 13](evidence.md#evidence-13-cpu-time-must-be-charged-at-the-achieved-sample-interval)) |
