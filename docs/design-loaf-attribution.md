# Long Animation Frames: per-plugin browser jank attribution

Status: implementation landed (contract, host resolution, client collection, panel) with all four
gates green; live evidence is in evidence.md §17, including the platform finding that reshaped
acceptance (§5). Supersedes the premise of design.md decision #9 and closes roadmap-proposals.md
item 13. Owner repo constraint references: AGENTS.md hard constraint 4 (inexact metrics carry a
coverage marker) and the §7 privacy red line (no call stacks, function names or file paths on
disk).

## 1. Why the current design cannot see this class of jank

The host sampler attributes work that runs **in the Node host process**. The jank that motivated
this document (two chat plugins fighting over `document.body` MutationObserver deliveries during
streaming) runs entirely on the **renderer main thread** of the GUI page. It produces zero frames
in a host CPU profile, so every host-side attribution mechanism is structurally blind to it.

The browser-side piece that exists today (`src/client/vitals.ts`) observes `longtask` and rAF
gaps. The Long Tasks API carries no script attribution, which is what decision #9 recorded. That
premise is outdated: the **Long Animation Frames API** (LoAF, Chromium 123+) reports, per frame
longer than 50 ms, a `scripts` array with `sourceURL`, `sourceCharPosition`,
`sourceFunctionName`, `invoker`, `invokerType`, `executionStart`, `duration` and
`forcedStyleAndLayoutDuration` — designed exactly for "which script made this frame long".

## 2. Mechanism facts verified before this design (do not re-litigate)

All facts below were checked against the running GUI (`dsh-app://app/`) and the DSH source
checkout (`D:\Build\deepseek-harness`):

1. **LoAF is available in the GUI.** `PerformanceObserver.supportedEntryTypes` in the live page
   contains `long-animation-frame`.
2. **Plugin bundles execute as classic scripts.** The client module system appends
   `<script src>` and removes the element after load
   (`packages/client/modules/src/client/system.ts:16-29`). Removal does not affect frame
   attribution; the script URL stays on every frame the bundle leaves on the main thread.
3. **Bundle URLs come in three forms** (`packages/client/modules/src/index.ts`):
   - batch combo: `plugins/??<id1>/client.js,<id2>/client.js&rev=<rev>` — several plugins in one
     response;
   - one-resource combo: `plugins/??<id>/client.js&rev=<rev>` — graph row form, one plugin;
   - package chunk: `plugins/<id>/client.<name>.js?rev=<rev>` — dynamic import chunks.
4. **Multi-plugin batches are the normal case, not an edge case.** The live boot manifest packs
   external plugins into application batches (observed: one 14-entry batch containing
   `dsh-claude-style` alongside `dsh-context`, `dsh-cost-meter` and others). A design that
   only handles the one-resource form attributes nothing for the plugins users actually install.
5. **Batch bodies are a plain concatenation** (`index.ts` `buildComboScript`): each part is
   `prepareSource(resource).source` followed by `;` and one newline, in the order the
   `??` list names, with no per-part `//# sourceURL=` trailer. `prepareSource`
   (`index.ts:305-314`) strips the authored `sourceURL`/`sourceMappingURL` trailers and ensures
   a trailing newline. Part boundaries are therefore **deterministic UTF-16 offsets**:
   `start(i+1) = start(i) + prepared(i).length + 2`.
6. **Per-plugin client.js paths are resolvable host-side.** `src/host/plugin-index.ts` already
   maps every plugin to its package directory (`baseUrl`); the `exports["./client"]` string
   (same resolution as `clientExportOf`, `index.ts:195-205`) gives the file inside it.
7. **The combo source map exists but is the wrong tool.** `buildComboSourceMap` serves an
   indexed map whose identity sections embed `sourcesContent` — fetching it per jank window
   costs more than the bundle itself. Fact 5 gives the same answer arithmetically.
8. **The desktop window withholds script attribution.** Measured after implementation
   ([evidence 17a](evidence.md#evidence-17-loaf-script-attribution--where-it-works-and-what-it-resolves)):
   on `dsh-app://app/`, Chromium reports long-animation-frame entries but every frame's `scripts`
   list is empty, including forced frames whose blocking time is one named script. Attribution
   therefore works on the `dsh web` GUI (an ordinary http origin) and the desktop window keeps the
   correlation fallback — the same graceful-degradation path as a pre-123 engine, triggered there
   by empty script lists rather than a missing entry type.

## 3. Design

### 3.1 Collection (client)

New `src/client/loaf.ts`:

- One `PerformanceObserver` of type `long-animation-frame`, created with `buffered: true`
  so frames just before startup are not lost; feature-detected via
  `PerformanceObserver.supportedEntryTypes`, degrading to `supported: false` reports. On the
  desktop window (fact 8) frames arrive with empty script lists, which resolves to an empty row
  set — the panel shows no table there, the same visible outcome as the unsupported fallback.
- Per script entry, retain: `url`, `charPosition`, `functionName` (empty string allowed),
  `invokerType`, `durationMs`, `forcedLayoutMs`, `executionStart`.
- Window aggregation stays with the existing vitals cadence: the entries of one window are folded
  into a **capped** list — top 50 scripts by duration, the remainder folded into an `other`
  count+ms pair, so the window total stays honest and the POST body stays bounded.
- Pure aggregation function exported separately from the observer plumbing, unit-tested in jsdom
  with fabricated entry lists.

### 3.2 Reporter lifecycle (client)

Today `startVitalsReporter` starts on panel mount (`src/client/panel.tsx:169`), so jank during
ordinary chat use — panel closed — is never observed. That is precisely the reported failure
mode. The reporter moves to the client entry init (`src/client/index.tsx`), posting on
the same cadence whether or not the panel is open. LoAF only fires on frames over 50 ms and the
rAF tick already exists, so the always-on cost is one observer registration plus rare callbacks.

### 3.3 Contract (shared)

`ClientVitals` gains one optional field:

```ts
readonly loaf?: {
  readonly supported: boolean
  readonly scripts: readonly RawLoafScript[]  // capped; see 3.1
  readonly otherCount: number
  readonly otherMs: number
}
```

`RawLoafScript` = { url, charPosition, functionName, invokerType, durationMs, forcedLayoutMs }.

The honesty-rule comment above `ClientVitals` (`contract.ts:361-369`) is rewritten: long tasks
stay unattributable; LoAF script time **is** attributable and must carry a coverage marker.

`VitalsView` gains the resolved form:

```ts
readonly jank?: {
  readonly rows: readonly { owner: string; durationMs: number; forcedLayoutMs: number; count: number }[]
  /** Share of long-frame script time that resolved to an owner, 0..1 — the coverage marker. */
  readonly attributedShare: number
}
```

Owner key vocabulary reuses the host side: `plugin:<name>`, `harness`, `self`,
`unresolved`. Raw script entries live in the vitals ring only; per the privacy red line,
**nothing function-name or path shaped is persisted** — the JSONL history keeps recording the
existing aggregated vitals numbers and gains at most per-owner millisecond totals.

### 3.4 Resolution (host)

New `src/host/loaf-map.ts`:

- `parsePluginUrl(url)` → `{ kind: 'batch', ids } | { kind: 'single', id } | { kind: 'chunk', id } | { kind: 'other' }`.
  Anything outside the three plugin forms is `harness` (shell `assets/index-*.js`) or
  `other` (extensions, about:blank, inline).
- `single` and `chunk` resolve directly to `plugin:<id>` (or `harness` for
  `@deepseek-ai/*` via the existing `ownerOfModule` rule, keeping path and fiber vocabularies
  identical).
- `batch` resolves via a **segment table**: read each listed plugin client.js (plugin-index
  `baseUrl` + `exports["./client"]`), replicate `prepareSource` byte-for-byte (strip both
  trailer regexes, ensure trailing newline), and accumulate `start(i+1) = start(i) +
  prepared(i).length + 2`. A script entry resolves to the segment containing
  `charPosition`. Tables are cached per combo URL (rev is in the URL, so no invalidation
  bookkeeping) with a bounded LRU.
- A part whose file cannot be read renders the entries of that segment `unresolved` — never a
  guess. The window `attributedShare` is computed over all script milliseconds, including
  `other`.

`src/host/vitals.ts` extends `parseVitals` to narrow the new field (rejecting malformed bodies
as today) and resolves entries to owners in `record()`, so the ring and `VitalsView` store
only resolved rows. `src/host/routes.ts` wires the resolver in; no new endpoint.

### 3.5 Panel (client)

The "Foreground jank" block becomes:

- Existing summary line (smooth/janky, long tasks, frame gap p95) — unchanged.
- New table when `jank` rows exist: **plugin | script ms | forced-layout ms | frames hit**,
  sorted by script ms, harness/self/unresolved folded per the existing grouping rules.
- Coverage line under the table: "N% of long-frame script time attributed" (marker required by
  hard constraint 4); `unresolved` is listed as its own row, never silently dropped.
- When `loaf.supported === false` (older Chromium), the block is exactly the current correlation
  view with the "correlation ≠ causation" label — the fallback is explicit.
- All strings bilingual in `src/client/i18n.ts` only; layout in `styles/panel.css`.

### 3.6 What this deliberately does not do

- No attribution of browser-side layout/paint/compositing that no script forced (LoAF attributes
  script execution and script-forced style/layout; the remainder stays in the frame-level totals).
- No mutation-rate heuristics (`data-dsh-plugin` DOM-root counting): it measures DOM churn, and
  the cost of the motivating case is JS scan time per mutation, which DOM counts would misrank.
- No persistence of raw script entries, and no new child-process or renderer metrics.

## 4. Implementation plan

Ordered so every step lands green; each step ships with its tests in the same change.

1. `src/shared/contract.ts` — types above + rewritten honesty comment; `test/api.test.ts` and
   `test/routes.test.ts` updated for the widened shapes.
2. `src/host/loaf-map.ts` — URL parsing and segment-table builder, pure functions taking
   file bytes (fixtures replicate `prepareSource` edge cases: no trailing newline, authored
   sourceURL trailer, missing file → unresolved segment); `test/loaf-map.test.ts`.
3. `src/host/vitals.ts` — `parseVitals` narrowing + `record()` resolution + ring shape;
   `test/vitals.test.ts` (host specs run in node).
4. `src/client/loaf.ts` — observer + pure aggregation (cap folding, empty windows,
   unsupported environment); `test/client/loaf.test.ts` in jsdom.
5. `src/client/vitals.ts` + `src/client/index.tsx` + `src/client/panel.tsx` — reporter moves
   to entry init; panel consumes `VitalsView.jank`; `test/client/vitals.test.ts`,
   `test/client/panel.test.tsx`.
6. `src/client/i18n.ts` + `src/client/styles/panel.css` — table strings (zh/en) and layout.
7. `probes/23-loaf-attribution.mjs` — live evidence: headless Chrome against a running
   `dsh web`, open a session, stream a long answer with `dsh-claude-style` and
   `@alm-allen/dsh-chat-ux` both active, dump raw LoAF entries and the resolved rows; raw
   output pasted into `docs/evidence.md` as a new numbered evidence entry, including the grep
   proving no function names or paths reached the JSONL metrics file.
8. Documentation pass: design.md decision #9 rewritten (LoAF attribution with coverage marker;
   the correlation view is the unsupported-browser fallback) plus a new decisions-table row for
   the reporter-lifecycle change; roadmap-proposals.md item 13 marked superseded by this
   document; feasibility.md §6 gains the LoAF limit; README "What you get" bullet, "Reading the
   numbers" bullet and "Limits" bullet; CHANGELOG unreleased entry.
9. Gates: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` — all four green.

## 5. Acceptance criteria

- All four gates green on the final tree.
- Unit coverage exists for: all three URL forms plus non-plugin URLs; segment arithmetic against
  fixtures replicating `prepareSource` exactly; aggregation cap folding with totals preserved;
  `parseVitals` rejecting malformed `loaf` bodies; panel rendering rows, the coverage line and
  the unsupported-browser fallback.
- Live evidence (evidence.md §17): two captures in the real GUI during streamed answers (375 +
  525 long frames) established that the desktop window's browser withholds `scripts` entirely —
  a platform finding that supersedes the original capture-and-resolve criterion, and the panel's
  empty-rows fallback is the designed response to it (unit-tested). Plain-http attribution and the
  byte-exact combo reconstruction are proven in headless Chrome (17b). The remaining `dsh web`
  http verification ships ready-made as probe 23's live mode, to run where a token-bearing URL
  exists. Downgraded 2026-09-25 at the user's call: `@alm-allen/dsh-chat-ux` is not required in
  the capture.
- The privacy check in the probe shows the JSONL metrics file free of function names and script
  paths.
- Docs checklist in step 8 fully applied; no statement of decision #9 survives that claims
  browser attribution is impossible.
