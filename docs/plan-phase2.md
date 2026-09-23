# Phase 2: from a "geek table" to a usable dashboard

> Status: **done** (all tracks shipped; see the changelog in the README). Kept as the record of what
> was agreed in the author's review; it was the development agent's working brief.
> The hard constraints were unchanged: the six in AGENTS.md plus design.md §7's privacy line
> (frame-level data is never persisted).

## The problems (from a screenshot of the real panel)

1. **A flat 226-row table.** Every official harness sub-package had its own row
   (`harness:@deepseek-ai/dsh-client-hmr`…). The design always said harness folds into one row; the
   implementation missed it. Users want "which plugin is eating resources", not the harness's internal
   module list.
2. **Only instantaneous values.** The table showed only the current window's cpuShare, with no average
   or peak — and the ranking was far down the page.
3. **Series reset on every visit.** Sparkline series lived in client state, so a refresh emptied them.
4. **No groups, no folding of idle rows.** Most plugins cost nothing all year, yet sat alongside the
   real consumers.
5. **Too raw.** Just a table, with no visual hierarchy.

## Direction

### Track 1 · Merging and grouping (host + shared)

- host: `lens.#build` merges every `harness:*` owner into one `harness` row (CPU, heap and I/O).
  Diagnostic ownerKeys keep the raw keys for troubleshooting.
- shared: a new pure `grouping.ts`
  - groups: `external` (plugins from the profile) / `harness` / `runtime` / `self` / `other`;
  - idle rule: CPU, heap, I/O and allocation all zero → the group's "no cost" subset;
  - unit tests lock the grouping and the idle rule.

### Track 2 · Card dashboard (client)

- New `plugin-cards.tsx`: top-N cost cards, each with **current / average / peak** plus a sparkline.
- `metrics-table.tsx` renders by group: a group header (name + count + group share) and its rows;
  idle rows fold into one "No cost this window N" row that expands on click.
- New Average and Peak columns in the table (from stats, joined by moduleName).

### Track 3 · Background sampling profile (host + client)

- New `SampleMode = 'background'`: a low-rate always-on profile
  - `backgroundCpuIntervalUs: 1000` (the default profile uses 250µs), `backgroundWindowMs: 2000`,
    `backgroundIdleMs: 120000`;
  - it keeps sampling and writing JSONL while the panel is closed, so there is history on return.
- `Sampler.startCpu(intervalUs?)` accepts a per-window interval.
- A "Background" button in the controls; the overview always shows the current profile.

### Track 4 · Series seeding (client)

- On mount, seed the sparkline series from the already-loaded `/api-perf/trend` (the last 30 points
  per plugin), so returning to the page no longer starts blank.

### Track 5 · Wrap-up

- All four gates green; add the grouping rules, background profile and seeding strategy to
  design.md's decisions table; one commit per track.

## Explicitly out of scope

Flame graphs; report export; child-process sampling; worker attribution; drag-and-drop or custom
card layouts; theme skins.
