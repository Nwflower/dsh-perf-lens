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
  idle.
- **Cost composition** — how much of the whole process each plugin takes, for CPU and for sampled
  heap.
- **Top consumers** — the plugins costing the most right now, with their average and peak.
- **Trend** — CPU per plugin over the last hour, day or week.
- **Cumulative cost ranking** — who burned the most CPU over that range.
- **Plugin detail** — every plugin grouped and sortable, with the heaviest harness packages broken
  out and, in deep mode, each plugin's hot functions.
- **Foreground jank** — long tasks and dropped frames in the browser, next to what the host was busy
  with at the time.

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

## Sampling modes

Sampling is never free, so Perf Lens samples in short windows and lets you choose how hard it looks.
Every switch takes effect immediately.

| Mode | What it does | When to use it |
| --- | --- | --- |
| **Intermittent** (default) | A 5-second window every 30 seconds or more; backs off to 2 minutes when the host is idle, with a cheap 1-second check every 10 seconds so bursts are not missed | Always on |
| **Continuous sampling** | Back-to-back 2-second windows; returns to intermittent after 10 minutes | While you are actively watching something |
| **Background sampling** | A coarse 2-second window every 2 minutes | A cheap long-term record |
| **Deep sampling** | Adds heap sampling, hot functions per plugin, and credit for work a plugin schedules through harness callbacks | When you need memory figures or want to know *which function* |
| **Pause sampling** | Stops sampling | — |

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

### Limits

- **There is no per-plugin RSS.** One process means one RSS. Memory figures are sampled heap
  allocations from deep-mode windows, not a plugin's footprint.
- **Disk bytes are not measured.** Per-plugin file *operation* counts are exact; byte counts, timer /
  listener / handle counts and disk footprint are not implemented yet and read as empty.
- **Only the host process.** Child processes (subprocess runners, terminals, language servers) and
  browser memory are not covered.
- **Short windows are noisy.** One window is good for "who is busy"; the cumulative ranking is the
  precise view.

## Data and privacy

- Everything stays on your machine. The panel talks only to your own DSH host.
- Each sampling window appends one line of aggregated numbers to
  `$DSH_HOME/perf-lens/metrics-YYYYMMDD.jsonl` (default `~/.dsh/perf-lens/`). Files are kept for
  14 days, capped at 200 MB in total.
- Only costs and counts are written. **Call stacks, function names and file paths are never written
  to disk**; hot functions live in memory while deep mode is on.
- Unloading the plugin stops all sampling.

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
| [docs/design.md](docs/design.md) | Architecture: attribution, metric contract, sampling state machine, persistence, HTTP API, dashboard layout, decisions |
| [docs/evidence.md](docs/evidence.md) | Raw measured output behind every conclusion, and how to reproduce it |
| [docs/design-overnight-analyzer.md](docs/design-overnight-analyzer.md) | Research on continuous background analysis: sampler cost, heap snapshots (rejected), share vs absolute cost, detection precision |
| [probes/README.md](probes/README.md) | The one-off research scripts and what each one established |
| [CHANGELOG.md](CHANGELOG.md) | What each release contains |

## License

[MIT](LICENSE)
