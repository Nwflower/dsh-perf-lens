# Changelog

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
- **Controls:** pause, continuous sampling (falls back on its own after 10 minutes), a low-cost
  background profile, and deep sampling (adds heap sampling, hot functions and async attribution).
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
