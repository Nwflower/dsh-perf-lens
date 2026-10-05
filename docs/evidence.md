# Evidence

This file holds the **raw observed output** behind each conclusion in [feasibility.md](feasibility.md)
and the design documents, and **how to reproduce it**.

- Environment: Windows / Node v24.18.0 / @deepseek-ai/dsh 0.1.7-alpha.1 (the GUI host is a plain Node
  process)
- The probe scripts live in [`probes/`](../probes/). Each one runs on its own with no dependencies.
- All probes run in an **ordinary Node process**: the mechanisms are Node runtime features, not
  anything specific to DSH.

Output blocks are copied verbatim, including the occasional Chinese label printed by a probe.

---

## Evidence 1: the host is a single plain Node process

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId,@{n='WS_MB';e={[math]::Round($_.WorkingSetSize/1MB,1)}},CommandLine
```

Observed:

```
ProcessId  WS_MB  CommandLine
    28108  680.80  "D:\Program Files\nodejs\node.exe" C:\Users\...\@deepseek-ai\dsh\lib\bin.js web --port 3081
```

**Conclusions:**
- The GUI at `http://127.0.0.1:3081` is served by **one Node process** with an RSS of about 680 MB.
- Every host plugin shares that process, so there is no operating-system "memory per plugin";
  attribution has to happen inside the process.
- It is plain Node, not Electron, so `node:inspector`, `v8` and `async_hooks` are all available and
  no `--inspect` port is needed.

---

## Evidence 2: plugins are enumerable

Source: the harness's own `packages/host/plugin-inventory/src/index.ts`.

```ts
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']
  ...
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    const base = entry.parent.tree.ctx.baseUrl
    const meta = base === undefined ? undefined : packages?.metaOf(entry.options.name, base)
    entries.push({ entryId: entry.id, moduleName: entry.options.name, enabled: !entry.disabled, ... })
  }
}
```

**Conclusion:** any host plugin with `inject: ['loader']` can list the installed plugins and read each
one's `moduleName`, `entryId`, fiber state and path-resolution anchor. The attribution map is built
from this.

---

## Evidence 3: built-ins imported by ESM name cannot be monkey-patched

Probe: [`probes/01-esm-builtin-patchability.mjs`](../probes/01-esm-builtin-patchability.mjs)

```
ns readFileSync patched? true
named-import saw patch: NO
v8 keys: getCppHeapStatistics,getHeapCodeStatistics,getHeapSnapshot,getHeapSpaceStatistics,getHeapStatistics,setHeapSnapshotNearHeapLimit,writeHeapSnapshot
startSamplingHeapProfiler: undefined stop: undefined
inspector ok: function
```

**Conclusions:**
1. After replacing `fs.readFileSync`, the `fs` namespace object does change, but **the named-import
   binding does not**: `import { readFileSync } from 'node:fs'` uses the binding captured when the
   module was instantiated. Patching the `fs` module therefore **silently fails** for the ESM named
   imports most plugins use, and produces data that is systematically too low.
2. `v8.startSamplingHeapProfiler` **does not exist** in this Node version; heap sampling has to go
   through `HeapProfiler.startSampling` on the inspector.
3. `v8.writeHeapSnapshot` exists, so exact retained size means "write a snapshot, parse it offline".

---

## Evidence 4: CPU and heap allocation can be attributed by module URL

Probe: [`probes/02-inspector-attribution.mjs`](../probes/02-inspector-attribution.mjs)

```
cpu profile nodes: 9 samples: 83
heap sampling samples: 1

CPU self-time by frame url:
     65  /D:/Build/Temp/feas-inspector.mjs
     17  (native)
      1  node:inspector

Allocation self-size by frame url (bytes):
       4144  /D:/Build/Temp/feas-inspector.mjs

heap stats: {"heapUsed":5190784}
writeHeapSnapshot available: function
```

**Conclusion:** `Profiler.start/stop` returns `samples[]` plus `nodes[].callFrame.url`;
`HeapProfiler.startSampling/stopSampling` returns a call-frame tree with `selfSize`. Both can be
grouped by URL, and each plugin ships its own bundled `lib/index.mjs`, so URLs map one-to-one onto
plugins.

> Which URL the heap sample's `selfSize` lands on **changes between runs** (a second run put it on
> `node:inspector`, where the last allocation inside the window happened). That is exactly why this
> metric is a **statistic**: the panel must show the sample count and window length and never treat
> one reading as a fixed value.

---

## Evidence 5 (decisive): attribution must walk the ancestor stack

Probe: [`probes/04-ancestor-walk.mjs`](../probes/04-ancestor-walk.mjs)

Setup: `pluginA.runA(200)` and `pluginB.runB(60)` each call **the same shared dependency**
`shared/dep.mjs` in a loop. The true cost ratio is 200 : 60 = **3.33**.

```
direct (self-frame) attribution:
   573  (shared/other)
     1  pluginA

ancestor-walk attribution:
   441  pluginA
   131  pluginB
     2  (unattributed)
```

| Strategy | pluginA | pluginB | Ratio | Verdict |
| --- | --- | --- | --- | --- |
| Attribute by the frame itself | 1 | 0 | — | **Fails**: 573 of 574 samples land in the shared bucket nobody owns |
| Walk up to the nearest plugin frame | 441 | 131 | 3.37 | Within 1.5% of the true 3.33 |

Second run (same script, different sample distribution inside the window):

```
direct (self-frame) attribution:
   601  (shared/other)
     1  pluginB

ancestor-walk attribution:
   469  pluginA
   131  pluginB
     2  (unattributed)

ancestor-walk ratio = 3.58
```

Both runs agree: **naive attribution fails almost completely (601/602 and 573/574 samples in the
shared bucket), while the ancestor walk consistently gives 3.37–3.58 against a true 3.33 (under 8%
error).** The remaining error is sampling noise and shrinks with longer windows.

**Conclusion:** attribution must follow reverse parent pointers built from `nodes[].children` until
it reaches a frame that belongs to a plugin. This also decides who pays for a plugin's
`node_modules`: **the calling plugin**.

> With naive per-file attribution, every plugin with dependencies would pass its cost to the shared
> dependency, and the panel would consistently blame the wrong party.

---

## Evidence 6: process-wide disk I/O operation counts (exact, no dependencies)

Probe: [`probes/05-io-counters.mjs`](../probes/05-io-counters.mjs)

```
resourceUsage before: {"fsRead":1,"fsWrite":0}
resourceUsage after : {"fsRead":21,"fsWrite":20}
delta fsRead: 20  delta fsWrite: 20

report.resourceUsage: {"free_memory":9582219264,"total_memory":34137300992,"rss":89481216,
  "userCpuSeconds":0.062,"kernelCpuSeconds":0.156,"cpuConsumptionPercent":21.8,
  "maxRss":128921600,"pageFaults":{"IORequired":43250,"IONotRequired":0},
  "fsActivity":{"reads":21,"writes":23}}
```

**Conclusions:**
- On Windows, `process.resourceUsage().fsRead / fsWrite` gives **exact process-wide read and write
  operation counts** (20 writes + 20 reads produced a delta of exactly 20/20).
- `process.report.getReport()` exposes the same data as `fsActivity`, plus `rss`, `maxRss`,
  `pageFaults` and `cpuConsumptionPercent`.
- **These are operation counts, not bytes.** The panel must not present them as throughput.

---

## Evidence 7: per-plugin file operation counts (exact, no patching)

Probe: [`probes/06-async-hooks-fs.mjs`](../probes/06-async-hooks-fs.mjs)

Mechanism: an `AsyncLocalStorage` marks the current plugin, and `async_hooks` `init(asyncId, type)`
observes resource types such as `FSREQPROMISE`, `FSREQCALLBACK`, `FILEHANDLECLOSEREQ` and
`FSEVENTWRAP`.

```
per-owner fs async-resource counts:
    2  pluginA :: FILEHANDLECLOSEREQ
    7  pluginA :: FSREQPROMISE
    2  pluginB :: FILEHANDLECLOSEREQ
    4  pluginB :: FSREQPROMISE

(process-level op counts, exact, for calibration)
  fsRead: 5  fsWrite: 10
```

**Conclusion:** asynchronous file operations can be counted per plugin **with no monkey-patching**.

**Limit:** `readFileSync` / `writeFileSync` create no async resource and **are not counted**.
Synchronous I/O is covered instead by walking the ancestors of `node:fs` frames in the CPU profile
(approximate counts, correct ownership).

---

## Evidence 8: sampling overhead matrix

Probe: [`probes/03-overhead.mjs`](../probes/03-overhead.mjs)

```
--- compute-bound ---
baseline                            8 ms
CPU profiler 1000us                 9 ms
heap sampling 32KB                  8 ms
both                                9 ms
  overhead: cpu +6.9%  heap +-2.4%  both +15.1%

--- async+io-mixed ---
baseline                           70 ms
CPU profiler 1000us                70 ms
heap sampling 32KB                 67 ms
both                               79 ms
  overhead: cpu +-0.5%  heap +-4.4%  both +12.4%
```

**Conclusion:** leaving both samplers on costs **+15% to +26%** on a compute workload (two runs:
+15.1% and +25.8%), which is not acceptable. Duty-cycle rotation, on-demand deep sampling and
self-frame exclusion are required.

Second run (same script):

```
--- compute-bound ---
baseline                         8 ms
CPU profiler 1000us             10 ms
heap sampling 32KB               8 ms
both                            10 ms
  overhead: cpu +22.7%  heap -1.8%  both +25.8%

--- async+io-mixed ---
baseline                        67 ms
CPU profiler 1000us             65 ms
heap sampling 32KB              70 ms
both                            62 ms
  overhead: cpu -2.1%  heap +5.7%  both -7.3%
```

**How to read this:** these are microbenchmarks. The absolute percentages swing widely and even go
negative (on the async + I/O workload, I/O waits swamp the measurement and the noise exceeds the
sampling cost). Only one trend reproduces: **on a compute workload, running both samplers is always
the most expensive option**. Do not base design decisions on any single number.

**Side finding:** calling `Profiler.stop` when nothing is recording throws
`Inspector error -32000: No recording profiles found`, so start and stop must be strictly paired and
the state machine has to track them explicitly.

### Reproducing evidence 3–8

```powershell
cd D:\Build\dsh-perf-lens\probes
node 01-esm-builtin-patchability.mjs
node 02-inspector-attribution.mjs
node 03-overhead.mjs
node 04-ancestor-walk.mjs
node 05-io-counters.mjs
node 06-async-hooks-fs.mjs
```

Each script creates its own test files in a temporary directory and removes them when it finishes.

---

## Evidence 9: the runtime bucket must be split

The panel used to count every sample without a plugin frame as a single `runtime` row. On a real
host that row sat at the top of the board (36.8% average, 100% peak), which answers nothing: GC and
syscalls call for completely different fixes.

Probe: [probes/07-runtime-composition.mjs](../probes/07-runtime-composition.mjs)
(Node v24, 3079 samples, 250µs interval, 3s mixed workload).

| Leaf frame | Share of the runtime bucket | Classified as |
| --- | --- | --- |
| `(idle)` with an empty URL | 54.7% | `idle` (already removed from the active-sample denominator; not runtime) |
| `(garbage collector)` with an empty URL | 19.2% | `runtime:gc` |
| `write` in `node:string_decoder` and other Node internals | 13.7% plus a long tail | `runtime:node` |
| `fstat` / `writeBuffer` / `close` with an empty URL | long tail | `runtime:native` |
| `(program)` with an empty URL | 4.1% | `runtime:event-loop` |

Rule: an empty URL with a function name is a native or libuv frame; `node:` and `internal/` are Node
internals; `(garbage collector)` is GC; `(root)` / `(program)` is the event loop or program root;
anything else stays in the `runtime` remainder. Implemented by `runtimeKindOfName` /
`runtimeKindOfUrl` in `attribute.ts` and locked by unit tests.

---

## Evidence 10: all-zero rows made up ~98% of the log

Measured on the history log `$DSH_HOME/perf-lens/metrics-20260923.jsonl` (2026-09-23, 268 windows):

| Metric | Before filtering | After filtering (`rowHasActivity`) |
| --- | --- | --- |
| Plugin rows per line | 218.6 | 4.0 |
| Bytes per line | 67 873 | 1 472 |
| Whole file | 17.35 MB | 0.38 MB |

**A 97.8% reduction.** The cause: `ctx.loader.entries()` also lists the 200+ harness-internal
packages as loader entries. Their cost only ever appears under `harness:<pkg>` keys, so their
`plugin:<pkg>` rows are always zero, and external plugins are mostly zero in idle windows too. An
all-zero row carries no measurement; it just restates the plugin inventory. The live snapshot keeps
every row (the panel table lists all plugins); only the persisted copy is filtered.

Reproduce with [probes/17-log-line-compaction.mjs](../probes/17-log-line-compaction.mjs), which
rewrites an existing log through `serializeSnapshot` and reports the difference:

```powershell
node probes/17-log-line-compaction.mjs "$env:USERPROFILE\.dsh\perf-lens\metrics-20260923.jsonl"
```

What this implies: a missing row means zero activity, so `avgCpuShare` in `aggregateStats` averages
over every window in the range (see `shareDenominator` in `src/host/stats.ts`), consistent with the
bucket averages in `aggregateTrend`.

---

## Evidence 11: mechanism C (async boundaries) is attributable

The ancestor walk cannot handle a plugin that hands work to a harness timer or callback: when the
callback runs, the plugin's frame is no longer on the stack. Probe
[probes/19-mechanism-c.mjs](../probes/19-mechanism-c.mjs) builds that case (a plugin passes data to
the harness, which does the heavy work in a `setTimeout` callback) and attributes **the same CPU
profile** two ways:

| Method | harness | plugin |
| --- | --- | --- |
| Ancestor stack (the original rule) | 714 | 0 |
| Async context (async_hooks execution windows matched against sample timestamps) | 0 | 705 |

In the cross-tabulation, **701 samples are "harness" by stack and "plugin" by async context** (another
3 `runtime:node` samples and 1 `runtime:gc` sample also fall inside the plugin's windows). That is the
size of mechanism C in this setup.

The mechanisms the implementation depends on:

- The V8 profile's `startTime` is a **monotonic clock since boot** (5 745 870 256µs in this run) and
  shares no origin with `performance.now()`. `timeDeltas` must be rebased onto the wall clock the
  sampler records at start and stop (measured 1115.2ms against 1105.6ms, about 0.9% drift).
- The `async_hooks` `init` stack says who created an async resource, and `before` / `after` give the
  callback's execution window. Intersecting sample timestamps with those windows hands each sample
  back to the plugin that started the work.

Cost: `init` captures a stack per resource and `before` / `after` fire on every callback, so this
**must never stay on**. The product enables it only inside deep-mode windows (`asyncAttribution`) and
switches it off as soon as the window ends. Implementation: `src/host/async-attribution.ts`.

---

## Evidence 12: re-parsing history on every panel refresh

With the panel open, the host's own overhead (`self`) was the second-largest cost in the 24h ranking.
The range endpoints re-read and re-parsed every history file on each call, synchronously, and the
panel called two of them every 15 seconds. Today's log was 39 MB because 572 of its 587 lines were
written before evidence 10's filtering (about 66 KB each).

Timed from the browser against the live host (2026-09-23, `fetch` round trip including transfer):

```
before (full re-parse on every call)
  /api-perf/stats?range=24h   221ms   41KB
  /api-perf/trend?range=24h   202ms  143KB
  /api-perf/stats?range=7d    168ms   41KB
  /api-perf/trend?range=7d    176ms  143KB

after (HistoryStore.summaries: parse once, then only the appended tail)
  round 1  /api-perf/stats?range=24h  132ms   4KB    <- first read parses the 39 MB file once
  round 1  /api-perf/trend?range=24h    7ms  33KB
  round 2  /api-perf/stats?range=24h    6ms   4KB
  round 2  /api-perf/trend?range=24h    7ms  33KB
  round 3  /api-perf/stats?range=7d     8ms   4KB
```

The payloads shrank because the cache drops all-zero rows from the old lines as it loads them, so the
ranking went from 219 rows (201 of them 0.0ms) to 18, and the trend from 219 series to 18.

Reproduce against a running host (PowerShell):

```powershell
foreach ($i in 1..3) {
  (Measure-Command { Invoke-RestMethod "http://127.0.0.1:3081/api-perf/stats?range=24h" }).TotalMilliseconds
}
```

The first call after a host restart pays the one-time parse; later calls should stay in single-digit
milliseconds until the log grows by more than a few windows.

---

## Evidence 13: CPU time must be charged at the achieved sample interval

Every absolute CPU figure (`cpuSelfMs`, ms/s, % of one core, cumulative core-time) is a sample count
times the milliseconds one sample stands for. The lens used the **configured** interval (250µs), but
on Windows the profiler tick floors at about 540µs whatever is requested
([design-overnight-analyzer.md §13.3](design-overnight-analyzer.md), probe 16). Read from the live
host's `/api-perf/snapshot` (2026-09-23, one duty window):

```
before (charged at the configured 0.25ms)
mode duty window 5000 samples 8969 active 101 achieved ms/sample 0.557 processCpuMs 454
harness samples 83 cpuSelfMs 20.75 => ms/sample 0.250 | at achieved rate 46.3
self samples 10 cpuSelfMs 2.5 => ms/sample 0.250 | at achieved rate 5.6
runtime:native samples 4 cpuSelfMs 1 => ms/sample 0.250 | at achieved rate 2.2
sum cpuSelfMs over rows 25.3 vs active*achieved 56.3

after (charged at the profile span / sample count, global.sampleIntervalMs)
mode duty window 5000 samples 9124 active 7459 sampleIntervalMs 0.567 (window/samples 0.548) processCpuMs 6204
harness samples 5487 cpuSelfMs 3108.87 => ms/sample 0.567
self samples 474 cpuSelfMs 268.56 => ms/sample 0.567
dsh-cost-meter samples 422 cpuSelfMs 239.10 => ms/sample 0.567
sum cpuSelfMs over rows 4226.2 vs active*interval 4226.2
```

Before the fix every absolute figure was about **2.2× too low** on this machine (and about 4.6× in
the background profile, which samples at 1000µs+ but was also charged at 0.25ms). Shares were
unaffected: they are ratios of sample counts. The interval now comes from the profile itself (V8's
`endTime - startTime` over the sample count, falling back to the window length), is published as
`global.sampleIntervalMs`, and is used for rows, the harness breakdown and hot functions alike.

Reproduce: divide any row's `cpuSelfMs` by its sample count
(`cpuShare × (sampleCount − idleSamples)`); it should equal `global.sampleIntervalMs`, and the rows
should sum to `(sampleCount − idleSamples) × sampleIntervalMs`.

---

## Evidence 14: worker threads are invisible to the host sampler

Source: `probes/20-worker-thread-blindspot.mjs`. A worker busy-loops for ~700 ms while the main
thread busy-loops for the same span, and one `inspector.Session` profiles the main thread throughout.
Run twice (2026-09-24):

```
--- probe 20: worker threads vs a main-thread CPU profile ---
wall clock                : 727 ms (main thread busy ~700 ms, worker busy ~700 ms)
process CPU actually used : 1406.0 ms  (193% of one core)
CPU time the profile saw  : 723.2 ms
main-thread samples       : 374
distinct frame urls       : 4
frames from the worker    : 0  <-- 0 means the worker is invisible
cpuConsumptionPercent     : 148.3  (>100 means more than one thread ran)
report.workers (live)     : []

--- probe 20: worker threads vs a main-thread CPU profile ---
wall clock                : 730 ms (main thread busy ~700 ms, worker busy ~700 ms)
process CPU actually used : 1438.0 ms  (197% of one core)
CPU time the profile saw  : 725.4 ms
main-thread samples       : 381
distinct frame urls       : 2
frames from the worker    : 0  <-- 0 means the worker is invisible
cpuConsumptionPercent     : 151.5  (>100 means more than one thread ran)
report.workers (live)     : []
```

**Conclusions:**
- An `inspector.Session` opened in the host thread profiles **that isolate only**. The profile captured
  ~723 ms of the ~1406 ms the process actually burned — the main thread's share, and **0 frames** from
  the worker.
- The process-level denominator **does** include the worker (`cpuConsumptionPercent` > 100 in both
  runs), so a plugin that moves work into a worker is counted in the total but attributed to nothing.
  Every per-plugin share and ms/s figure is then systematically low, with no marker saying so — the
  same failure mode as the ESM monkey-patch trap in [Evidence 3](#evidence-3-built-ins-imported-by-esm-name-cannot-be-monkey-patched),
  and a violation of hard constraint 4 (inexact metrics must carry a coverage marker).
- `process.report.getReport()` cannot even detect the situation: `workers` is `[]` while a worker is
  alive, so there is no free "a worker exists" signal.
- The host itself does spawn workers — `packages/session/session-persistence-jsonl/src/migration-verifier.ts`
  and the experimental `packages/experimental/inspector` bridge both use `new Worker(...)` — and any
  third-party plugin can. The gap is reachable, not hypothetical.
- The cheapest honest fix needs no new interception: the process CPU actually used per window is
  already known (`process.resourceUsage()` / `cpuConsumptionPercent`), so the residual
  `process CPU − attributed sample time − known runtime buckets` can be published as an explicit
  **"unexplained CPU"** figure. A sustained large residual is the signal that a worker (or native
  thread) is running.

---

## Evidence 15: an always-on async_hooks hook is too expensive for a live timer gauge

Source: `probes/21-async-hooks-cost.mjs`. Three workloads run with no hook, with an enabled hook
whose `init` does only what a live timer/handle counter would do (two `Set` lookups), and with the
same hook plus a stack capture per timer/handle. Median of three runs. Two runs (2026-09-24):

```
--- probe 21: cost of an always-on async_hooks hook ---
promise churn   off 8ms | hook 18ms (122.7%) | hook+stack 27ms (230.9%)
  runs off=11/8/8 hook=18/18/18
timer churn     off 7ms | hook 6ms (-9.0%) | hook+stack 688ms (10124.8%)
  runs off=16/7/3 hook=6/6/6
mixed           off 25ms | hook 30ms (23.7%) | hook+stack 394ms (1505.3%)
  runs off=18/25/25 hook=30/25/38

--- probe 21: cost of an always-on async_hooks hook ---
promise churn   off 7ms | hook 18ms (160.0%) | hook+stack 21ms (207.4%)
  runs off=9/7/7 hook=18/18/18
timer churn     off 7ms | hook 4ms (-40.5%) | hook+stack 635ms (8727.5%)
  runs off=12/7/7 hook=7/2/4
mixed           off 40ms | hook=32ms (-19.4%) | hook+stack 374ms (829.2%)
  runs off=26/40/41 hook=32/26/37
```

**Conclusions:**
- The one reproducible signal is **promise churn**: an enabled hook takes it from 7–8ms to 18ms in
  every run of both passes (≈2.3–2.6×). The timer-churn and mixed ratios swing between runs and must
  not be quoted individually.
- A stack capture per timer is far worse: 50 000 timers cost 635–688ms with the hook, i.e. about
  **13µs per timer**, against single-digit milliseconds without it.
- This is why `IoTracker` enables its hook only inside a sampling window, and why **per-plugin timer
  and handle counts are not shipped**: an always-on hook is a permanent +2.5× on promise-heavy work
  (worse than the +15–26% the profilers cost, hard constraint 3), while a window-scoped gauge would
  undercount every resource created between windows and read as a false zero.
- The cheap exact substitutes that did ship: **listener counts** read out of the cordis event
  registry (no hook at all), and a **process-wide** active-resource count from
  `process.getActiveResourcesInfo()`, which is native and needs no hook.

---

## Evidence 16: per-plugin listener counts need no patching

Source: `probes/22-listener-registry.mjs`, run against the real `@deepseek-ai/cordis` 4.0.4 from
this repo's `node_modules`. Two plugins register listeners; the probe reads the event service's
registry and attributes each record through the fiber map the plugin builds from loader entries.
Identical in both runs (2026-09-24):

```
--- probe 22: the cordis listener registry as an attribution source ---
root.events present          : true
registry exposes _hooks      : true
event names in the registry  : internal/listener, internal/update, session/event, tool/execute
session/event hook count     : 2
a hook carries ctx.fiber     : true
each plugin has its own fiber: true
fiber.name (display name)    : dsh-alpha
attributed counts            : plugin:dsh-alpha=2, plugin:dsh-beta=1
unmapped fibers are skipped  : 0 owners
```

**Conclusions:**
- `ctx.events` is the event service and its `_hooks` registry is readable from a plugin. Each stored
  record carries `ctx`, whose `fiber` is the plugin's own fiber — so the owning plugin is known
  **exactly**, with no wrapping of `ctx.on`, no prototype patch and no heuristic.
- Attribution lands on the same owner key the path index produces (`plugin:<moduleName>`), because
  both go through `ownerOfModule` in `plugin-index.ts`.
- A fiber that is not in the loader map is **skipped**, not guessed: an unmapped registry yields
  0 owners rather than a pile of misattributed listeners.
- This is why `PluginMetricRow.listeners` is exact while `timers` and `handles` are absent
  ([evidence 15](#evidence-15-an-always-on-async_hooks-hook-is-too-expensive-for-a-live-timer-gauge)):
  the mechanism that works needs no hook at all, and the mechanism that needs a hook does not work.
- Residual risk: `_hooks` is an internal field of cordis. `countListeners` returns `null` when it is
  missing or not an object, and the panel renders a gap — so a cordis rename degrades to "not
  measured" rather than to a false zero.

---

## Evidence 17: LoAF script attribution — where it works and what it resolves

Source: `probes/23-loaf-attribution.mjs` plus two throwaway scripts (kept in `.tmp/` during the
run): a same-origin proxy page driven in headless Chrome, and a combo reconstructor that
rebuilds the live 14-plugin batch from the on-disk plugin files per `buildComboScript`.
Environment: DSH Desktop 0.1.7-rc.2 (Electron 44, Chrome 152.0.7977.54), dsh web GUI at
http://127.0.0.1:19387 served from the npm-global dsh CLI.

### 17a. The desktop window withholds script attribution entirely

A `PerformanceObserver` of type `long-animation-frame` was installed in the DSH Desktop window
(`dsh-app://app/`, same plugins) and left running through real streamed answers, plus forced
long frames (a sourceURL-named busy loop of 180–200 ms):

```
{"frames":375,"withScripts":0,"streamingNow":2,"biggest":[5541,2377,2054,1855,1817]}
```

A raw frame from the forced busy loop (650 ms duration, 579 ms blocking, the script
unambiguously executed):

```
{"name":"long-animation-frame","entryType":"long-animation-frame","startTime":7349193.8,
 "duration":650.2,"renderStart":7349736.5,"styleAndLayoutStart":7349843.4,
 "blockingDuration":579.3,"scripts":[]}
```

**Conclusion:** on the `dsh-app://` custom scheme, Chromium reports long-animation-frame entries
but the `scripts` list is empty for every frame — even for frames whose blocking time is a
single named script. Script attribution is unavailable in the desktop window, so there the
panel keeps the correlation fallback. (The mechanism matches the spec: attribution is withheld
when the script is not same-origin with the observing window; resources loaded through the
custom protocol do not satisfy that check, and the page origin reads `dsh-app://app`.)

### 17b. Same-origin http attribution works, and the real combo registers end to end

Headless Chrome loaded a page that (1) stubs the module-loader queue, (2) loads the real
14-plugin batch combo — reconstructed byte-exactly from the on-disk plugin files, because the
live host answers combo requests only for script-load destinations (fetch gets 404) — and
(3) runs a 400 ms busy loop in a same-origin classic script:

```
registrations: 14
  registered: @deepseek-ai/dsh-client-ui-deliverables
  registered: @eddyskywalker/dsh-chatgpt-subscription
  registered: dsh-desktop-bridge
  registered: @wxg-prc-cpg/browser-skill-dsh-plugin
  registered: dsh-chat-import
  registered: dshmarket
  registered: @deepseek-ai/dsh-typert-registry
  registered: @deepseek-ai/dsh-client-connection
  registered: dsh-context
  registered: dsh-claude-style
  registered: @deepseek-ai/dsh-api-workspace-controller
  registered: dsh-cost-meter
  registered: @deepseek-ai/dsh-api-session-controller
  registered: @deepseek-ai/dsh-client-ui-directory-picker-native
frames captured: 1
frame dur 448 blocking 350 scripts 1
   {"url":"http://127.0.0.1:53190/busy.js","pos":0,"fn":"","inv":"classic-script","dur":400.1}
```

The reconstructed segment table (offsets in UTF-16 code units, `prepareComboSource(part)`
+ `;\n` per part in URL order):

```
[       0,   109282)  @deepseek-ai/dsh-client-ui-deliverables
[  109282,   478023)  @eddyskywalker/dsh-chatgpt-subscription
[  478023,   488290)  dsh-desktop-bridge
[  488290,   680615)  @wxg-prc-cpg/browser-skill-dsh-plugin
[  680615,   938777)  dsh-chat-import
[  938777,  1563980)  dshmarket
[ 1563980,  1616832)  @deepseek-ai/dsh-typert-registry
[ 1616832,  1676208)  @deepseek-ai/dsh-client-connection
[ 1676208,  2221303)  dsh-context
[ 2221303,  3254153)  dsh-claude-style
[ 3254153,  3274659)  @deepseek-ai/dsh-api-workspace-controller
[ 3274659,  3525899)  dsh-cost-meter
[ 3525899,  3670113)  @deepseek-ai/dsh-api-session-controller
[ 3670113,  3673108)  @deepseek-ai/dsh-client-ui-directory-picker-native
total bytes: 3673108
```

**Conclusions:**
- On an http origin, same-origin classic scripts appear in `scripts` with URL, char position,
  invoker kind and durations — the attribution the design needs. `dsh web` is an ordinary http
  origin, so the desktop window is the only blind spot.
- The reconstruction executes exactly like the served combo: all 14 bundles register in URL
  order under a queue stub, which also confirms no part throws before `dsh-claude-style`
  (segment 10 of 14) executes.

### 17c. Second capture on the desktop window, with a discriminating diagnostic

A second capture ran in the same desktop window through real streamed answers (the full JSON is in
the session archive; summary computed in-page):

```
DIAG {"frames":525,"withScripts":0,"maxBlocking":"410.4","iframes":0,
      "origin":"dsh-app://app","probeFrameScripts":0,"probeFirstURL":null}
```

`probeFrameScripts` comes from a fresh 300 ms busy loop executed in the page's main world with the
observer already attached: the frame it produced reported zero scripts, like the 525 streaming
frames before it. `iframes: 0` rules out nested browsing contexts as the cause, and the streaming
frames rule out devtools-injection artifacts (the page's own bundle code never appears either).

**Conclusions:**
- The suppression on `dsh-app://` is total and reproducible: two independent captures (375 + 525
  frames, blocking up to 410 ms during real streaming) and two forced busy loops all report empty
  `scripts`. The desktop window shows the correlation fallback, which the panel renders whenever
  the resolved row set is empty.
- The real `dsh web` http GUI could not be exercised in this environment: the two running
  instances require startup tokens that live in their starters' consoles. `probes/23-loaf-attribution.mjs`
  is the ready-made verification for any host where a token-bearing URL is available; given 17b
  (plain http attribution works in the same Chrome binary) the expected outcome is that `dsh web`
  attributes and the desktop window does not.

## Evidence 18: the scheduler probe resolves positions on the desktop window

The desktop jank probe (docs/design-desktop-jank-attribution.md) answers the question 17a-17c left
open: on `dsh-app://`, where long animation frames carry no `scripts`, a captured stack still names
the plugin. Measured on the live desktop window (DSH Desktop 0.1.7-rc.2, Electron 44,
Chrome 152.0.7977.54) with the probe installed at page load.

### 18a. The self-test caught a real defect on its first live run

The probe's self-test captures one stack from `dsh-perf-lens/client.js` at install time and ships
that raw position in every report; the host resolves it with the same code path as every other site
and requires the owner to be `self`. The first live run answered:

```
schedule.contract = "mismatch"
schedule.rows = [ { owner: "unresolved", scheduledMs: 88, calls: 802, maxMs: 1.1 } ]
latest.schedule.selfTest = { url: "plugins/??...,dsh-perf-lens/client.js,@deepseek-ai/...&rev=5e4a42cb882a",
                             line: 123526, column: 16 }
```

Two independent defects were behind it.

**The manifest was looked for in the wrong directory.** The loader anchors `baseUrl` at the resolved
ENTRY directory (`.../dsh-client-ui-open-in-app/lib/`, confirmed in the host's own
`/api-perf/diagnostics` owner rules), while `createClientSourceReader` read `package.json` from that
directory. Every part was therefore unreadable and the whole 58-part row collapsed into one unknown
segment. Walking up from the entry directory to the first manifest whose `name` matches the plugin
fixed it; the walk is required, not defensive, because the entry directory is a package's `lib/`.
(Asar-packed harness packages are readable from the host process: verified directly against
`resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-open-in-app/package.json`.)

**The probe's own construct trap was not recognized as its own.** After the reader fix the contract
still answered `mismatch` with a single row owned by `self`. V8 renders a Proxy trap as a qualified
method frame (`at Object.construct (...)`), and the own-frame filter compared the whole name against
`{ apply, construct, ... }`, so the first `plugins/` frame it met was the probe's own trap and every
construction attributed to perf-lens. Parsing the frame name and comparing its last dotted segment
fixed it.

### 18b. After both fixes, real plugins attribute

With the probe installed at page load and a synthetic DOM-churn storm driving the page, the host
resolved the report to:

```
schedule.contract = "ok"
schedule.rows = [
  { owner: "plugin:dsh-claude-style",                    scheduledMs: 60.5, calls: 365, maxMs: 0.7 },
  { owner: "self",                                       scheduledMs: 42.6, calls: 801, maxMs: 0.6 },
  { owner: "plugin:dshmarket",                           scheduledMs:  1.2, calls: 182, maxMs: 0.1 },
  { owner: "plugin:dsh-desktop-bridge",                  scheduledMs:  0.8, calls: 184, maxMs: 0.2 },
  { owner: "plugin:@eddyskywalker/dsh-chatgpt-subscription", scheduledMs: 0, calls: 1, maxMs: 0 },
]
latest.schedule.selfTest = { url: "plugins/??...,dsh-perf-lens/client.js,@deepseek-ai/...&rev=1dd0aff2c9a9",
                             line: 1690, column: 16 }
```

The position at line 1690 resolves to `self` through the byte-exact segment table built from the
58-part combo, and the other rows are the plugins' own registration sites in the same table. This is
the end-to-end proof that the origin supports per-plugin attribution from a captured stack. The
`self` row is the probe's own reporter tick, seen and charged to itself as design §3.8 requires;
its share was 2.3% of the window's CPU against the 15% warning threshold.

### 18c. What the measurement does and does not support

The synthetic storm is not the streaming scenario the acceptance criteria describe, so what is proven
is the *mechanism*, not a production load profile: positions resolve, real plugins attribute, the
self-test gates the table, and the probe's own cost stays inside budget. Two runs under the same
storm disagreed on which plugin held the largest share (60.5 ms `dsh-claude-style` in one, sub-ms
rows in the next), which is expected when the driven work is artificial and the real scheduling
happened at startup.

A plain sample of consecutive vitals windows, with no synthetic work driven at all, still carried
plugin and harness rows as the page was in ordinary use:

```
window A  harness:@deepseek-ai/dsh-api-session-controller  0.2 ms / 380 calls
window B  harness:@deepseek-ai/dsh-api-session-controller  9.9 ms / 358 calls
          plugin:@wxg-prc-cpg/browser-skill-dsh-plugin     0.0 ms /   9 calls
window C  plugin:dsh-desktop-bridge                        0.2 ms /   1 call
```

Every row in those windows came from callbacks the plugins themselves re-register as work arrives
(a 380-call site in the session controller is a poll, not a one-off), which is the population this
feature exists to rank. The figures are small in these windows because the page was idle between
tokens; the columns are what the acceptance criteria require, and the ranking is what a heavier
stream would exercise.

The switch therefore reloads and remembers. The installed plugins register during their own
`apply()`, so a probe enabled after load sees nothing until the page reloads with the choice already
stored; `apply()` now installs from that stored choice before the other plugins run. An idle page
after such a reload reports only perf-lens's reporting tick, which is the honest reading: nothing
else is scheduling.

**Conclusions:**
- Attribution from a captured stack works on `dsh-app://`. The mechanism needs no Document-Policy
  change, no debugger port, and no engine patch; positions resolve through the same segment table the
  LoAF path already builds, now extended with a line-start index.
- The self-test is load-bearing, not ceremony: it found two real defects on its first live runs, and
  the panel withheld the rows both times instead of publishing a wrong table.
- The columns are registrar-scoped by construction. A row means "the page spent this long inside
  callbacks registered at this position", never "this plugin caused the jank", and the panel and
  README both say so.
