# Landscape survey: who else attributes runtime cost to a plugin?

> Researched: 2026-09-24. This document surveys **other projects**, not this one. It answers three
> questions: is the niche really empty, what can be borrowed, and which statements in
> [feasibility.md §7](feasibility.md#7-ecosystem-survey) are now out of date.
> `feasibility.md` remains the authority on *feasibility*; this file is the authority on *the market*.
> Claims marked **[unverified]** were explicitly not confirmed by a primary source.

---

## 0. Summary

GitHub's `dsh-plugin` topic now holds **~16 000 repositories** (`dsh` ~7 800). That ecosystem has
produced a dense ring of neighbours: machine monitors, static plugin scorecards, process-level
OpenTelemetry exporters, a bisection tool, and one client-side per-plugin render attribution. **None
of them attributes runtime resource cost to an individual host plugin.**

Outside DSH the pattern repeats, and for a structural reason worth stating once:

> Per-plugin runtime cost is easy to attribute exactly when the platform gives each plugin **its own
> process** or **its own instrumented entry point**, and hard when plugins share one process and are
> only reachable through a generic dispatch path. DSH is the hard case: one Node process, Cordis
> fibers, no per-plugin scheduler.

The closest analogues, ranked by how much of the problem they actually solve:

| Rank | Project | How close | Where it stops |
| --- | --- | --- | --- |
| 1 | **spark** (Minecraft, `spark.lucko.me`) | Sampling profiler in one shared process; the viewer has a **Sources view with a separate profiler tree per plugin/mod**; web UI; `--alloc` allocation sampling | Attribution is post-upload in the viewer, not an in-app live panel; heap is per **class**, not per plugin; no per-plugin I/O |
| 2 | **VS Code extension-host profiler** | Same primitive (in-process V8 CPU profile), same shared-process problem, **and it really does roll up per extension** | On-demand burst only (user-started, or auto on unresponsive host); CPU only, no memory; no steady-state panel or history |
| 3 | **Bukkit/Spigot Timings v2** | Always-on, per-plugin wall-clock tick time via classloader identification; ~1% self-reported overhead; web report | Instrumented (not sampled), wall clock only, **no memory**; Paper removed it ([Paper #8948](https://github.com/PaperMC/Paper/issues/8948)) in favour of spark |
| 4 | **Chrome / Firefox per-extension accounting** | Real per-extension CPU and memory, in-product | Works only because extensions get their own process; Firefox explicitly aggregates all add-ons in one extension process |
| 5 | **Datadog / Pyroscope / Parca / Google Cloud Profiler** | Always-on sampling with label-based attribution; the reference for overhead engineering | Attributes by service/span/pod label, not by plugin identity |
| 6 | **speed-measure-webpack-plugin / ESLint `TIMING` / WP Profile** | Per-plugin or per-rule cost inside a plugin ecosystem | Build- or request-time instrumentation, wall clock, no sampling, no memory, no steady state |

**Bottom line:** nobody has crossed into host-side per-plugin CPU + memory + I/O attribution for a
single-process plugin host. The nearest neighbour (spark) is a sampling profiler with per-plugin
rollup but no per-plugin memory; the nearest *platform* neighbour (VS Code) solved the attribution
algorithm and then shipped it as a manual, on-demand burst.

---

## 1. The DSH ecosystem (verified by search, 2026-09-24)

### 1.1 What exists

**Machine- and process-level monitors** — report the host or the DSH process, never a plugin:
`dsh-server-deck` (20 565 npm downloads/month), `dsh-top` (325), `dsh-vitals`, `dsh-resource-bar`,
`dsh-system-monitor` (GNX001), `dsh-thermal-monitor`, `dsh-sysmon` (21hbguo), `dsh-plugin-sysmon`
(hnmrxz), `AKS1st/dsh-sysmon`. Closest of the group is `JularDepick/dsh-system-monitor-plugin`: it
samples *the dsh process and its children* (`os.cpus()` deltas, RSS in GB/%) and charts them in a Web
UI tab — but there is no per-plugin dimension.

**Static plugin scorecards** — read configuration, manifests, versions:
`dsh-perfscope` (848 downloads/month) computes a 0–100 health score from mount failures, dependency
conflicts, tool error rates and token share; also `PerryLink/dsh-plugin-doctor`, `PerryLink/dsh-fast`,
`ZSeven-W/dsh-harbor`, `gwsbhqt/dsh-insight`, `tree201/dsh-capability-inspector`.
`Rex16200513/dsh-lifecycle-inspector` reports Cordis Fiber state and Effect teardown latency — the
closest thing to a per-plugin *runtime* view, with no resource cost attached.

**Process-level observability exporters** — real metrics, no plugin dimension:
`tianjiqx/dsh-runtime-observability` exports `dsh.runtime.memory{area}` (RSS / heap / external /
array buffers), `event_loop.delay`, `active_resources{type}`, `process.cpu.time` over OTLP, and can
optionally ship **wall/heap profiles to Pyroscope** via `@pyroscope/nodejs`; its README lists no
per-plugin label anywhere. `fly3366/dsh-o11y-plugin` registers global OpenTelemetry providers so
plugins can emit their *own* traces/metrics/logs. `loongsuite/dsh-plugin`,
`linyp/dsh-plugin-langfuse`, `tma1-ai/dsh-otel` and friends export **agent-turn** spans (LLM calls,
tool executions) — model cost, not host cost.

**Usage and cost meters** — `dsh-context` (112 158 downloads/month), `dsh-budget`,
`Octo-o-o-o/dsh-plugin-prune` ("real usage telemetry per plugin: calls, error rate, latency"), plus
the token/balance monitors. These count *what the agent did*, not what the process burned.

**Client-side render attribution** — `@linxin666/dsh-perf` (59 960 downloads/month, by far the most
installed performance plugin in the ecosystem). Its host half subscribes to the Cordis `session/event`
bus, the `agent/status` stream, `perf_hooks` event-loop delay and memory, and serves
`GET /api/dsh-perf/stats`; its browser HUD shows FPS and long tasks. It also runs a **per-plugin
activity scoreboard**: added-DOM-node rates attributed to each `data-dsh-plugin` root, with everything
unattributable folded into a `rest=` bucket, and a `window.__dshPerfAttribution` debug handle. That is
the same "attribute, and admit what you could not attribute" discipline as this plugin, applied to the
**renderer** instead of the host — and it directly qualifies design decision #9's premise that the
browser cannot attribute a long task to a plugin bundle (a DOM-node heuristic can, approximately).

**Bisection instead of attribution** — `qinshige/dsh-performance-guard` attacks the same question by
elimination: reversible profile isolation, a suggested half-set, repeated A/B campaigns with paired
95% confidence intervals and bias-corrected Hedges' g, cross-restart plugin bisection, a Recovery
Center, and an explicit "sampler overhead" / "measurement coverage" vocabulary. This is the serious
alternative to Perf Lens's approach and the most useful one to compare against in documentation:
bisection gives a **causal, restart-heavy** answer in minutes-to-hours; attribution gives a
**correlational, always-on** answer in seconds.

**Per-plugin attribution, but for data** — `ssdyg4444-sys/dsh-audit-log` wraps every Cordis
`waterfall` listener at registration and attributes each mutation to the exact plugin + fiber
(`confidence: "window"`). It answers "which plugin rewrote my field", not "which plugin is burning
CPU" — but it is the only other DSH plugin doing plugin-granular runtime attribution of any kind, and
it confirms that wrapping the dispatch path is available to plugins.

### 1.2 What this means for the niche claim

`feasibility.md` §7 said: *"There is no comparable plugin under the `dsh-plugin` topic"*, naming only
`dsh-plugin-bench` and the usage/cost meters. The conclusion still holds for the specific claim —
**per-plugin host CPU / memory / disk attribution** — but the reasoning is stale. The accurate
statement now is:

> The niche is still empty, but it is no longer unexplored territory. Sixteen thousand repositories
> have produced a dense ring of neighbours — machine monitors, static scorecards, process-level OTel
> exporters, a bisection tool, and a client-side per-plugin render attribution. Nobody has crossed
> into host-side per-plugin attribution, because that requires the inspector-based stack walk
> established in `feasibility.md` §3.3.

### 1.3 Demand signal

npm downloads for the last month (2026-09-24):

| Package | Downloads/month | What it does |
| --- | ---: | --- |
| `dsh-context` | 112 158 | context insight dashboard (calibration) |
| `@linxin666/dsh-perf` | 59 960 | Web perf observability + HUD + render degrade |
| `dsh-server-deck` | 20 565 | machine-level server cards |
| `dsh-fast` | 2 789 | session-load diagnostics |
| `dsh-perfscope` | 848 | static plugin health score |
| `dsh-o11y-plugin` | 434 | OTel providers for plugins |
| `dsh-performance-guard` | 402 | bisection campaigns |
| `dsh-top` | 325 | machine-level floating monitor |

Read carefully: the two most-installed performance plugins are (a) a **client-side** render
observability tool and (b) a **machine-level** dashboard. Nobody has shipped the host-side per-plugin
view, and demand for "performance" in this ecosystem is already demonstrated at tens of thousands of
installs per month.

---

## 2. Editor / IDE / browser extension hosts

### 2.1 VS Code — the algorithm is already solved, the product is not

- `Developer: Start Extension Host Profile` starts a V8 inspector CPU profile **of the extension-host
  process**. `ExtensionHostProfiler._distill` walks the V8 node tree from `(root)` carrying a segment
  id: a node starts as `program` / `gc` / `self`, and the first node whose `callFrame.url` resolves
  under an extension's install folder (`TernarySearchTree.findSubstr`) relabels the segment to that
  extension id; descendants inherit it and `timeDeltas` are summed per segment.
- That per-extension data is surfaced in **`Show Running Extensions`** (`workbench.action.showRuntimeExtensions`)
  as `Activation: Nms` and `Profile: X ms`, sorted by profile time. The manual path still saves a raw
  `.cpuprofile` opened in the generic profile-table editor.
- Always-on? No. Two on-demand paths: the user-started profile, and an **auto-profiler that fires when
  the extension host is unresponsive**, profiles ~5 s, calls `analyseByLocation(...)`, logs
  `UNRESPONSIVE extension host: '<id>' took N% of Mms`, and prompts the user only at ≥95 % and
  ≥5 000 000 µs.
- The per-extension CPU request was answered and closed as a question: [vscode#64683](https://github.com/microsoft/vscode/issues/64683)
  (jrieken pointed at `Show Running Extensions`). Process Explorer remains per **process**, so it
  cannot separate extensions sharing the host. No memory attribution, no steady-state panel, no history.
- **Algorithmic difference worth noting.** VS Code relabels a segment with the **outermost** extension
  frame on the path and lets descendants inherit it; Perf Lens walks **up to the nearest plugin frame**.
  For a stack `pluginA → pluginB → sharedLib`, VS Code charges `pluginA`, Perf Lens charges `pluginB`
  (the direct caller). Perf Lens's rule is the one that makes "a plugin pays for its dependencies"
  true; VS Code's is the one that makes "the extension that started the work pays" true. If the panel
  ever needs to answer "who started this work", the outermost rule is a cheap second view.

### 2.2 Chrome — attribution by process

- `chrome.processes` (Dev channel) exposes per-process `cpu` (% of one core across the process's
  threads), `privateMemory`, `jsMemoryUsed` / `jsMemoryAllocated`, and a `ProcessType` including
  `"extension"`. Data arrives through Task-Manager-driven `onUpdated` / `onUpdatedWithMemory`; the docs
  warn that collecting memory "incurs extra CPU usage and should only be queried for when needed".
- Attribution works because an extension's background page / service worker normally gets its own
  renderer. **Content scripts run in the page's renderer**, so their cost lands on the tab, not the
  extension — a per-process design has its own blind spot.
- `chrome://performance` is the Memory Saver / Energy Saver settings surface, **not** a per-extension
  accounting view; per-extension numbers come from Task Manager (`Shift+Esc`).

### 2.3 Firefox — the strongest external confirmation of the premise

- In current Firefox, `about:performance` **redirects to `about:processes`**
  (`docshell/base/nsAboutRedirector.cpp` maps `{"performance", "about:processes", …}`). The old Task
  Manager with a per-add-on "Energy Impact" column no longer exists; the historical implementation
  could not be retrieved, so any description of it stays **[unverified]**.
- `about:processes` measures per **process** from OS counters: `ChromeUtils.requestProcInfo()`, deltas
  of `cpuTime` and `memory` between snapshots ≥1 s apart, rendered every 2 s.
- It resolves add-ons via `WebExtensionPolicy.getByURI(...)` but **deliberately skips per-window rows
  for extension processes** (`if (process.type != "extension")`), so all add-ons sharing one extension
  process are aggregated into a single row. A mainstream browser's task manager degrades to per-process
  numbers exactly when add-ons share a process — which is the DSH situation, permanently.

### 2.4 Obsidian — unmet demand, nothing implemented

- The feature request [List memory usage per plugin (e.g. a task manager)](https://forum.obsidian.md/t/list-memory-usage-per-plugin-e-g-a-task-manager/103007)
  (Jul 2025) has **zero replies**. The requester's workaround is disabling plugins and restarting;
  removing 6 plugins took macOS memory from 1.2 GB to 700 MB. Obsidian exposes per-plugin **startup
  impact** only. A GitHub search found no plugin reporting per-plugin memory or CPU **[not exhaustive]**.

### 2.5 Neovim / Emacs — load time only

- Neovim/Vim: `--startuptime`, visualised by [vim-startuptime](https://github.com/dstein64/vim-startuptime).
- [lazy.nvim](https://lazy.folke.io/usage/profiling): `:Lazy profile` "shows you why and how long it
  took to load your plugins"; `stats()` returns `startuptime`.
- Emacs: [esup](https://github.com/jschaf/esup) profiles init-file startup;
  [benchmark-init-el](https://github.com/dholm/benchmark-init-el) reports per-module `require`/`load`
  milliseconds.
- **Confirmed:** the editor ecosystem's entire vocabulary is *startup cost*. The steady-state cost of
  an already-loaded plugin is unmeasured — exactly the Perf Lens use case.

---

## 3. Application / CMS / server plugin hosts

### 3.1 spark and Bukkit Timings (Minecraft) — the closest analogue

- **spark** is a **statistical sampling** profiler (default 4 ms interval) with two engines: native
  async-profiler (Linux/macOS) and Java `ThreadMXBean` (WarmRoast-derived). Reports upload to the
  [spark.lucko.me](https://spark.lucko.me/) viewer; `--alloc` samples allocations every 512 KB; the
  heap summary is per **class**, not per plugin.
- Its viewer's **Sources view shows "a separate profiler tree … for each plugin/mod"** — so spark does
  per-plugin rollup, but only post-hoc in the browser, not as an in-app live panel. No per-plugin
  memory, no per-plugin I/O. No numeric overhead is published ("minimal impact").
- **Timings v2** attributes per plugin by **classloader identification** (which plugin loaded the
  class), wrapping event dispatch and scheduler tasks in nanotime start/stop pairs, and rendering an
  XML report at `timings.aikar.co`. The author self-reported ≈**1%** overhead — a 2014 forum post, not
  an independent benchmark. Always-on by default; Paper removed it in favour of spark, citing
  maintenance and "non-negligible" overhead.
- **Relevance:** Perf Lens ≈ spark's sampling + Timings' per-plugin rollup − the upload round-trip +
  in-process memory and file-operation counts. Spark's missing per-plugin memory is where Perf Lens
  differentiates.

### 3.2 WordPress — backtrace attribution, but not for CPU

- **Query Monitor** has **no per-plugin wall clock**. Per-component attribution exists only for DB
  queries and HTTP API calls, derived from the full backtrace logged by its own `wpdb` subclass
  (`db.php` drop-in, loads before plugins). Query *time* is real per query; page generation time and
  memory are single totals. The Hooks panel lists hooks/callbacks/priorities/component with **no
  per-callback timing** (verified in `collectors/hooks.php`). Custom timers need manual
  `do_action('qm/start', …)`. Dev/admin-only, on-demand.
- **WP Profile** (`wp profile`) does stage and **per-hook** timing from the CLI; the wrapper mechanism
  is undocumented in its README.
- **Relevance:** PHP's standard answer for I/O-like work is a backtrace; nothing attributes arbitrary
  per-plugin CPU.

### 3.3 Drupal

- **Webprofiler** is Symfony Profiler integration (Stopwatch collectors, per-event/listener timeline,
  DB panel with callers) and is explicitly dev-only. No per-module CPU/memory rollup is claimed on the
  project page **[unverified against source]**.
- The **XHProf** module reports inclusive/exclusive wall time, CPU time and memory per **function**,
  with a native UI. Module attribution is inferred from file paths, not a first-class dimension.

### 3.4 Home Assistant — per-integration startup time with anti-misattribution

- `async_start_setup` times each integration domain × phase (setup, config_entry_setup,
  platform_setup…), logs `Setup of domain X took N seconds`, and `async_get_setup_timings` feeds
  Settings → System → Repairs → "Integration startup time".
- Dependency **wait time is recorded negative and subtracted** — a deliberate anti-misattribution rule,
  the same instinct as Perf Lens's self-frame exclusion and coverage markers.
- Tracked **only during startup**; there is **no per-integration runtime CPU/memory**. The `profiler`
  integration is whole-process and on-demand (cProfile, guppy/heapy heap dump, objgraph growth logging).

### 3.5 Java / JVM

- **Spring Boot** `BufferingApplicationStartup`: named `StartupStep`s with timestamp and processing
  time in a bounded buffer with filters, exposed by the Actuator `startup` endpoint (drain-on-read).
  Opt-in (`ApplicationStartup.DEFAULT` is a no-op), framework-emitted, per-bean/per-phase wall clock —
  no CPU, memory or I/O.
- **Gradle**: build scans capture per-task timing/outcome, applied plugins, test durations, cache ops,
  and build-process CPU/memory/disk/network; `--profile` writes a local high-level report. Per-**task**,
  not per-plugin CPU.
- **Relevance:** the bounded-buffer + opt-in + filter shape is the same one Perf Lens uses for deep
  sampling.

### 3.6 Ruby

- `derailed bundle:mem` loads each Gemfile gem and reports memory at require time per gem/file tree,
  and explicitly flags a file required by several libraries as charged to the first requirer with
  "(Also required by: …)" — the same double-counting problem Perf Lens marks with coverage.
- **rack-mini-profiler** produces flamegraphs (stackprof, default `:wall`, 0.5 ms) that show **time
  spent by gem**, and `memory_profiler` breaks allocations down by gem/file/class. `stackprof` is a
  sampling call-stack profiler (`:wall` / `:cpu` / `:object`, default 1000 µs) that can be started and
  stopped inside a live process; gem attribution is **derived from `file:line`**, not native.
- **Relevance:** flamegraph-by-gem is the closest non-JVM precedent for stack-derived per-plugin
  attribution — and it is exactly the mapping Perf Lens does natively with a plugin index.

---

## 4. Continuous and Node.js profilers — the overhead engineering

### 4.1 The only published hard numbers

| Source | Claim |
| --- | --- |
| **Google Cloud Profiler** | Collection is ~10 s per minute per deployment, **randomized**; **<5 %** during collection, **<0.5 %** amortized. Node.js supports heap + wall time only (no CPU time). |
| **Polar Signals / Parca** | Continuous profiling at **19 Hz** with **<1 %** overhead; frames the tradeoff explicitly — classic profiling needs ~10 kHz for 10 s, continuous goes always-on at very low frequency. |
| **Datadog** | Publishes only "low impact / minimal impact". No numeric overhead for Node.js. |
| **Grafana Pyroscope** | Publishes only "minimal overhead". No number. |

There is **no published Node.js overhead number** to compare Perf Lens's measured +15–26 % dual
sampling against. Perf Lens's duty cycle (5 s / 30 s ≈ 17 % duty) is structurally the **same tradeoff
Google documents** (10 s / 60 s ≈ 17 % duty, <5 % during), which is the citable precedent for the
amortized-overhead argument. Vendors reach sub-1 % by combining (a) low frequency, (b) one sampler
rather than two, (c) out-of-process / eBPF collection.

### 4.2 Node.js toolchain facts

- `@pyroscope/nodejs` **is derived from `@datadog/pprof`**, which wraps the V8 CPU and heap profilers
  via the inspector. Defaults: wall sampling 10 ms, 60 s duration, 60 s flush; heap 512 KiB between
  samples, stack depth 64. `wall.CollectCpuTime` defaults **false** — Pyroscope is wall-time first,
  CPU-time opt-in. **These are the de-facto industry Node defaults** and a fair calibration point for
  Perf Lens's intervals.
- Label attribution has two production patterns: static + per-call dynamic labels bound to the sampler
  (Pyroscope `wrapWithLabels`, Datadog `DD_TAGS`), and automatic trace↔profile correlation (Datadog
  trace linking, endpoint profiling). **Pyroscope's dynamic labels are wall/CPU only — heap samples get
  no dynamic labels at all**, a real constraint if per-plugin *heap* attribution is ever done through a
  vendor-style SDK. Perf Lens's parent-pointer walk is the analogue of the first pattern, done against
  plugin identity instead of a service label.
- `--cpu-prof-interval` is in microseconds; smaller = more samples = more overhead. Heap *sampling* is
  allocation-interval based (one sample per N bytes, no heap walk); `takeHeapSnapshot` /
  `v8.writeHeapSnapshot` walk the whole heap — that asymmetry, not the sampling API, is where the cost
  lives. No primary numeric pause figure found **[unverified]**.
- The `ERR_INSPECTOR_COMMAND` / "No recording profiles found" behaviour on an unpaired `Profiler.stop`
  could not be confirmed from Node documentation **[unverified in this survey]** — but Perf Lens has its
  own measured evidence for it in [evidence.md](evidence.md), which supersedes the web search.
- **clinic.js Bubbleprof is confirmed from source**: it runs the app with
  `--trace-event-categories node.async_hooks`, filters `async_hooks` frames out of captured stacks, joins
  async trace events to stacks via `@clinic/node-trace-log-join`, and builds sync/async barrier nodes
  attributing async operations to the originating user frame. It also does **per-module and per-party
  (user vs third-party) rollup** (`mark-module-aggregate-nodes`, `mark-party-aggregate-nodes`) — the
  only profiler found with built-in per-module rollup. No overhead claim published; it is tracing via
  trace-events, not sampling.
- `0x` builds flamegraphs from in-process V8 stacks, with an optional Linux `perf` path that can **miss
  Node stacks** because of the optimizing compiler. `py-spy` is the out-of-process counterexample: a
  Rust sampler reading target memory (`process_vm_readv` / `ReadProcessMemory`) at ~100 samples/s,
  "extremely low overhead", production-safe.

---

## 5. What is genuinely unique about dsh-perf-lens

Checked against every system above, the combination that nothing else ships:

1. **In-process sampling attribution inside a single-process plugin host, with the plugin as the
   first-class dimension.** spark has the sampling but not the live per-plugin panel or memory; VS Code
   has the algorithm but only as an on-demand burst, CPU only; Timings has the per-plugin rollup but is
   instrumented, wall-clock and memory-blind; every OS-level tool needs separate processes.
2. **CPU + sampled retained heap + exact file-operation counts in one view.** No surveyed project
   combines all three. spark and VS Code are CPU-only; Timings is wall clock; Home Assistant is startup
   wall clock; `derailed bundle:mem` is require-time memory.
3. **Coverage markers on inexact metrics.** Only Home Assistant (negative wait-time subtraction) and
   `derailed` ("Also required by: …") show the same instinct; neither is a sampling system where the
   coverage question is unavoidable.
4. **Always-on duty cycle with an explicit intensity model and idle back-off**, plus deep mode on
   demand. Google Cloud Profiler has the duty cycle; nobody in the plugin-host world does.
5. **Self-frame exclusion and caller-pays attribution.** VS Code's outermost-frame rule is the closest
   thing, and it answers a different question.

The one place where Perf Lens is behind a neighbour: `@linxin666/dsh-perf` already ships **per-plugin
render attribution** (`data-dsh-plugin` roots), while design decision #9 treats browser attribution as
impossible. That is worth revisiting for the foreground-jank view.

> Closed 2026-10: decision #9 was revised and the jank view attributes long-frame script time per
> plugin through the Long Animation Frames API (see
> [design-loaf-attribution.md](design-loaf-attribution.md)).

---

## 6. What is worth borrowing

| Borrow | From | For |
| --- | --- | --- |
| The **amortized-overhead argument** (10 s window / 60 s period → <5 % during, <0.5 % amortized) as the citable precedent for a 5 s / 30 s duty cycle | Google Cloud Profiler | README / design §3.3, to justify the default tier |
| **Label-based attribution as the industry pattern** (`wrapWithLabels`, trace↔profile linking) | Pyroscope / Datadog | Framing the plugin-frame walk as "labels, but derived from the stack" in docs |
| **Per-module / per-party rollup** in a profiler UI | clinic Bubbleprof | The per-plugin detail view (Phase 2): group hot functions by plugin *and* by "harness vs plugin vs runtime" |
| **Outermost-frame second view** ("who started this work" vs "who is running now") | VS Code `ExtensionHostProfiler._distill` | Optional Phase 2 attribution-mode toggle |
| **Unresponsive-host auto-profile** (fires only when the host is stuck, ~5 s, then notifies) | VS Code auto-profiler | An automatic trigger for deep mode instead of relying on the user watching the panel |
| **Negative wait-time subtraction** for dependency waits | Home Assistant `async_start_setup` | Attribution honesty if plugin load/await time is ever shown |
| **"(Also required by: …)" double-count disclosure** | `derailed bundle:mem` | Coverage text where a module is shared by several plugins |
| **`data-dsh-plugin` DOM-root attribution** | `@linxin666/dsh-perf` | Revisit decision #9; a heuristic per-plugin jank view is demonstrably possible |
| **Bisection as the causal complement** — present the A/B campaign workflow as "confirm what the panel suspects" | `dsh-performance-guard` | Positioning: attribution narrows the field, bisection proves it |
| **Bounded buffer + opt-in + predicate filter** for startup-style records | Spring `BufferingApplicationStartup` | Deep-sampling record retention |

---

## 7. Corrections to `feasibility.md` §7

The conclusion (empty niche) survives. These statements do not:

- **"No comparable plugin under the `dsh-plugin` topic"** — true for the specific claim, misleading as
  written: there are now ~16 000 repos in the topic and a dozen adjacent performance plugins. The
  precise claim is "no plugin attributes host CPU / memory / disk to individual plugins".
- **"`dsh-plugin-bench` is a static quality score and the usage/cost meters track model spend"** — no
  longer the full picture. Add: process-level OTel/Pyroscope exporters
  (`dsh-runtime-observability`, `dsh-o11y-plugin`), machine monitors (a dozen), a bisection tool
  (`dsh-performance-guard`), client-side per-plugin render attribution (`@linxin666/dsh-perf`), and
  per-plugin data attribution (`dsh-audit-log`).
- **Design decision #9** ("the browser cannot attribute a long task to a plugin bundle") should be
  softened: a DOM-node-rate heuristic keyed on `data-dsh-plugin` is shipped in production by
  `@linxin666/dsh-perf`. Correlation is still not causation, but the strong version of the claim is
  contradicted.

---

## 8. Claims this survey could NOT verify

- Numeric overhead for spark, Query Monitor, Webprofiler, rack-mini-profiler, stackprof, Bubbleprof,
  `0x`, Datadog Node, or Pyroscope.
- Firefox's historical per-add-on "Energy Impact" mechanism (the code is gone from the current tree).
- Whether spark's Sources view keys plugins by classloader/JAR metadata or package-name heuristics.
- Whether WP Profile wraps `WP_Hook` callbacks.
- Whether Chrome DevTools' Performance panel groups or badges extension activity (only a secondary
  source; not repeated here).
- Whether Chrome's Task Manager always shows one row per extension, and how content-script CPU is
  attributed (asserted from architecture, not source-verified).
- Heap-snapshot pause magnitude in Node (no primary figure).
- Any published quantification of duty-cycle window length versus statistical noise. Standard sampling
  error is ~1/√n, so a 5 s/30 s duty cycle sees ~1/6 of the samples — the cost is **noise, not bias**,
  and short bursts are systematically under-sampled. This is a gap in the literature, not in this
  document.
- Obsidian: "no plugin exists" rests on one forum thread and one GitHub search, not an exhaustive survey.