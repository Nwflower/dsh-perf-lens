# dsh-perf-lens

A DeepSeek Harness (DSH) plugin that shows **which plugin is using your host's CPU, memory and
disk**.

Every DSH host plugin runs in one Node process, so the operating system can only tell you what the
whole process costs. Perf Lens samples that process from the inside, charges each sample to the
plugin that caused it, and puts the result in a dashboard in the DSH web GUI. No more throwaway
profiling scripts when something feels slow.

## What you get

Open **Perf Lens** in the left sidebar:

- **Process overview** — RSS, heap, event-loop lag, GC pauses, and how much of the last window was
  idle, plus the readings that explain what the host alone cannot: the **descendant process tree**
  (count, combined CPU, combined memory), the **CPU the profile could not account for**, and the
  async resources the process is holding.
- **Cost composition** — how much of the whole process each plugin takes, for CPU and for sampled
  heap.
- **Top consumers** — the plugins costing the most right now, with their average and peak.
- **Trend** — CPU per plugin over the last hour, day or week.
- **Cumulative cost ranking** — who burned the most CPU over that range.
- **Plugin detail** — every plugin grouped and sortable, with the heaviest harness packages broken
  out and, in deep mode, each plugin's hot functions. Includes **listeners** (exact, from the cordis
  event registry) and **on-disk bytes** (exact, from a directory scan of `$DSH_HOME`) per plugin.
- **Foreground jank** — long tasks and dropped frames in the browser, with long-frame script time
  **attributed per plugin** (Long Animation Frames API) next to what the host was busy with at the
  time. Browsers without the API fall back to the plain time correlation. On the **DSH Desktop
  window**, where the browser withholds that attribution, a **jank probe** switch measures instead
  which plugins' scheduled callbacks occupy the main thread, with callback milliseconds, call counts
  and the longest single call per plugin.

The panel follows the GUI language (Chinese or English).

## Requirements

- DeepSeek Harness **0.1.7-alpha.1 or later**, using the web GUI (`dsh web`)
- Node.js **22.13 or later** (whatever runs your DSH host)

## Install

Add the package to your DSH profile and list it as a bundle. For the default web profile, edit
`~/.dsh/profiles/web/package.json`:

```jsonc
{
  "dsh": { "profile": { "bundles": [ /* … existing bundles … */, "dsh-perf-lens" ] } },
  "dependencies": { "dsh-perf-lens": "^0.1.0" }
}
```

Then install and restart the host:

```bash
cd ~/.dsh/profiles/web && pnpm install
```

The host half loads when the server starts, so restart `dsh web` for it to take effect. If the
profile's pnpm supply-chain policy (`minimumReleaseAge`) blocks a package, run a one-off
`pnpm install --config.minimumReleaseAge=0` instead of changing the profile's settings.

## Sampling controls

Sampling is never free, so Perf Lens samples in short windows and lets you choose how hard it looks.
There are three controls, and they combine — the panel always shows the combination it is actually
running, not just which buttons are lit.

**Intensity** (one of three):

| Tier | What it does | When to use it |
| --- | --- | --- |
| **Low** (default) | A 5-second window every 30 seconds or more; backs off to 2 minutes when the host is idle, with a cheap 1-second check every 10 seconds so bursts are not missed | Always on |
| **High** | Back-to-back 2-second windows; drops back to low after 10 minutes | While you are actively watching something |
| **Stop** | No new windows | When you want the host left alone |

**Background sampling** (on / off) decides what happens while the intensity is **Stop**: on, the host
keeps a coarse 2-second window every 2 minutes, so a long-term record survives with the panel closed.
It has nothing to add at Low or High, where the foreground already samples.

**Memory sampling** (on / off) adds heap sampling to whichever windows run — memory attribution, hot
functions per plugin, and credit for work a plugin schedules through harness callbacks. It is the most
expensive option, and the only one that costs extra on top of CPU sampling.

So *Stop + background on* is a cheap always-on record, *Low + memory on* is the normal profiling
setup, and *High + memory on* is "I am watching this right now". Every change takes effect
immediately, and all three settings are reported by the host, so they survive a page reload.

## Reading the numbers

- **Share vs absolute cost.** A plugin's *share* is its part of the CPU the process actually used
  during the window. On an idle host that denominator is tiny, so something that ran for a few
  milliseconds can show 90%. The panel always shows the absolute cost next to it — **ms of CPU per
  second** and **% of one core** — and that is the number to compare across time or machines.
- **Charged to the caller.** Each sample is walked up the call stack to the nearest plugin frame, so
  the code a plugin calls into (its dependencies, Node built-ins) counts against that plugin.
- **Harness built-ins** is the DSH framework itself, folded into one row with its busiest internal
  packages listed underneath. **Runtime** rows (GC, native / syscalls, Node internals, event loop)
  are work no plugin frame was on the stack for. **This plugin's overhead** is Perf Lens itself.
- **Estimates are marked.** Anything sampled rather than measured says so, and the cumulative
  ranking hides its whole-range estimate when sampling covered too little of the range to scale up
  honestly.
- **Jank attribution carries its coverage.** The per-plugin long-frame table always shows the share
  of script time that could be attributed; combo bundles whose segments cannot be read land in an
  explicit "Unresolved" row, never a guess.

### Limits

- **There is no per-plugin RSS.** One process means one RSS. Memory figures are sampled heap
  allocations from deep-mode windows, not a plugin's footprint.
- **Child processes are shown, not attributed.** The overview reports what the host's descendants
  cost in total, because a shell command, a terminal or a language server runs outside the host and
  the host alone would look idle. Which plugin *spawned* a child is not measured yet, and because
  the tree is polled rather than watched, a command that starts and exits between two polls is not
  seen — the reading is for long-lived descendants (language servers, dev servers, terminals,
  builds). It costs about 330ms of wall time per poll on Windows (a PowerShell start), so it runs
  every 30s, plus an immediate refresh while the panel is open.
- **Disk bytes are not measured.** Per-plugin file *operation* counts are exact, and so is per-plugin
  on-disk footprint (the "On disk" column, which scans `$DSH_HOME` plus each plugin's own directory);
  file *bytes* read and written are not. The scan does not follow symbolic links, so a plugin whose
  files sit behind a link outside both of those roots reads as empty.
- **Timers and handles are process-wide only.** Counting them per plugin needs an always-on
  `async_hooks` hook, which measured 2.3–2.6× on promise-heavy work, so the panel reports the
  process totals and leaves the per-plugin columns out rather than showing a false zero. Listeners
  *are* per plugin and exact.
- **Unexplained CPU is a signal, not an answer.** It says some CPU ran outside the sampled thread
  (a worker, or native code); it does not say which plugin put it there.
- **Short windows are noisy.** One window is good for "who is busy"; the cumulative ranking is the
  precise view.
- **Jank attribution is script execution only.** Long Animation Frames name the script that ran and
  the style/layout it forced; painting, compositing and browser bookkeeping belong to no script and
  stay in the frame-level totals. The API needs Chromium 123 or later (the DSH web GUI qualifies);
  older engines show the correlation view instead. The **DSH Desktop window** (`dsh-app://` custom
  scheme) withholds script attribution at the browser level, so the long-frame table only appears on
  the `dsh web` GUI.
- **The jank probe measures registration, not execution.** It reports the total time the page spent
  inside callbacks registered at a given position, counts nested wrappers at each level, and cannot
  say which statement inside a callback burned the time (the in-page profiler is disabled on that
  origin). A plugin can register another plugin's callback, so a row reads "callbacks registered
  here". It is off by default; switching it on reloads the page once so the probe installs before
  plugins register, and the choice is remembered.

## Data and privacy

- Everything stays on your machine. The panel talks only to your own DSH host.
- Each sampling window appends one line of aggregated numbers to
  `$DSH_HOME/perf-lens/metrics-YYYYMMDD.jsonl` (default `~/.dsh/perf-lens/`). Files are kept for
  14 days, capped at 200 MB in total.
- Only costs and counts are written. **Call stacks, function names and file paths are never written
  to disk**; hot functions live in memory while deep mode is on. The disk-footprint scan reads paths
  under `$DSH_HOME` but writes only the resulting byte totals, and the descendant-process reading
  keeps process names in memory only.
- The descendant-process reading runs a process-table command (`ps`, or PowerShell on Windows) every
  30 seconds; that is the only external process Perf Lens starts.
- Unloading the plugin stops all sampling and every timer it owns.

## Troubleshooting

If the panel is empty or the numbers look wrong, check the diagnostics endpoint first:

```powershell
Invoke-RestMethod http://127.0.0.1:3081/api-perf/diagnostics | ConvertTo-Json -Depth 4
```

- `sampleCount` of 0 means the last window collected no samples; `lastError` shows the exception the
  sampling loop caught.
- `ownerRules` should list real package directories (for example `…/node_modules/dsh-context/lib`). If
  it is empty or points at the profile directory, plugin paths could not be resolved and samples will
  land in "unattributed".
- `listenersMeasured` should be `true`. If it is `false` the cordis event registry was not exposed, so
  the Listeners column is a gap rather than a number.
- `processTree.available` should be `true` with a non-zero `at`. If it is `false`, the process-table
  command (`ps`, or PowerShell on Windows) is missing or was denied, and the overview says "unreadable"
  rather than "no children" — those are different facts.
- `diskFootprint` should be non-null with a recent `scannedAt`. `truncated: true` means the walk hit
  its budget or could not open a root, so every on-disk figure is a lower bound.
- **Sampling controls greyed out with a warning.** The host half is loaded once, when `dsh web`
  starts; the panel is a bundle the page fetches. After upgrading the plugin the page can be newer
  than the running host, and a host that predates the three-block controls does not know the fields
  they send — a click would be silently ignored. The panel detects this (the host reports no sampling
  config) and disables the controls instead. Restart `dsh web` to pick up the new host half.
- The same skew affects the endpoint shapes: `/api-perf/snapshot` from a host older than 0.1.0 has no
  `sampling` field, and `/api-perf/trend` from one older than the absolute basis has no `cpuMsPerSec`.

The HTTP API behind the panel (`/api-perf/snapshot`, `/stats`, `/trend`, `/hotspots`, …) is
documented in [docs/design.md §8](docs/design.md#8-http-api).

## Development

```bash
pnpm install      # dev toolchain only; the harness peer packages are not installed (see .npmrc)
pnpm test         # vitest: host specs in node, client specs in jsdom
pnpm typecheck    # tsc --noEmit
pnpm lint         # oxlint
pnpm build        # tsdown: lib/index.js (host) + lib/client.js (single-file client bundle)
```

`prepublishOnly` runs all four.

To try a local checkout, link it into a profile instead of installing from the registry:

```jsonc
// ~/.dsh/profiles/web/package.json
"dependencies": { "dsh-perf-lens": "link:D:/Build/dsh-perf-lens" }
```

Rebuild with `pnpm build`, then reload the page to pick up client changes; host changes need a
restart of `dsh web`.

The harness client type packages are not installed as dev dependencies: their registry `latest` tag
points at a broken 0.0.1-rc.1 line that depends on an unpublished package. The client declares the
structural types it needs in `src/client/ctx.ts` instead, as dsh-context does.

## Documentation

| Document | Contents |
| --- | --- |
| [docs/feasibility.md](docs/feasibility.md) | Why this works: runtime facts, each mechanism verified, overhead, limits |
| [docs/landscape-survey.md](docs/landscape-survey.md) | Who else attributes runtime cost to a plugin: the DSH ecosystem, other plugin hosts, continuous profilers, and what to borrow |
| [docs/roadmap-proposals.md](docs/roadmap-proposals.md) | Proposed features after the survey, ordered by which promise gaps are real |
| [docs/design.md](docs/design.md) | Architecture: attribution, metric contract, sampling state machine, persistence, HTTP API, dashboard layout, decisions |
| [docs/evidence.md](docs/evidence.md) | Raw measured output behind every conclusion, and how to reproduce it |
| [docs/design-overnight-analyzer.md](docs/design-overnight-analyzer.md) | Research on continuous background analysis: sampler cost, heap snapshots (rejected), share vs absolute cost, detection precision |
| [probes/README.md](probes/README.md) | The one-off research scripts and what each one established |
| [CHANGELOG.md](CHANGELOG.md) | What each release contains |

## License

[MIT](LICENSE)
