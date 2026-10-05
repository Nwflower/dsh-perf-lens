# Changelog

## 0.2.0 (unreleased)

### The panel

- **Per-plugin browser jank attribution** in the Foreground jank card: long-frame script time is
  attributed to the plugin that ran it (Long Animation Frames API), with script milliseconds,
  script-forced layout milliseconds and entry counts per plugin, plus the share of long-frame script
  time that could be attributed at all. Browsers without the API (pre-Chromium-123) keep the previous
  "correlation ≠ causation" view — and so does the DSH Desktop window, whose browser build withholds
  script attribution entirely (measured on the `dsh-app://` scheme); the table appears on the
  `dsh web` GUI.
- **Descendant processes** in the process overview: how many processes the host has spawned, their
  combined CPU as a share of one core, and their combined resident memory — flagged when they are
  using more than a whole core. Shell commands, terminals and language servers all run as children,
  so this is what explains "the host is idle but the machine is busy". These figures are **not**
  attributed to any plugin.
- **Unexplained CPU** chip: the CPU the process burned that the profile did not account for,
  shown once it passes a fifth of the process's CPU. The in-process sampler only sees the main
  thread, so this is where a worker thread or off-thread native work shows up.
- **Process resources** chip: the async resources the process is holding (timers, sockets, handles),
  process-wide, because no per-plugin source is affordable (see below).
- **Listeners** column: event listeners per plugin, read straight out of the cordis event registry.
  Exact, no wrapping, and 0 genuinely means "none registered".
- **On disk** column: bytes each plugin holds under `$DSH_HOME`, from a budgeted directory scan.
  Exact, and independent of the sampling window.
- **Jank probe** switch: on the DSH Desktop window, where the browser withholds long-frame script
  attribution, a page-side probe measures which plugins' scheduled callbacks occupy the main thread
  and shows callback milliseconds, call counts and the longest single call per plugin. Off by
  default; turning it on reloads the page once so the probe is installed before plugins register,
  and the choice is remembered. The column reads "callbacks registered here": a plugin can schedule
  another plugin's callback, and nested wrappers are counted at each level.

### Measurement

- Long Animation Frame script entries are resolved host-side at record time: plugin bundle URLs map
  to owners directly, and multi-plugin combo bundles resolve through deterministic segment offsets
  computed from each plugin's published client.js. Segments that cannot be read are reported as
  unresolved, never guessed, and raw script entries (function names, paths) stay in memory only.
- The foreground vitals reporter now runs from the client bundle's entry, so jank is observed while
  the panel is closed; the panel polls the host's ring instead of running its own reporter.
- `/api-perf/diagnostics` now reports whether the 0.2.0 collectors engaged: `processTree.available`
  (a false here means the process table is unreadable, not that the host has no children),
  `diskFootprint` (null before the first scan; `truncated` means the figures are a lower bound) and
  `listenersMeasured` (false means the cordis event registry was not exposed, so the column is a gap).
- `unexplainedCpuMs` is published per window: process CPU minus the CPU the samples account for,
  never negative, and never folded into a plugin.
- Descendant processes are polled on their own slow timer (default 30s) rather than per window,
  because a process-table read costs a spawn; the CPU figure is a rate over the gap between two
  polls, and `coverage` says how much of it was computable.
- Per-plugin on-disk bytes come from a walk of `$DSH_HOME` **plus each plugin's own resolved
  directory** — a plugin installed with `link:` lives outside the home, and the walk never follows
  symlinks, so the home alone reported 0 bytes for exactly the plugins a developer cares about.
  Directories are visited once, so a plugin inside the home is not counted twice. Symbolic links are
  never followed; the walk is budgeted (200k entries / 4s) and reports a lower bound when it hits the
  budget or a root it cannot open.
- Listener attribution reuses the fiber → owner-key mapping, so a listener and a CPU sample for the
  same plugin always land on the same row.

### Not measured, on purpose

- **Per-plugin timer and handle counts.** The only mechanism is an always-on `async_hooks` hook,
  measured at 2.3–2.6× on promise-heavy work with a ~13µs stack capture per timer
  ([evidence 15](docs/evidence.md#evidence-15-an-always-on-async_hooks-hook-is-too-expensive-for-a-live-timer-gauge)).
  A window-scoped gauge would undercount and read as a false zero, so the columns are omitted and
  the panel shows the process-wide totals instead.
- **Per-plugin file bytes** are still not measured; file operation counts are.

### Data

- The two readings on their own clocks (`processTree`, `diskFootprint`) and the per-row live gauges
  (`listeners`, `diskFootprintBytes`) are **live only** and are stripped before a window is persisted.
  The JSONL log keeps the same shape and size as 0.1.0.
- `unexplainedCpuMs` and `activeResourceCounts` are per-window figures and **are** persisted, so both
  have a trend: a growing resource count or a persistent unexplained residue is visible in history.

## 0.1.0 (unreleased)

First release.

### The panel

- A **Perf Lens** entry in the left sidebar opens a full dashboard in the main column
  (DSH ≥ 0.1.7-alpha.1).
- **Process overview:** RSS, heap, event-loop lag p99, GC pause, sampling window, active samples and
  idle share, with chips for sampled CPU coverage, sampling resolution, the unattributed share and
  the panel's own overhead.
- **Cost composition:** stacked bars showing how much of the whole process each plugin takes, for CPU
  and for sampled heap, with unattributed and idle slices shown explicitly.
- **Top consumers:** up to six cards with current share, % of one core, ms/s, average, peak and held
  heap, plus a sparkline seeded from history so a reload does not start blank.
- **Trend:** a CPU chart over 1h / 24h / 7d, in absolute ms/s (default) or share. Plugins that never
  pass 0.5% are hidden, at most 12 lines are drawn, and a footnote counts what was left out.
- **Cumulative cost ranking:** the plugins that burned the most CPU over the range, with average, p95
  and peak. Only plugins with sampled CPU are listed (top 10, "show all" for the rest); the
  whole-range estimate is hidden when sampling covered less than 5% of the range.
- **Plugin detail:** a grouped, sortable table (external plugins, harness built-ins, runtime, this
  plugin), with idle rows folded, the top harness internal packages listed under the harness row, and
  hot functions per row in deep mode.
- **Foreground jank:** long tasks and frame gaps measured in the browser, shown next to the host's top
  plugins at the time and labelled "correlation is not causation".
- **Controls:** three blocks that combine — an intensity segment (**stop / low / high**), **background
  sampling** (what keeps a coarse record going while the intensity is stop) and **memory sampling**
  (heap sampling, hot functions and async attribution). The host reports the settings back, so they
  survive a page reload.
- Chinese and English, following the GUI language without a reload.

### Measurement

- CPU attribution walks each sample up the call stack to the nearest plugin frame, so a plugin's
  dependencies are charged to the plugin.
- Runtime cost is split into GC, native / syscalls, Node internals and the event loop.
- Every share is shown next to its absolute cost (ms/s and % of one core), because on an idle host a
  share's denominator is tiny.
- CPU time is charged at the sample interval the profiler actually achieved in each window, not the
  configured one (on Windows the tick floors at ~0.54ms however low it is set).
- Per-plugin file operation counts come from `async_hooks`, with no patching of `node:fs`.
- Deep mode re-attributes work a plugin schedules through harness callbacks, using async execution
  windows.
- Duty-cycle sampling at 250µs by default, with idle backoff up to 120s and a cheap sentinel probe
  every 10s during long backoffs.

### Data

- One aggregated line per window in `$DSH_HOME/perf-lens/metrics-YYYYMMDD.jsonl`, kept for 14 days
  and capped at 200 MB. Only counts and costs are written; no call frames, function names or file
  paths.
- The range endpoints read history through an incremental in-memory cache, so an open panel costs the
  host a few milliseconds per refresh instead of re-parsing the log, and it refetches only after a new
  window has been recorded.

### Known limitations

- Per-plugin disk **bytes**, timer / listener / handle counts and disk footprint are not measured
  yet. File operation counts are exact.
- There is no per-plugin RSS: memory figures are sampled estimates of heap allocated during deep-mode
  windows.
- Child processes (subprocess runners, terminals, language servers) and browser memory are out of
  scope.
- Sampling settings are fixed defaults; there is no configuration schema yet.
