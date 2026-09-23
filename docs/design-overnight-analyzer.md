# Background analysis architecture (out-of-process analyzer)

> Status: **research record.** It asks one question: can the main form become "continuous background
> analysis, with a child process doing the heavy lifting", where are the limits, and what would exact
> per-plugin memory shares take?
>
> Outcome: §12 is the conclusion. The heap-snapshot route was measured on a real host and rejected
> (§11). The two-tier sentinel (§13.7) and deep-mode async attribution (§13.8) have shipped; the
> process split itself (§2, §6) has not been built.
>
> This document does not change the conclusions of `docs/design.md` or `docs/feasibility.md`; where
> it disagrees with them (§7) the author decides.

---

## 1. Goals and budget

The author's target shape and budget:

| Tier | Trigger | Budget (host overhead) |
| --- | --- | --- |
| Passive (always on in the background) | default | ≈ 10% |
| Active | the user opens the dashboard or asks for an exact analysis | ≈ 30% |

Constraint: **do not disturb the host process.** "Disturb" means two different things:

1. **CPU and memory use** — budgeted at 10% / 30%, quantifiable and measurable (§4).
2. **Stop-the-world pauses** — outside any budget. An operation that uses 3% CPU but pauses for 800ms
   still interrupts the host's event loop. **This is the only hard limit in this design** (§5).

---

## 2. Why split the process

In a single process, sampling, aggregation, history writes, statistics, trends and hot-function
tables all run on the host thread; the duty cycle in `docs/design.md` exists to spread that cost
thin.

What a split could move out:

| Work | Today | After the split | Notes |
| --- | --- | --- | --- |
| Inspector sampling control | host | **must stay in the host** | The V8 inspector can only observe the heap and stack of its own process |
| Sampling tree → per-plugin aggregation | host `lens.#build` | child | One tree walk per window |
| History JSONL writes / pruning | host `history.ts` | child | Moves disk I/O out of the host entirely |
| Range statistics / trend buckets | host `stats.ts` | child | Grows more expensive as history grows |
| Hot-function aggregation | host `hotspots.ts` | child | Frame-level data is never persisted anyway |
| Heap-snapshot parsing / dominators / retained size | not built | child | The heaviest part; see §5 |

**All that stays in the host:** one inspector session, the per-tier sampling switches, and writing
profile results (or snapshot chunks) out. All three are cheap.

Data flows **one way**: host → child (sampling results, owner rules, control commands) and child →
host (only health status and pre-aggregated dashboard snapshots). Dashboard queries keep using the
host's existing routes, which fetch pre-aggregated results from the child instead of moving raw
samples back.

---

## 3. Host side: tier settings

Sampling cost comes from two knobs whose **cost mechanisms are entirely different**:

- `Profiler.setSamplingInterval(µs)`: cost ∝ **sampling frequency** (a timer interrupt plus a stack
  walk), independent of the workload.
- `HeapProfiler.startSampling(samplingInterval)`: cost ∝ **allocation rate** (sampling by average
  byte interval), independent of wall time. On a pure-compute workload that allocates nothing it is
  almost free (measured in §4).

So a tier is not one switch but a combination of two parameters:

| Tier | CPU profiler | Heap sampling | Measured host overhead |
| --- | --- | --- | --- |
| Passive | 5ms | 256KB | +0.5% to +2.0% |
| Passive+ | 1ms | 256KB | +1.2% to +3.7% |
| Active | 250µs | 32KB | +3.2% to +6.7% (worst run +9.4%) |

Even the most aggressive tier is far below the 10% budget. (See §10.0: the budget is a ceiling, not
a target.)

The host also needs a self-reported **overhead** figure, and there is a newly measured trap: on this
machine `process.cpuUsage()` is quantized to about **15.6ms** (`probes/08-cpu-clock-quantization.mjs`:
a 5.7ms loop reads either `0` or `16ms`). So:

- The CPU delta of one sampling window cannot measure the plugin's own overhead; the real cost inside
  the window quantizes to 0.
- Self-reported overhead must come from **deltas over a long baseline** (for example 60s).
- *Review correction:* the draft's suggestion, `process.resourceUsage().cpuConsumptionPercent`,
  **does not exist** (the measured resourceUsage key set has no such field). The right substitute is
  a `perf_hooks.eventLoopUtilization()` delta: millisecond resolution and unaffected by the 15.6ms
  quantum. The production `selfShare` is computed from profile samples (lens.ts) and never uses
  cpuUsage, so this trap does not affect the current implementation; it only constrains a future
  self-reported metric.

---

## 4. Measured: host sampling overhead

Probe: `probes/09-sampler-cost-matrix.mjs`. The table shows the **range** over three independent runs
(not single values).

Method: a fixed-work workload, control and treatment interleaved, median of 5. Wall time is used
rather than CPU time because the 15.6ms quantization in §3 makes CPU deltas unusable on this machine
— **a methodological limit, not a preference**.

```
baseline                       overhead   -3.1% ~ +4.1%      <- noise floor about ±4%
Profiler 10000us               overhead   -1.0% ~ +3.2%
Profiler 5000us                overhead   +0.7% ~ +3.4%
Profiler 1000us                overhead   +0.7% ~ +4.9%
Profiler 250us                 overhead   +2.2% ~ +9.4%      <- the only stable monotonic signal
HeapProfiler 256KB（纯计算）    overhead   -0.6% ~ +1.5%
HeapProfiler 32KB（纯计算）     overhead   -1.5% ~ -0.1%
background cpu5ms+heap256KB    overhead   +0.5% ~ +2.0%
background cpu1ms+heap256KB    overhead   +1.2% ~ +3.7%
active cpu250us+heap32KB       overhead   +3.2% ~ +6.7%
alloc + heap 32KB              overhead   +0.1% ~ +2.8%
```

(纯计算 = pure compute.)

How to read it:

1. **The noise floor is ±4%.** Differences below it mean nothing, and a negative value is not a
   speed-up.
2. The only reproducible monotonic trend: **CPU profiler cost rises with the sampling rate** (250µs
   is clearly dearer than 10ms).
3. **Heap sampling has no fixed cost on a pure-compute workload**, as the mechanism in §3 predicts
   (it charges per allocation).
4. This **disagrees** with evidence 8's "+15% to +26% for dual sampling". Evidence 8 is a single
   microbenchmark that itself recorded a large swing (+15.1% / +25.8%); in these three runs dual
   sampling peaked at +6.7%. **Conclusion: the numeric basis of hard constraint 3 in `AGENTS.md`
   should be re-examined**; see §7.

---

## 5. Exact memory shares: snapshots are the only route, and they pause the host

### 5.1 Mechanism facts

- `HeapProfiler.startSampling` only counts allocations **made after sampling starts**, and only keeps
  objects **still alive when it stops**. A large cache that was resident before the window is
  **invisible**.
- The sampling tree has only `selfSize` (shallow size), no retained size, and shared objects are
  counted more than once.
- `v8.getHeapSnapshot()` / `HeapProfiler.takeHeapSnapshot` give the **full object graph**; only an
  offline dominator-tree pass can say "this plugin exclusively holds this many bytes". That is the
  only exact route.
- Streaming to disk is the documented way (the Node docs' heap-profiler example listens for
  `HeapProfiler.addHeapSnapshotChunk` and writes each chunk to a file), so **the host never needs to
  hold the whole snapshot in memory**.
  Note: never pass `reportProgress: true` to `takeHeapSnapshot`. *Review correction:* on Node v24.18.0
  this is not a polite refusal but a **process crash** (0xC0000005 access violation; the host dies).
  Code must hard-block that parameter from ever coming through configuration. Without it, chunk
  events stream in and work normally (measured).

### 5.2 Measured: snapshot cost and child-process parsing cost

Probe: `probes/10-heap-snapshot-and-analyzer.mjs` (Node v24.18.0).

```
堆规模         668MB heapUsed（真实 JS 堆：310k 节点 / 957k 边）
生成快照       wall 760ms   cpu 828ms   ← 发生在主进程，是停顿
快照文件       19.7MB

子进程侧（生成之后的全部工作）
  read 19.7MB text          39ms
  JSON.parse                50ms
  typed-array graph         26ms
  dominator tree (LT)       73ms     <- 309,889 个可达节点
  attribution walk          87ms
  合计 wall 286ms  cpu 390ms  peak rss 806MB
```

(Heap size 668MB heapUsed — a real JS heap of 310k nodes / 957k edges; taking the snapshot: wall
760ms, cpu 828ms, a pause in the host; snapshot file 19.7MB. Child side, everything after the
snapshot: 309,889 reachable nodes; total wall 286ms, cpu 390ms, peak RSS 806MB.)

> The file is only 19.7MB for a 668MB heap because this synthetic heap is almost all long strings,
> stored once in the snapshot and referenced by nodes. **File size does not predict parsing cost**;
> the analyzer's 806MB peak is the real memory need (on the order of the heap, not the file).

Conclusions:

- **Parsing, graph building, dominators and attribution are all cheap** (hundreds of milliseconds)
  and fit in a child process; its 806MB peak does not touch the host.
- **What is expensive is taking the snapshot, and that cannot move**: V8 can only snapshot the heap
  in the process that owns it. The synthetic 668MB heap took about 760ms (1.1ms/MB). *Review
  correction:* that figure **does not extrapolate** — see §11: on the real host a 350–370MB heap
  paused for **8.7–10.3 seconds (25–30ms per heap MB)**, about 25× worse. The right cost unit is
  µs per node (≈ 2.7); real heaps are far denser in nodes than this synthetic one.
- Hence the **central trade-off** of this design as first proposed: **exact shares can only be taken
  rarely** (on demand, or every 10–30 minutes), extrapolated from the sampling tree in between; the
  snapshot frequency must be an explicit setting, and the UI must say "this exact analysis will pause
  the host for about N ms". (§11 later rejected the route altogether.)

### 5.3 Attribution semantics: by retainer path, not allocation site

Attributing CPU by where code runs is right (whoever executes pays). Attributing memory by allocation
site is **wrong**:

- an object a plugin allocates and hands to the harness to keep is charged to the plugin;
- an object the harness allocates on a plugin's behalf is charged to the harness;
- a shared cache belongs to "whoever referenced it first", which is arbitrary.

The right approach walks the object graph from the GC roots and charges each object to **the nearest
plugin on its retainer path**. In the probe, one reverse-DFS propagation is enough (O(V+E), no
per-object stack), 87ms on 310k nodes — negligible.

**But this changes how the numbers read:** by retainer, a shared cache always ends up with some
plugin, so the UI must flag the dispute or split by the number of referrers.

*Overturned by measurement:* §11 checked this on a real host snapshot. A real heap **has no**
recognisable "plugin root": identity exists only in string and code nodes (not object names), and
every candidate anchor has a retained size of about 0. Retainer-path attribution **cannot be built as
this section imagines**; it would need injected anchors (§11.3).

### 5.4 A continuous approximation besides snapshots

Between snapshots, **diff the sampling tree across windows**:

- Keep the sampler running and read the tree periodically with `HeapProfiler.getSamplingProfile`
  (verified available on Node 24; see §9). The fallback would be `stopSampling` and an immediate
  `startSampling` per window, and §4 shows rebuilding the tree is cheap.
- The child diffs consecutive trees: growth in `selfSize` = net retention growth at that allocation
  site. That is a more diagnostic signal than a single window's absolute value (it separates
  "allocates but frees" from "actually growing").
- This is still **new allocation inside the window** and blind to objects resident before it. So
  `liveHeapBytes` must carry coverage (`sampled bytes this window / process heapUsed`) and, per hard
  constraint 4, read as `≥ N (x% coverage)` — never as the plugin's memory footprint.

---

## 6. Components

```
Host process (DSH host)
  ├─ inspector session ── Profiler / HeapProfiler ── sampling control (the part that cannot move)
  ├─ serialise sampling results ──> pipe (one way)
  ├─ push owner rules (incrementally on plugin load/unload; the child needs no ctx.loader)
  └─ routes: /api-perf/* read pre-aggregated results from the child

Analyzer process (utilityProcess / child_process, same Node version as the host)
  ├─ sampling-tree aggregation + attribution (ancestor walk / retainer path)
  ├─ window diffs → allocation rate, net retention growth
  ├─ history JSONL reads, writes and pruning
  ├─ range statistics, trend buckets, hot-function tables
  └─ on demand: snapshot parsing → dominator tree → retained size → exact per-plugin shares

Temp directory
  └─ <tmp>/dsh-perf-lens-<pid>-<ts>.heapsnapshot   streamed in, deleted after parsing
```

Choices:

- Prefer `utilityProcess` (it has proper process semantics under Electron and reuses Node's fork
  semantics); under plain Node, `child_process.fork` is equivalent.
- The pipe protocol is length-prefixed JSON lines. **One way** is enough; no two-way RPC.
- A child crash must not affect sampling: the host's sampling loop is independent of the child's
  lifetime. When the child exits, the host keeps sampling and restarts the analyzer with backoff.
- Snapshot files go to a temp directory and are **deleted after use**. `.gitignore` already has a
  `*.heap.heapsnapshot` rule, a sign this route had been considered before.

---

## 6.5 Harness attribution audit: the 75% is a share illusion, not a cost

The observation "the code attributes a large share of cost to the harness core" was audited against
**real history**. Verdict: **the attribution is right; the metric is misleading.**

Data: the two JSONL files in this machine's `$DSH_HOME/perf-lens` (743 windows / 2746 sampled seconds
/ 92.9% idle), audit script `probes/12-history-share-audit.mjs`.

| Measure | harness | Notes |
| --- | --- | --- |
| `cpuShare` (share of active samples, the panel's headline) | peak 93.6%, mean 61–75% | denominator is `sampleCount - idleSamples` |
| **Absolute cost** `cpuMs / sampled second` | **7.5 ms/s ≈ 0.75% of one core** | all 200+ harness packages combined |

In the same data the most expensive owner was actually `runtime:*` (41.7 ms/s ≈ 4.2% of a core),
followed by `harness:@deepseek-ai/dsh` (3.1 ms/s) and **`self` (2.8 ms/s — this plugin)**. In a live
window (`/api-perf/snapshot`) harness showed a **53.7%** share while its `cpuSelfMs` was only
**18.25ms per 5000ms window** = **0.37%** of one core. Share and absolute cost differ by **two orders
of magnitude**.

Root cause: 92.9–95.8% of the host's samples are `idle`, leaving `cpuShare` a denominator of only
4–7%. On an idle host, anything that ran for a few ticks shows up at 90%+. This is not an attribution
bug — **the audit found no systematic attribution problem**:

- All 215 owner rules resolve to `.../@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/lib/`;
  external plugins (`~/.dsh/<plugin>`) are not swallowed by the harness prefix.
- A live window's `ownerKeys` contained `harness:@deepseek-ai/dsh-client-hmr`, `plugin:dsh-cost-meter`,
  `plugin:@michengai/...` and `runtime:gc` together, so all three owner kinds work.
- The mechanisms are locked in `test/attribution-scenarios.test.ts` (external plugins are not
  swallowed, a plugin frame under harness wins, a plugin dependency deferred into a harness callback
  is charged to harness, GC is never charged to harness).

### The three real fixes (all presentation, none algorithmic)

1. **Folding harness hid the answer.** Before folding (the 555 windows before 09-23 02:19) the
   ranking was clear: `dsh-client-hmr` 1.34 ms/s (49.8% share, 96.7% peak), `dsh-subprocess-local`
   1.47 ms/s, `dsh` itself 3.05 ms/s. After folding only one `harness` row remained, deleting the one
   useful piece of information — which package is expensive. Proposal: keep the folded row but list
   the sub-packages by absolute cost, top N, with the rest as `harness (other)`.
2. **Share must sit next to absolute cost.** A bare `cpuShare` invites optimising something that
   costs 0.75%. Proposal: add a `cpuMs/sampled-sec` (`cpuMsPerSecond`) column, and when the idle
   share is high, say at the top "this window was 96% idle; the share denominator is small". This is
   the same kind of problem as hard constraint 4: a conditional number must not be shown as if it
   were unconditional.
3. **`self` deserves its own look.** At 2.8 ms/s it is the third-largest absolute cost, larger than
   most harness packages, and it is this plugin's own sampling and analysis. It is within budget
   (§4), but if we are comparing who eats CPU, our own 2.8 ms/s should be drillable to function level
   like any other owner (hot functions then covered only `plugin:*`; see the `owner.kind === 'plugin'`
   filter in `src/host/hotspots.ts`).

### Implementation status (2026-09, same day, all done)

- ✅ **1: harness sub-packages.** `PerfSnapshot.harnessBreakdown` carries the top 10 sub-packages
  (`DEFAULTS.harnessBreakdownLimit`), built by `lens.#harnessBreakdown` from the **raw** owner counts
  (the `harness:<pkg>` keys before folding) and sorted by absolute CPU. The folded row stays as the
  summary; the sub-packages are indented beneath it in the detail table and **expanded by default**
  (folding is what hid the answer). They exist only in the live snapshot: `history.serializeSnapshot`
  drops them, so each persisted window still has one `harness` row.
- ✅ **2: share next to absolute cost.** Cards, the detail table and the ranking all show "% of one
  core" and `ms/s`; the process overview explains the small denominator when idle share ≥ 0.8.
- ✅ **3: hot functions for `self` and harness.** `aggregateHotspots` now builds a table for **every
  attributable owner** (`ownerKey(owner)`, excluding only idle/unattributed), and `HotspotStore.get`
  looks up `plugin:<name>` first and then the raw key. So the `self` row and every harness
  sub-package row expand to function level, while the folded `harness` row (an aggregate) has no table
  of its own — which makes it the diagnostic entry point for mechanism C.
- ✅ **Trend axis: absolute.** `PerfTrendSeries.cpuMsPerSec` is computed by `aggregateTrend` from each
  bucket's **sampled wall seconds** (not its window count). The trend card has a "Share | Absolute"
  switch, **absolute by default**. Series selection (threshold and draw cap) still keys off the share
  peak, so plugins that are silent by share do not creep in on the absolute axis.

### One systematic risk not yet ruled out

Mechanism C (a plugin runs through a harness callback after its own frame has left the stack, so the
cost goes to harness) exists in principle, and this audit **did not measure it as significant**:
harness's absolute cost is too small to hide someone else's large cost. But it will understate a
plugin that pushes heavy work into harness timers or callbacks. Judging it needs frame-level hot
functions of harness packages by call site (the drill-down in point 3), not aggregate numbers.

> Update (2026-09): mechanism C has been measured and can be attributed (evidence 11); deep-mode
> async attribution is implemented (§13.8). Its size on a real host still needs a deep-mode
> measurement.

---

## 7. Relationship to the existing hard constraints

| Constraint | Under the new architecture | Proposal |
| --- | --- | --- |
| 1. Attribution walks the ancestor stack | Still holds; runs in the child | Keep. The heap side upgrades to a retainer-path walk (§5.3) |
| 2. Never monkey-patch `node:fs` | Unaffected | Keep |
| 3. Never leave dual sampling on | **Its numeric basis is in doubt** | See below |
| 4. Inexact metrics carry a coverage marker | Must **extend to memory** | `liveHeapBytes` has no coverage today and needs it |
| 5. `Profiler.stop` strictly paired | The state machine gets more fragile across processes | The host stays the only process calling the inspector, so the state machine stays there |
| 6. Stop sampling unconditionally on unload | Unaffected, but **one addition** | The child process and temporary snapshot files must also be cleaned up on unload |
| New: share next to absolute cost | §6.5 measured shares inflated by two orders of magnitude | `cpuShare` cannot be a headline alone; add `cpuMs/sampled-sec` and state the small denominator when idle is high |

On constraint 3: its basis is evidence 8's single microbenchmark (+15.1% / +25.8%, ten points apart
across two runs), while these three runs measured dual sampling at +0.5% to +6.7% (§4).
**Proposal:** do not overturn the constraint; rewrite it as "the default tier must sit in the safe
range, and aggressive tiers run only when the user asks". That keeps the intent without depending on
a number that does not reproduce. Change the numbers only after re-measuring them reproducibly in
`docs/evidence.md`.

---

## 8. Probes and reproduction

New probes (the source of this document's evidence):

```powershell
cd D:\Build\dsh-perf-lens\probes
node 08-cpu-clock-quantization.mjs      # CPU clock quantization, 15.6ms
node 09-sampler-cost-matrix.mjs         # tier cost matrix (run 3 times, read the trend)
node --max-old-space-size=4096 10-heap-snapshot-and-analyzer.mjs   # snapshot + child parsing
```

`10` takes `PROBE_HEAP_MB` to set the heap size (default 300; this document used 600).

Method lessons (four failed rounds before the data was usable; worth recording in
`docs/evidence.md`):

1. Comparing **absolute CPU share** across configurations drowns in GC and allocator noise — one
   heap-sampling run even used less CPU than the baseline.
2. Using a pre-optimisation warm-up as the baseline gives a 2× bias and negative overheads.
3. V8 deletes loops it can constant-fold (0.00ms CPU, 0.8ms wall, every ratio NaN).
4. **`process.cpuUsage()` is quantized to about 15.6ms on this machine**: a 5.7ms slice reads 0 or
   16, and batching pulls the median onto the quantum. → On this machine sampling overhead can only
   be measured as wall time over a fixed amount of work.

## 9. To verify / open

1. ~~Is `HeapProfiler.getSamplingProfile` available on Node 24?~~ → **Resolved:** available on
   v24.18.0 (returns head + samples), so continuous diffing does not need to stop the sampler.
2. ~~The real impact of a snapshot pause on the host~~ → **Resolved (negative):** a real 350–370MB
   host heap = **an 8.7–10.3 second complete freeze** (one heartbeat tick in the window), 25× worse
   than the synthetic heap; see §11.1. The snapshot route is closed.
3. Child memory ceiling versus snapshot size: here a 668MB heap → 806MB analyzer peak.
   *Downgraded:* with the snapshot route closed (§11.3), this matters only for future injected
   anchors.
4. Ownership of shared caches under retainer attribution — **resolved:** on a real heap the idom chain
   and the DFS spanning tree assign different owners to 89.7% of bytes, and every candidate anchor
   retains ≈ 0, so the problem is the **source of anchors**, not the propagation algorithm; see
   §11.3-3 (injected anchors).
5. Passive-tier defaults: starting at 5ms/256KB, reading quality still needs checking on a real host
   (**open**).
6. ~~Plugin-anchor discovery on a real host snapshot~~ → **Resolved (negative):** in a real heap,
   identity exists only in string and code nodes; object names match nothing, and there are no large
   owner subtrees below the root (top 10 ≈ 20MB of 362MB). Conclusion and alternative in §11.2 /
   §11.3-3.

---

## 10. Review (after re-checking against the probes)

Method: re-read the three probe sources, re-ran 09, and tested the API claims of §3/§5 on Node
v24.18.0. **Overall: the architectural direction is sound and the method (interleaved controls, noise
floor, multiple runs) is better than evidence 8's, so the skeleton can be trusted. With the points
below fixed, it is ready to finalise.**

### 10.0 Budget semantics (from the author; highest priority)

**10% / 30% are ceilings, not targets. Less overhead is always better.** This reverses two leanings
in this document:

- §4's "the budget is not the bottleneck, so the passive tier can safely be made finer" → withdrawn.
  The passive default stays conservative (5ms/256KB or coarser); any refinement must be driven by a
  concrete diagnostic need or triggered by the user.
- §5.2's "a snapshot every 10–30 minutes" → changed to **on demand only by default** (the user asks
  for an exact analysis and is told the expected pause); an automatic interval is at most a hidden
  setting, off by default. This also fits "works on install, little to configure".

### 10.1 Re-verified (can be ticked off or upgraded)

1. `HeapProfiler.getSamplingProfile` **is available** on Node v24.18.0 (returns a head + samples
   tree), so §5.4's continuous diffing need not stop the sampler. → Open item #1 closed.
2. The cost-mechanism split (CPU profiler ∝ sampling rate, heap sampling ∝ allocation rate) matches
   the review's re-run.
3. Two draft errors found in review are corrected inline in §3/§5.1 (`cpuConsumptionPercent` does not
   exist; `reportProgress: true` crashes the process rather than being refused).

### 10.2 Must fix

1. **"1.1ms/MB" is the wrong unit to extrapolate with.** Snapshot cost ∝ nodes and edges, not heap
   MB: the synthetic heap is 668MB / 310k nodes ≈ 2.2KB per node (all flat long strings), while real
   host objects have a median size of tens of bytes, so a heap of the same size may hold 10–25× the
   nodes and pause for **seconds**. §5.2's "400MB host ≈ 400–500ms" is a **lower bound**; the right
   unit is µs per node (≈ 2.4 here). That makes open item #2 (measure on the real host) not an
   ordinary to-do but **the gate that decides whether the snapshot route is built at all**.
2. **Retainer attribution walked the wrong graph.** Probe 10(b) propagates owners along the DFS
   spanning tree's parents, which is just one arbitrary root-to-object path (dependent on edge order),
   not retainer semantics. The right way follows the **dominator tree's idom chain** to the nearest
   plugin anchor: an object shared by several plugins has its idom at their common ancestor and
   naturally lands in "shared / unattributed". §5.3's worry that a shared cache always ends up with
   some plugin largely disappears under dominator semantics; the UI only needs a "shared" label.
3. **The real-heap "plugin anchor" is unsolved, and that is more fundamental than the pause.** The
   probe matches `name.includes('pluginA')`, but ordinary object names in a real .heapsnapshot are
   constructor or hidden-class names with no module identity. Possible real anchors (cordis Context
   instances, module namespace objects, closure nodes linked to scripts) need an anchor-discovery
   experiment on a real host snapshot first, or the parsing pipeline gets built only to find it cannot
   attribute anything. → Added as an open item on the same level as #2.

### 10.3 Corrections to the reading of the data

4. **The 15.6ms quantization does not explain evidence 8's negative overhead.** Evidence 8's probe 03
   uses `performance.now()` wall time (the review checked the source), and its negative values come
   from the microbenchmark noise evidence 8 itself acknowledges. The quantization finding still stands
   on its own (it constrains how a future self-reported metric is built), but it should not be
   written up as the explanation for evidence 8.
5. **Overhead varies across runs more than this document's three-run ranges show.** The review's one
   re-run of 09 gave Profiler 250µs **+22.7%** and the active tier **−9.8%**. Taken together the data
   only supports: "coarse sampling at ≥ 1ms and heap sampling at ≥ 256KB are near the noise floor;
   250µs is clearly more expensive (+9% to +23%, still inside the 30% active budget)". The review
   **agrees** with the proposal for constraint 3 (keep it, rewrite after a reproducible re-measurement),
   but the re-measurement must run on a real host workload; a synthetic idle host does not count.

### 10.4 Engineering gaps (fill into §6 before building)

6. Snapshot chunks should **not go through the IPC pipe** (§6's "snapshot chunks into the pipe"
   contradicts §5.1's streaming to disk): the host streams to a temporary file and passes the **path**
   to the child, so hundreds of MB do not cross the process boundary twice.
7. There is no **backpressure** plan for when the child is down: the host needs a bounded ring of raw
   profiles that drops the oldest window when full and records the gap in the coverage metric,
   instead of piling up without limit.
8. Under Electron, `child_process.fork` needs `ELECTRON_RUN_AS_NODE=1`, or it forks an Electron
   utility process; `utilityProcess` has Electron version requirements for ESM entries. The choices
   section should say both.
9. The child could parse in a streaming (SAX-like) way instead of one `JSON.parse` of the whole tree,
   roughly halving peak memory (the strings table dominates), so a >1.5GB heap need not be abandoned
   outright (merge with open item #3).
10. The table in §4 left out two rows of probe 09 (the alloc baseline and alloc + cpu 1ms + heap
    256KB) — and the dual-sampling row under an allocating workload is the one closest to real cost;
    restore them when finalising. The header comment of probe 09 still names the old path
    `.tmp/probe/p1-sampler-cost.mjs`; fix it at the same time.

### 10.5 Direction (following 10.0's "less is better")

11. Spare budget should **not** be spent on finer CPU sampling. But if the memory signal proves
    diagnostically useful (§5.4's net-retention diffs), lowering the passive tier's heap sampling from
    256KB to 32–64KB costs almost nothing on compute workloads — **the only place worth "spending
    budget"**, and only after its reading quality is verified on a real host (open item #5).
12. Heap sampling left on from plugin load covers every later allocation, so "blind to objects
    resident before the window" shrinks to pre-existing caches only. That weakens §5.4's caveat and
    makes an occasional snapshot more of a calibration than the only truth.

---

## 11. Measured on the real host (probes 11 / 13)

The review asked for the snapshot cost and anchor availability on a real DSH host. Method:
`process._debugProcess(pid)` attached to the running host serving the GUI (not started with
`--inspect`) and took a snapshot over CDP; an in-host `v8.writeHeapSnapshot` served as a control.
**The host was never restarted; it was the same process throughout.**

### 11.1 Snapshot cost: an 8.7–10.3 second freeze (25× worse than the synthetic heap)

| Path | Heap size | Freeze | Unit cost | Snapshot |
| --- | --- | --- | --- | --- |
| In-host synchronous `writeHeapSnapshot` | 369MB heapUsed | **8672ms** | 23.5 ms per heap MB | — |
| CDP streaming `takeHeapSnapshot` | 349–366MB | **10301–10437ms** | 28.3–29.7 ms per heap MB | 274MB |
| Synthetic heap (probe 10 control) | 668MB | 760ms | 1.14 ms per heap MB | 19.7MB |

How the freeze was confirmed: a 25ms heartbeat on the host's event loop ticked **once** inside the
snapshot window, with a largest gap of **10303ms** — not "generated in the background with some
jitter" but **the whole event loop taken over**. (A first attempt with a 50ms heartbeat read 178ms:
a window artefact, because blocking began less than one tick after the heartbeat was set, so the
large gap was never recorded. **Measurements like this must also report the tick count inside the
window**; the probe's comments now say so.)

The difference comes from **node density**, not file size:

| | Nodes | Nodes per heap MB | µs per node to generate |
| --- | --- | --- | --- |
| Synthetic heap | 310k | 464 | 2.45 |
| Real host | 3,782,359 | **10,327** | 2.76 |

µs per node is nearly the same in both (2.45 vs 2.76); the pause ratio = node density ratio (22×) ×
unit difference (1.13) ≈ 25×. **Estimate cost as µs per node × real node density; extrapolating by
MB underestimates it 25×.** By this model a 1GB real heap ≈ 30 million nodes ≈ **an 80-second
freeze**.

Also observed: during the snapshot the host's RSS rose from ~660MB to ~952MB (+290MB transient), and
the snapshot triggered a GC (heapUsed 362 → 330MB).

### 11.2 Anchor discovery: a real heap has no "plugin root"

The snapshot has 3.78M nodes, 11.5M edges and 698k strings; parsing took 1.57s and the
Lengauer-Tarjan dominator pass 580ms — **the analyzer's computation really is cheap** (consistent
with §5.2); generation was always the expensive part.

Where identity lives (probe 13, phase 2):

| Form of identity | Hits | Notes |
| --- | --- | --- |
| Package names / paths in the string table | dsh packages 3249, perf-lens 712, other plugins 4244 | all `string` nodes |
| `code` nodes (script paths) | dsh packages 80, script paths 126 | the only "executable" anchors |
| Property names (`property` / `internal` edges) | dsh packages 6055, perf-lens 4, other plugins 24 | module registries / cache keys |
| **Object / closure names** | **0** | probe 10's `name.includes('pluginA')` rule **fails completely** on a real heap |

The retained-size landscape (phase 3a) is decisive:

```
     362.0MB  synthetic                    <- the root owns the entire heap
       6.2MB  native  JSArrayBufferData    <- the largest thing below the root is only 6.2MB
       3.6MB  string  "use strict";
       2.6MB  native  JSArrayBufferData
       1.4MB  string  {"model":"deepseek-v4.1-flash",...
  top anchors by retained size:
       0.0MB  dsh-fs / dsh-chat-import / dsh-typert-protocol / ...
```

- **There are no large owner subtrees below the root:** the top 10 retained sizes add up to only
  about 20MB of 362MB. The heap is extremely flat.
- **Every candidate anchor retains ≈ 0.0MB:** code nodes and property holders are leaves in the
  dominator tree and dominate nothing.
- Attribution compared: the idom chain gives **0.4MB (0.1%)** versus the DFS spanning tree's
  **325.1MB (89.8%)**, and the two disagree on **89.7%** of bytes. The DFS 90% is an artefact of edge
  order, **not ownership** — which rejects probe 10's attribution by measurement, and shows that
  "just swap DFS for idom" is not enough.

**Probe 14 (dominator partition rooted at modules)** takes each module's own nodes as roots and
assigns objects to the nearest module root in the dominator tree. It shows the same conclusion from
another angle: **only 0.3% of the real heap (1.2MB / 363.9MB)** can be assigned to any module, and
**99.7% of the heap has no module root in the dominator tree** (the largest retained subtrees are all
ArrayBufferData and source strings, owned by nobody).

> *Review correction:* the first version of probe 14 reported **10.7% (38.8MB)**, but its main
> partition used **DFS spanning-tree parents** (`charged[parent[i]]`) while its title and comments
> claimed dominators — the very basis §11.2 above showed to disagree with real ownership on 89.7% of
> bytes. Switching to `charged[idom[i]]` drops the figure **35×** to 0.3%, consistent with probe 13's
> 0.1% (code/property anchors). **Any per-plugin memory figure must use the dominator basis.**

### 11.3 Conclusion and proposal (what to do with §5)

1. **The snapshot route does not work; close it.** A 10-second freeze on the real host, +290MB RSS
   and a 274MB file buy a conclusion one could have guessed ("plugins hold a few MB each; the bulk
   belongs to the harness and sessions"). Worse, even ignoring the pause, **only 0.3% of the heap can
   be assigned to any module on the dominator basis** (§11.2, probe 14), so even "a few MB per plugin"
   covers a tiny fraction — 99.7% of the heap is dark to any graph-based attribution. No automatic
   frequency is acceptable; even on demand it would have to announce "about a 10-second freeze". The
   hard constraint "do not disturb the host" cannot be met on this route.
2. **The memory signal moves to heap sampling (§5.4):** charged per allocation, cost near the noise
   floor, no freeze. It only covers allocations after sampling starts, which is exactly where
   continuous background analysis lives; coverage is labelled per hard constraint 4.
3. **If exact shares are ever wanted, the only viable route is injected anchors** (a direct result of
   this experiment):
   - before the snapshot, the host places a **known structure** in the heap:
     `globalThis.__dshPerfLensAnchors = new Map([[pluginName, WeakRef(pluginRoot)], ...])`, with
     WeakRef values so unloaded plugins' objects are not pinned (whether WeakRef targets are visible
     in a snapshot is still to be verified);
   - the analyzer finds this Map by its **unique key string** and reads its value edges to get each
     plugin's anchor node;
   - objects are then assigned along the **idom chain** to the nearest plugin anchor, and objects
     dominated jointly by several plugins land in "shared" on their own.
   - This replaces "guess the plugin root by name" (shown impossible here) with "read the registry we
     planted ourselves" (deterministic).
4. **The process boundary does not change this:** V8 can only snapshot the heap in the process that
   owns it, so a child process cannot rescue generation. Splitting the process is still worth it for
   aggregation, history and statistics (§2), **but not** for taking snapshots.

### 11.4 Reproduction

```powershell
# 1. Find the host pid: Get-NetTCPConnection -LocalPort 3081 -State Listen | Select OwningProcess
$env:DSH_HOST_PID='<pid>'; $env:PROBE_OUT="$env:TEMP\host.heapsnapshot"
node --max-old-space-size=4096 probes/11-real-host-heap-snapshot.mjs    # freezes the host ~10s
node --max-old-space-size=8192 probes/13-real-host-anchor-discovery.mjs # anchors + dominators
```

Note: probe 11 opens an inspector port on the target process (9229, loopback only) and **cannot close
it afterwards**; it disappears when the host restarts. The snapshot file is large (~274MB); delete it
after use.

---

## 12. Conclusion: how continuous background analysis should work

Combining §4 (tier costs), §6.5 (the share illusion) and §11 (snapshots rejected):

1. **Main form:** the passive tier stays on with a 5ms CPU profiler and 256KB heap sampling (32–64KB
   is worth considering; on compute workloads its cost ≈ the noise floor), with defaults on the
   conservative side; the active tier rises to 250µs only when the dashboard is open or the user asks.
2. **Memory:** sampling attribution with coverage labels only, no snapshots; `liveHeapBytes` needs a
   coverage figure (an extension of hard constraint 4).
3. **Presentation:** every CPU figure leads with **% of one core / ms per second**, with share second;
   when idle share is high, say the denominator is small. (A direct result of the §6.5 audit, recorded
   as a hard constraint.)
4. **Process split:** move aggregation, history, statistics and hot functions out; the inspector
   control stays, and snapshots cannot be saved by it.
5. **Not doing:** exact memory shares via snapshots, an aggressive always-on dual-sampling tier, or a
   cost model extrapolated by MB.

---

## 13. Detection precision and "empty windows" (probes 15 / 16)

The problem: on an idle host the dashboard looks as if it "caught nothing". Real history (probe 15)
and the measured sampling rate (probe 16) show this is three different things, only one of them a
real defect — and that one is in old records.

### 13.1 Three kinds of "empty window"

| Meaning | Measured | Verdict |
| --- | --- | --- |
| A window with no samples at all | 147 of 1018 windows in early logs have `sampleCount=0`, but their `idleSamples` field is `undefined` | **Not a defect**: records from before that field existed |
| Samples taken but none attributed to a plugin | 0 windows | Does not happen (non-idle samples always land somewhere) |
| Work below the sampling resolution | a window's top plugin has a median of 3.25ms ≈ 6 samples | **A real limit**; see 13.2 |

### 13.2 The real limit: per-window granularity

A typical 2s continuous-mode window (probe 15): **99.1% idle, with a median of only 17 active
samples.** So one window's granularity is:

- **Share granularity = 1/17 ≈ 5.9%:** one extra sample moves a plugin's share by 5.9 points. That is
  why the dashboard "jumps around".
- **CPU granularity ≈ 0.54ms per sample** (see 13.3): anything below it reads as 0.

So **a single window is good for "who is moving", not for comparing small costs.** Aggregating across
windows (the ranking's cumulative column) is the precise view: 235 windows × 17 active samples ≈ 4000
samples, bringing granularity back to 0.025% share / 0.54ms total.

### 13.3 The configured sampling interval does not take effect (platform tick floor)

Probe 16 (this Windows machine, 2s busy loop, median of 3):

```
配置间隔    样本数   样本/秒   实际达成间隔
  100us     3709     1855        539us
  250us     3732     1866        536us   <- 当前默认
  500us     3485     1743        574us
 1000us     1752      876       1142us
 5000us      369      185       5420us
```

(Columns: configured interval, samples, samples per second, achieved interval; 当前默认 = current
default.)

**100µs and 250µs get exactly the same number of samples** — the platform floors the profiler tick at
about 536µs. So:

1. `cpuIntervalUs: 250` is **resolution this platform cannot deliver**; it buys nothing better than
   500µs;
2. to be cheaper than 500µs you have to drop to 1000µs, halving resolution (cost ∝ actual sample
   count);
3. the resolution the panel shows must be the **achieved** value (`sampleWindowMs / sampleCount`),
   never the configured one taken as a promise — already implemented;
4. the floor is platform-specific (usually lower on Linux); re-run probe 16 on a new platform.

### 13.4 Process-level calibration: "truly idle" versus "missed"

History had no process-level CPU reading, so "was this window really idle, or did we miss something"
**could not be answered**. `GlobalMetricRow.processCpuMs` now records the CPU the process actually
used during the window (a `process.cpuUsage` delta), and the panel shows **sampled coverage = CPU
attributed from samples ÷ actual process CPU**:

- near 100%: the host really is quiet and the reading can be trusted;
- well below 100%: CPU was spent outside the sampled thread (libuv thread pool, native code, GC
  threads) — a **quantified measure of what was missed**;
- when process CPU in the window is under 100ms, no figure is shown (the Windows clock granularity is
  ~15.6ms, so the ratio is noise); the panel says "cannot measure" instead.

### 13.5 Options for more precision and fewer empty windows (best value first)

| Option | Gain | Cost | Verdict |
| --- | --- | --- | --- |
| **Aggregate across windows** (exists: the ranking's cumulative column) | Granularity improves with √N; 4000 samples ≈ 0.025% | none | **First choice**; already in the UI, users just need pointing to it |
| **Process-level calibration** (implemented this round) | Makes "empty" decidable: truly idle vs missed | one `cpuUsage` per window, negligible | Done |
| **Longer windows** (2s → 5s) | 2.5× active samples; share granularity 5.9% → 2.4% | coarser time resolution | Worth trying for continuous mode |
| **Shorter idle backoff** | Denser windows: today 6.8% duty and a p90 gap of 125s → spikes get missed | cost ∝ duty cycle, 2–3× | A setting; conservative by default |
| **Two-tier sentinel sampling** (a coarse interval always on, switch to fine on activity) | 4× the windows for the same cost, and spikes get caught | changes the sampling strategy; the first busy window may land on the coarse tier | **Recommended next step**; see 13.6 |
| **OS/kernel level** (ETW / perf / GetProcessTimes) | exact process CPU, no sampling cost | **no ownership**: says how much, not who; ETW stack sampling needs native code and symbol resolution | Only a calibration signal (13.4), never a replacement for attribution |
| A finer CPU sampling interval | — | capped by the platform tick floor (13.3) | Useless |

### 13.6 Recommended next step: a two-tier sentinel

Today there is only the "intermittent" cadence, backing off to 120s when idle (a p90 gap of 125s).
Instead:

1. **A sentinel tier stays on** at a 10ms interval (about 25× cheaper) and only asks "was anything
   active this second?";
2. when it sees activity → switch to the 250µs fine tier for a full window at once;
3. check the fine window against `processCpuMs`: high process CPU with low attribution means samples
   were missed; keep the window and flag it.

Gain: at least 4× the windows for the same overhead, and spikes no longer fall into a two-minute
blind spot; resolution stays fine when it matters. Risk: the switch between sentinel and fine tier
costs one window of precision; the switching delay needs measuring.

### 13.7 Shipped: the two-tier sentinel (2026-09)

During a **long backoff (120s)**, the `Lens` duty tier inserts cheap sentinel probes (by default a
10ms interval, 1s window, every 10s):

- A probe only computes the idle share and is **never recorded**: a coarse window has only a few dozen
  samples, so per-plugin shares are noise (5 samples reads as 100%) and would recreate §6.5's share
  illusion in the ranking. Its only consumer is the loop's "run a fine window now?" decision.
- When a probe sees activity (idle share < 0.8) → the backoff ends at once and a full fine window
  runs (250µs / 5s).
- Probes run only when **the previous window was mostly idle** (idle share ≥ 0.8, i.e. exactly when
  the 120s backoff begins). Continuous and background tiers, and a busy previous window, are not
  probed — probing a busy host would raise its sampling density from 5s/35s to 5s/15s, outside hard
  constraint 3's safe range.
- Cost (probe 18): one 1s probe ≈ **98 samples**, one 5s fine window ≈ **9222 samples**; 11 probes in
  a 120s backoff ≈ 1078 samples = **+11.7% sampling budget**, in exchange for cutting the
  activity-detection gap from **125s to 10s**. A busy host pays nothing.
- A control change still interrupts the wait immediately (`#sleepInterruptible` returns slept/woken),
  as before.

Unit tests: `sentinel activity probing` in `test/lens.test.ts` (the probe returns an idle share and
records nothing; the gating conditions; the loop runs a fine window right after detecting activity).

### 13.8 Shipped: mechanism C async attribution (deep mode)

Evidence 11's probe showed that in one profile the ancestor walk gave all 714 samples to harness,
while correlating async context handed 701 of them back to the plugin that started the work. The
implementation lives in `src/host/async-attribution.ts`:

- `AsyncWindowRecorder`: enables async_hooks during a deep window, keeps `init` stacks only for
  **plugin-owned** resources (work the harness or runtime starts on its own needs no correction), and
  records execution windows from `before` / `after`.
- `sampleTimesUs`: rebases V8's `timeDeltas` onto the wall clock the sampler records at start and stop
  (V8's clock is monotonic since boot).
- `correlateSamples`: samples that already have a plugin frame on the stack are left alone (more
  specific); idle samples are left alone; any other sample inside a plugin-owned window moves to that
  plugin.
- Applied in both `tallySamples` (rows / shares / harness sub-packages) and `aggregateHotspots` (hot
  functions), so the two agree.
- `/api-perf/diagnostics` gains `asyncWindowedSamples` / `asyncReattributedSamples`.

Constraints and cost:

- **Deep mode only.** `asyncAttribution` defaults to true but is a no-op outside deep mode.
- A stack per `init` plus `before` / `after` on every callback make this the most expensive option in
  the plugin; it is disabled the moment the window ends.
- Without V8 timing fields it quietly falls back to stack-only attribution instead of throwing.

Still to verify: **the size of mechanism C on a real host.** §6.5 showed harness's absolute cost is
small to begin with (~0.75% of one core), so few samples are expected to move; turning on deep mode and
reading `asyncReattributedSamples` will settle it.
