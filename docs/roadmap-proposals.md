# Feature proposals after the landscape survey

> Written 2026-09-24, after [landscape-survey.md](landscape-survey.md). This is a **proposal**, not
> architecture: accepted items must be folded into [design.md](design.md) §12 and the decisions table
> before implementation, per the documentation discipline in AGENTS.md.
>
> Ordering rule: a gap that makes the panel **state something false** outranks a feature that makes it
> state more. The first four items are in that class.

## Status (2026-09-24)

| Item | Status |
| --- | --- |
| 1a descendant process totals | **Shipped in 0.2.0** |
| 1b attribute a child to its plugin | Open (Phase 3) |
| 2a unexplained-CPU residual | **Shipped in 0.2.0** |
| 2b per-worker sampling | Open (Phase 3) |
| 3 timers / listeners / handles | **Split**: listeners shipped; timers and handles **rejected** — an always-on `async_hooks` hook measured 2.3–2.6× on promise-heavy work ([evidence 15](evidence.md#evidence-15-an-always-on-async_hooks-hook-is-too-expensive-for-a-live-timer-gauge)). Process-wide counts shipped instead |
| 4 per-plugin disk footprint | **Shipped in 0.2.0** |
| 5–9, 10–13, P3 | Open |

The lesson from item 3 is worth keeping: the roadmap assumed the mechanism would work and only the
scope was in question. Measuring the mechanism first turned a "build this" into a "do not build
this, and here is the number", which is the cheaper outcome.

---

## P0 — gaps between the promise and the measurement

The README says the panel shows "which plugin is using your host's CPU, memory and disk". Three
things currently break that sentence.

### 1. Child processes: show them, then attribute them

**Why first.** In an agent harness most CPU is often *not* in the host: `dsh-subprocess-local` runs
every shell command, terminal session and LSP server through `node:child_process` / `node-pty`, and
any plugin can spawn more. When a build, `git`, `rg` or a language server saturates the machine, the
panel reports an idle host — the most confidently wrong answer it can give. Today this is disclosed
in README "Limits", but disclosure does not fix the product claim.

**Staged, so the honest half ships cheap:**

- **1a — process-tree totals (small).** Extend the Process overview with descendant count and the
  aggregate CPU / RSS of the host's process tree, labelled **"not attributed to plugins"**. This
  alone converts "host 3%, everything is fine" into "host 3%, descendants 380%". Mechanism: the
  existing `process.resourceUsage()` covers the host only, so this needs a process-table read
  (`process-inspector.ts` in `dsh-subprocess-local` is the in-repo precedent for the platform
  queries). Cost: one host module + overview rows.
- **1b — attribute a descendant to the plugin that spawned it (medium).** Track spawn call sites
  (the `SubprocessRuntime` seam and/or the `child_process` call stack) and charge each child's CPU
  and RSS to its owner plugin, with the same coverage discipline as CPU samples: a child that
  outlives its spawn frame, or one spawned before the tracker attached, is marked uncovered.
- **1c — per-child drill-down (small, after 1b).** PID, command line, CPU, RSS, age, owning plugin —
  the "what is this thing" view.

**Design impact:** moves part of design.md Phase 3 into the main line; the "child processes are out of
scope" decision (decisions #3) and the README limit both need rewriting.

### 2. Worker threads: an unmarked blind spot

**Evidence 14** (new probe `probes/20-worker-thread-blindspot.mjs`): a worker burned ~700 ms of CPU
next to a busy main thread; the host's `inspector.Session` captured **0 frames** from it while the
process denominator showed **193–197 % of one core**. `process.report.getReport().workers` is `[]`
even while a worker is alive, so nothing currently signals the situation. Every per-plugin share is
then systematically low with no marker — the same class of failure as the ESM monkey-patch trap, and
a direct violation of hard constraint 4.

- **2a — "unexplained CPU" row (small).** Publish `process CPU used − attributed sample time` as an
  explicit residual in the overview and the composition bar, next to the existing unattributed slice.
  A sustained large residual is the honest signal that a worker or native thread is running. No new
  interception, uses data already collected.
- **2b — per-worker sampling (medium, Phase 3).** A worker has its own isolate and its own inspector,
  so the host cannot profile it from outside; this needs code running inside the worker (`execArgv`
  injection, or the same `module.register()` loader-hook tradeoff as byte-level disk I/O). Until
  then 2a is the answer.
- Note the host does spawn workers in the real product
  (`session-persistence-jsonl/src/migration-verifier.ts`, the experimental `inspector` bridge), so
  this is reachable, not hypothetical.

### 3. Timer / listener / handle counts

`PluginMetricRow.timers`, `.listeners` and `.handles` already exist in the contract, are always `0`,
and `metrics-table.tsx` renders them as empty. That is a visible hole in the table, and it is the
one question the panel cannot currently answer that a plugin owner actually asks: **"which plugin
registered 2 000 listeners and never removed them?"**

- Count by Cordis effect / fiber ownership where possible (`ctx.setInterval`, `ctx.setTimeout`,
  `ctx.on` are the seams design.md §3.5 already names), falling back to wrapping those services.
- Ownership must be resolved the same way CPU is — to the plugin, not the caller's caller.
- This also sharpens the difference from `dsh-lifecycle-inspector`, which shows Fiber state and
  teardown latency but no counts.

### 4. Per-plugin disk footprint (exact bytes)

The tagline says "disk" and today only *operation counts* exist. Footprint is the one disk metric that
is **exact, cheap and sample-free**: walk `$DSH_HOME/**` and the workspace, map each path to its
owning plugin through the existing owner index, and sum bytes. No interception, no coverage marker
needed.

- Also covers "the plugin left 2 GB of cache behind", which no other DSH plugin answers.
- Complements 1b: footprint is at rest, child-process I/O is in motion.

---

## P1 — from "go look at it" to "it tells you"

### 5. Auto deep-profile on a stall (borrowed from VS Code)

VS Code's auto-profiler fires only when the extension host is unresponsive, profiles ~5 s, and logs
`UNRESPONSIVE extension host: '<id>' took N% of Mms`. The DSH analogue is strictly better because the
sampler, the history and the owner index already exist:

- trigger on event-loop lag / long-window CPU crossing a threshold, or on the host being idle for N
  consecutive windows;
- open one short deep window automatically (hot functions + heap sampling);
- surface **one conclusion** ("`dsh-context` used 62 % of the host for 4.2 s at 14:03"), not a chart;
- optional notification so the answer arrives with the panel closed.

This is the highest-value item in P1: it is the difference between a dashboard and a watchdog, and it
is why the always-on JSONL history exists.

### 6. Threshold alerts

Per-plugin rules ("CPU > X % of one core for Y minutes", "heap retained grows for Z windows",
"listener count > N"). Same detection machinery as 5; the difference is that 5 is automatic and 6 is
configured. The 60 k-downloads-a-month client-side tool in this ecosystem shows that people want a
performance signal pushed at them, not a page they must remember to open.

### 7. Report export (HTML + JSON)

Every comparable tool that spread did it through a shareable artifact: spark uploads to a web viewer,
`dsh-performance-guard` ships static HTML reports, VS Code saves a `.cpuprofile`. A single-file HTML
report of a window (or a range) makes bug reports and "before/after" posts possible.

**Hard constraint to respect:** design.md §7's red line — no frames, function names or file paths on
disk. An export must either be aggregates-only by default, or require an explicit opt-in for hot
functions, and the file must say which it contains.

### 8. Baseline comparison

Capture a named baseline (a window or a range), then diff every plugin against it: "after the upgrade,
`dsh-chat-import` costs +180 ms/s". This is already listed in design.md Phase 2 and is the natural
companion to export.

### 9. Configuration schema + a settings page

The changelog's last limitation is *"Sampling settings are fixed defaults; there is no configuration
schema yet."* Nothing above can be tuned without it: thresholds, retention, per-plugin overrides,
alert rules, and the deep-mode opt-in all need a config surface. `settings.section` is the slot named
in feasibility §5.2 and is already a design.md Phase 2 item.

---

## P2 — attribution quality

### 10. A second attribution view: "who started this work"

VS Code relabels a profile segment with the **outermost** extension frame on the path; Perf Lens
walks **up to the nearest** plugin frame. For `pluginA → pluginB → sharedLib`, VS Code charges A and
Perf Lens charges B. Both are defensible and they answer different questions ("who started it" vs
"who is running now"). The parent map is already built, so this is a small toggle plus a test.

### 11. `ctx.fs` byte wrapping

design.md §3.3 Layer 3's recommended route: wrap the `FileSystem` service to get exact bytes for
harness-mediated I/O, mark the rest uncovered. Turns "file operations" into "bytes for the covered
part, counts for the rest" — the honest version of the disk claim.

### 12. Event-loop blocking attribution

The panel already shows event-loop lag and correlates foreground jank with host CPU. The missing half
is **which plugin blocked the loop**: from the CPU profile, the longest synchronous self-time chains
inside a window. Cheap (pure post-processing of data already collected) and it answers the most
common real complaint, "the UI freezes".

### 13. Browser-side per-plugin render attribution

**Superseded: shipped as Long Animation Frames attribution** (see
[design-loaf-attribution.md](design-loaf-attribution.md), design decision #9 revised). The DOM-root
heuristic was rejected for this case: it measures DOM churn, while the motivating jank is JS scan
time per mutation, which DOM counts would misrank. LoAF attributes script execution and
script-forced layout directly, with a coverage ratio.

`@linxin666/dsh-perf` already attributes added-DOM-node rates to `data-dsh-plugin` roots in
production. Design decision #9 says the browser cannot attribute a long task to a plugin bundle; that
claim should be softened and the jank view upgraded from pure correlation to a heuristic attribution
with an explicit "heuristic" marker. Lower priority than the host-side work — it is competing on
another plugin's turf — but it closes a stated gap.

---

## P3 — deliberate boundary extensions

| Item | Note |
| --- | --- |
| Per-worker sampling (2b) | Needs code inside the worker; same tradeoff as the loader hook |
| Flame graph / call tree per plugin | spark and VS Code both have one; the hot-function list may be enough until users ask |
| `node:fs` loader hook for exact bytes | design.md Phase 3; changes function identity, order-dependent |

---

## What not to build

- **A bisection workflow.** `qinshige/dsh-performance-guard` already owns it (reversible profile
  isolation, paired CIs, Hedges' g). Duplicating it would be worse than either. The right move is a
  **handoff**: export the suspect set and a copyable isolation command, and document the division of
  labour — *attribution narrows the field in seconds, bisection proves it in minutes*.
- **A client-side FPS / long-task dashboard.** `@linxin666/dsh-perf` has 60 k installs a month doing
  exactly that. Keep the existing jank correlation, add item 13, and stay out of the rest.
- **Per-plugin RSS.** Still impossible: one process, one RSS. Items 1 and 2 make the residual honest
  instead of pretending otherwise.

---

## Suggested sequencing

| Release | Contents | Why this order |
| --- | --- | --- |
| 0.2.0 | 1a, 2a, 3, 4 | All four close a "the panel says something false / shows nothing" gap; 1a and 2a are small |
| 0.3.0 | 5, 6, 9 | Turns it into a watchdog; 9 unblocks 6 and everything tunable |
| 0.4.0 | 7, 8, 10, 12 | Shareable evidence, comparison, attribution depth |
| Phase 3 | 1b/1c, 2b, 11, flame graph, loader hook | Each has a real mechanism risk; none blocks the above |

Before starting 0.2.0, two documentation changes are required by the repo's own discipline:
decisions #3 ("child processes in v1? No") and the README "Limits" bullets must be rewritten, and
Evidence 14 must be reflected in design.md §5's coverage rules.