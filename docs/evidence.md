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
