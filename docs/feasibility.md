# Feasibility: a plugin performance panel for DSH

> Researched: 2026-09 (Windows / Node v24.18.0 / @deepseek-ai/dsh 0.1.7-alpha.1 and 0.1.5-rc.2)
> Status: **confirmed and implemented** (Phase 1 and Phase 2 have shipped; see the README changelog).
> Every mechanism below is backed by measured output in [evidence.md](evidence.md).

---

## 1. Conclusion

**Feasible, with one hard limit.** The DSH host is a **single process**, so there is no
operating-system truth such as "RSS per plugin".

What works is **in-process sampling attribution**:

1. Sample CPU and heap allocation with `node:inspector`, and walk each sample **up the call
   stack to the nearest plugin frame**.
2. Count each plugin's file operations with `async_hooks`, **without patching anything**.
3. Build a "module path → plugin" map from `ctx.loader.entries()`.
4. Show the result in the Web GUI.

CPU, memory allocation and retention, file operation counts, the plugin inventory and the panel UI
all have a reliable mechanism behind them.

**The one real compromise is per-plugin disk bytes.** Operation counts can be attributed exactly;
byte counts cannot be measured exactly without intrusive interception. See
[§6 Limits](#6-limits-the-ui-must-state-them).

---

## 2. Runtime facts (verified)

| Item | Observed |
| --- | --- |
| GUI host | PID 28108, `node .../@deepseek-ai/dsh/lib/bin.js web --port 3081` — a **plain Node process**, not Electron |
| Node version | v24.18.0 |
| Host RSS | ~680 MB (one process carries every host plugin) |
| Installed plugins | `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json`: `dsh-base`, `dsh-web-app` and 13 third-party bundles |
| Plugins are enumerable | `ctx.loader.entries()`. The harness's own `@deepseek-ai/dsh-plugin-inventory` does exactly this with `inject = ['loader']`, and gets `moduleName`, `entryId`, fiber state and the resolution anchor `baseUrl` |
| Build output | Each plugin ships its own bundled `lib/index.mjs` (host) and `lib/client.js` (single-file client bundle), so module URLs map one-to-one onto plugins and attribution stays clean |

Because the host is plain Node, `node:inspector`, `v8`, `async_hooks` and `process.resourceUsage()`
are all available, and **no `--inspect` port is needed**: an in-process `new inspector.Session()` is
enough.

> DSH Desktop (Electron) runs the host in the Electron main process, where the same APIs exist. The
> conclusions hold for both.

---

## 3. Mechanism by mechanism

### 3.1 CPU attribution — works

`inspector.Session` → `Profiler.enable` / `start` / `stop` returns a Chrome CPU profile:
`nodes[].callFrame.url`, `nodes[].children` and the `samples[]` ticks.

Mapping URLs to plugins by prefix gives each plugin's CPU share. The profile separates modules
correctly:

```
CPU self-time by frame url:
     65  /D:/Build/Temp/feas-inspector.mjs
     17  (native)
      1  node:inspector
```

### 3.2 Memory attribution — works, at two levels of detail

- **Allocation and retention sampling:** `HeapProfiler.startSampling` / `stopSampling` return a tree
  with `callFrame`s whose nodes carry `selfSize`. `stopSampling` reports the sampled objects that are
  **still alive when sampling stops**, which is already a "retained bytes by allocation site" signal.
  That is more useful than a raw allocation rate: it tells "allocates a lot but frees it" apart from
  "actually leaks or stays resident".
- **Exact retained size:** `v8.writeHeapSnapshot()` exists and can be parsed offline (so can
  `HeapProfiler.takeHeapSnapshot`).
- **Process totals:** `v8.getHeapStatistics()`, `process.memoryUsage()` and
  `process.report.getReport()` (with `rss`, `maxRss`, `pageFaults`, `cpuConsumptionPercent`).

Heap sampling aggregated by URL:

```
Allocation self-size by frame url (bytes):
       4144  /D:/Build/Temp/feas-inspector.mjs
```

### 3.3 The deciding experiment: attribution must walk the ancestor stack

Two fake plugins share one dependency module and call it 200 and 60 times. Two attribution
strategies compared:

```
direct (self-frame) attribution:      ancestor-walk attribution:
   573  (shared/other)                   441  pluginA
     1  pluginA                          131  pluginB
                                          2  (unattributed)
```

- **Attributing by the frame itself:** 573 of 574 samples land in the "shared dependency" bucket,
  which belongs to nobody. Attribution effectively fails.
- **Walking up parent nodes to the nearest plugin frame:** 441 : 131 = 3.37 against a true ratio of
  200 : 60 = 3.33, an error under 1.5%.

> **This is the core design point of the whole approach.** Attribution must walk the stack to the
> nearest plugin frame, not ask which file a function is defined in. It also settles who pays for a
> plugin's `node_modules`: **the calling plugin does**. Otherwise any plugin with dependencies (for
> example `dsh-chat-import`, which depends on `fzstd`) would pass its cost on to them.

### 3.4 Disk I/O — three layers, each weaker than the last

#### Layer 1: process-wide operation counts (exact, no dependencies)

On Windows, `process.resourceUsage().fsRead / fsWrite` gives **exact process-wide read and write
operation counts**:

```
resourceUsage before: {"fsRead":1,"fsWrite":0}
resourceUsage after : {"fsRead":21,"fsWrite":20}
delta fsRead: 20  delta fsWrite: 20     ← exactly the 20 writes + 20 reads
```

`process.report.getReport().resourceUsage.fsActivity.{reads,writes}` is the same data, plus `rss`,
`maxRss`, `pageFaults` and `cpuConsumptionPercent`.

**These are operation counts, not bytes.**

#### Layer 2: per-plugin operation counts (exact, no patching)

`async_hooks` `init(asyncId, type)` plus an `AsyncLocalStorage` marking the current plugin:

```
per-owner fs async-resource counts:
    2  pluginA :: FILEHANDLECLOSEREQ
    7  pluginA :: FSREQPROMISE
    2  pluginB :: FILEHANDLECLOSEREQ
    4  pluginB :: FSREQPROMISE
```

Asynchronous file operations can be counted per plugin **with no monkey-patching at all**.

Limit: `readFileSync` / `writeFileSync` **create no async resource and are not counted**. They are
covered instead by walking the ancestors of `node:fs` frames in the CPU profile (approximate counts,
correct ownership).

#### Layer 3: bytes (needs interception, costly)

Bytes require intercepting the call sites, and there is a **silent failure trap** here. Patchability
of an ESM built-in, measured:

```
fs.readFileSync 被替换后 → ns readFileSync patched? true
命名导入是否看到补丁？      → named-import saw patch: NO
```

(The two labels read "after replacing fs.readFileSync" and "does the named import see the patch?".)

The binding in `import { readFileSync } from 'node:fs'` is captured when the module is instantiated,
so **a runtime monkey-patch of `fs` is silently bypassed by ESM named imports**.

> Patching the `fs` module therefore only reaches CommonJS call sites and property access on the
> default import, and **does nothing** for the ESM named imports most plugins use. A tool built
> without knowing this reports data that **looks normal but is systematically low** — more dangerous
> than an error.

There are only two real routes to exact bytes:

| Approach | Coverage | Risk |
| --- | --- | --- |
| Wrap the `ctx.fs` service (the `FileSystem` base class in `@deepseek-ai/dsh-fs`) | Only I/O that goes through the harness | Low, but incomplete |
| A `module.register()` loader hook that rewrites the `node:fs` specifier | Modules imported after ours | Changes function identity, conflicts with self-patching libraries such as `graceful-fs`, and depends on plugin load order |

**Recommendation:** no byte-level interception in v1. Wrap `ctx.fs` to get exact bytes for
harness-mediated I/O and mark the rest as uncovered. Keep the loader hook as an opt-in deep mode for
Phase 3.

### 3.5 Other available signals

| Signal | Mechanism |
| --- | --- |
| Per-plugin timers, listeners, open handles | Wrap `ctx.setInterval` / `ctx.setTimeout` / `ctx.on`, or count by fiber ownership |
| Event-loop delay | `perf_hooks.monitorEventLoopDelay()` |
| GC pauses | `gc` entries from `PerformanceObserver` |
| Per-plugin disk footprint (exact bytes) | Scan `$DSH_HOME/**` and workspace directories with a "path → owning plugin" map |
| Plugin lifecycle | Fiber phase, load order, HMR reload count |
| CDP port | Can be opened for external debugging, but this approach does not need one |

---

## 4. Measured overhead (sets the default strategy)

| Workload | CPU profiler at 1000µs | Heap sampling at 32KB | Both together |
| --- | --- | --- | --- |
| Pure compute microbenchmark | +7% to +23% | ~0% (within noise) | **+15% to +26%** |
| Mixed async + file I/O | ~0% (can be negative) | ~0% (can be negative) | ~0% to +12% |

Raw output:

```
--- compute-bound ---                      first run
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

A second run of the same script put `both` at **+25.8%** on the compute workload; the mixed async
workload stayed within noise.

**How to read this:** these are microbenchmarks and the absolute percentages swing a lot (the
async + I/O workload even goes negative, because I/O waits swamp the sampling cost). Only one trend
reproduces reliably: **on a compute workload, running both samplers is always the most expensive
option**. Design decisions should rest on that trend, not on any single number.

**Consequence:** dual sampling cannot stay on. The design must have:

- duty-cycle rotation (for example sample 5s, pause 30s);
- deep sampling on demand (dual sampling only when the user asks for it);
- a way to stop at any time;
- **self-frame exclusion** (dsh-perf-lens's own module paths must be removed from attribution, or
  the tool amplifies itself).

Also: calling `Profiler.stop` when nothing is recording throws
`Inspector error -32000: No recording profiles found`, so the state machine must keep start/stop
strictly paired.

---

## 5. Panel and integration (every piece has an existing pattern)

### 5.1 Host side

An ESM plugin exporting `name` / `inject` / `apply`.

`webServer` is an **optional, late-mounted** host service. It has to be injected lazily and must not
go in the `inject` array, or the whole plugin fails to activate in a headless profile:

```js
ctx.inject(['webServer'], (webCtx) => {
  registerRoutes(ctx, webCtx.webServer)
})
```

Route API: `ws.register({ kind: 'exact' | 'prefix', path, handler }): () => void`.

This is the same shape as `/api-import/*` in `dsh-chat-import` and can be copied directly.

### 5.2 Client side

- A single `lib/client.js`, loaded through `window.__ModuleLoader__.load({ id, factory })`.
- `package.json` declares `dsh.client.inject` and `dsh.client.platform = "web"`.
- Inside the factory, `require("react")`, `require("react-dom")` and
  `require("@deepseek-ai/dsh-client-ui-primitives")` are available.
- Slot registration: `ctx.slots.inject(slotName, () => ctx.slots.register(...))`.

**Panel location:** this study proposed a right-sidebar tab (`sidebar.right.pane.tab`). The
implementation settled on a `sidebar.panellist` entry that opens a full main-column panel instead;
see [design.md §3.1](design.md#31-where-the-panel-lives).

Relevant slots:

| Slot | Use |
| --- | --- |
| `sidebar.panellist` + `main` | **Used**: a left-nav entry that opens the full dashboard |
| `sidebar.right.pane.tab` | Always-visible right sidebar; kept as an option for a compact view |
| `settings.section` | A settings-page section, suited to a full analysis page |
| `sidebar.footer.action` | A footer action button |

> Client bundle constraint: the DSH client module loader has no relative `require` and no asset
> URLs, so a plugin's browser output must be **one self-contained file**. Source can be split, but
> the build has to join it back into a single file (`scripts/build-client.mjs` in `dsh-chat-import`
> is the reference implementation).

### 5.3 Distribution

One row in `cordis.patch.yml`:

```yaml
- insert:
    - id: perf-lens
      name: dsh-perf-lens
```

---

## 6. Limits (the UI must state them)

These belong in the panel's coverage / confidence markers. **Otherwise the tool becomes a new source
of misleading numbers** — the biggest product risk of this approach, larger than any technical risk.

1. **There is no per-plugin RSS.** Only process RSS plus each plugin's **sampled** retained heap
   bytes. The two are different quantities and cannot be added up against each other.
2. **Per-plugin disk bytes are not exact.** Operation counts are attributed exactly; bytes exist only
   for what `ctx.fs` covers, and the rest must be marked uncovered.
3. **Browser memory cannot be attributed.** It lives in another process; only renderer-wide figures
   are available.
4. **Child processes are out of scope.** `dsh-subprocess-local/runner.js`, node-pty and LSP servers
   are separate PIDs. v1 covers plugin frames inside the host process only; those processes would
   need process-level sampling of their own.
5. **Sampling is statistics.** Short windows are noisy, so the panel must show the window length and
   the sample count.
6. **Long Animation Frame attribution covers script execution only.** LoAF (Chromium 123+) names the
   script and its forced style/layout cost; layout, paint and compositing no script forced stay in
   the frame-level totals. Multi-plugin combo bundles resolve through deterministic segment offsets,
   and the attributed share is always shown alongside. The DSH Desktop window (`dsh-app://`)
   withholds the scripts list entirely (measured, evidence 17a), so this is a `dsh web`-only
   capability.

---

## 7. Ecosystem survey

There is **no plugin that attributes host CPU, memory or disk cost to individual plugins**. The niche
is empty.

The reasoning was re-checked on 2026-09-24 and is stale as originally written: the `dsh-plugin` topic
now holds ~16 000 repositories and a dozen adjacent performance plugins exist — machine-level monitors,
static plugin scorecards, process-level OpenTelemetry / Pyroscope exporters
(`dsh-runtime-observability`, `dsh-o11y-plugin`), a plugin-bisection tool
(`dsh-performance-guard`), client-side per-plugin render attribution (`@linxin666/dsh-perf`) and
per-plugin *data* attribution (`dsh-audit-log`). None of them crosses into per-plugin host resource
cost, because that requires the inspector-based stack walk in §3.3.

The full market survey, the closest analogues in other ecosystems (spark, the VS Code extension-host
profiler, Bukkit Timings, Chrome/Firefox per-extension accounting, continuous profilers), the
published overhead figures and the borrow list live in
[landscape-survey.md](landscape-survey.md).

---

## 8. Suggested phases

### Phase 1 (MVP, low risk)

Plugin inventory, process totals (RSS / heap / event-loop lag / GC), per-plugin CPU sampling,
retained-heap sampling, file operation counts, timer/listener/handle inventory, and a sortable panel
table.

Mostly wiring: every mechanism has been measured.

### Phase 2

Time-series history (ring buffer plus optional JSONL on disk), on-demand heap snapshots and deep CPU
profiling, a per-plugin detail view (hot functions, allocation sites, files touched) and report
export.

The bulk of the work is **offline heap-snapshot parsing** and attribution quality (bundled plugins,
worker threads, async boundaries).

### Phase 3 (opt-in deep mode)

Byte-level disk I/O through a `node:fs` loader hook, child-process sampling and renderer metrics.

Highest risk; off by default and labelled experimental in the UI.

---

## 9. What this replaces

The one-off benchmark scripts in `dsh-context/.tmp/probe/probe.mts` (replaying a local session corpus
and timing CPU module by module) are exactly what this plugin replaces. Their method is worth
keeping:

- isolate measurements per module and per event type;
- warm up the JIT, repeat runs and take the median;
- write reports as JSON for later comparison.

The difference: this plugin is **always on**, measures the **real runtime** rather than an offline
replay, and answers "which plugin" rather than "which function".
