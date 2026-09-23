# AGENTS.md

For AI agents and collaborators working in this repository.

## What this repository is

`dsh-perf-lens` — a DeepSeek Harness plugin that shows which plugin is using the host's CPU, memory
and disk. It replaces "write a throwaway profiling script every time something is slow" with a
permanent panel in the web GUI.

Phase 1 and Phase 2 have shipped and the package is being prepared for its first release (0.1.0):
the host sampling pipeline (attribution / sampler / IoTracker / process metrics / JSONL history /
routes) and the dashboard (sidebar.panellist entry + main panel) are in place, with the four gates
(test / typecheck / lint / build) green. What each release contains is in `CHANGELOG.md`; what is
still open is in `docs/design.md` §12.

## Hard constraints (from research findings; must not be violated when implementing)

1. **Attribution must walk the ancestor stack.** Follow the parent pointers of the CPU profile / heap
   sampling tree up to the nearest plugin stack frame; never attribute by "which file the function is
   defined in". The latter was measured to dump 573/574 samples into an unattributable bucket.
   See `docs/evidence.md` evidence 5.
2. **Do not monkey-patch `node:fs` and claim to have measured disk I/O.** ESM named-import bindings are
   snapshotted at instantiation, so the patch is silently bypassed, producing systematically low fake
   data. See `docs/evidence.md` evidence 3.
3. **Never leave dual sampling permanently on.** Measured +15% ~ +26% on a pure compute workload (two
   runs). Must use duty-cycle rotation + on-demand deep sampling + self-frame exclusion.
4. **Inexact metrics must carry a coverage marker.** Especially disk bytes. Better to display
   "≥ N (insufficient coverage)" than to present an estimate as an exact value. This is the biggest
   product risk of this approach.
5. **`Profiler.stop` must be strictly paired.** A no-op call throws `ERR_INSPECTOR_COMMAND`; the state
   machine must maintain this explicitly.
6. **Sampling must stop unconditionally when the plugin unloads** (via the cordis effect disposer); no
   background sampling may be left running.

## Documentation discipline

- `docs/feasibility.md` is the single source of truth for feasibility; update it when conclusions
  change, and do not restate them elsewhere.
- `docs/evidence.md` records **raw observed output**. Any new mechanistic conclusion must come with
  reproducible evidence.
- `docs/design.md` is the finalized architecture design; architecture-level changes must update it
  first, along with the decisions table (§13).
- `CHANGELOG.md` records user-visible changes; add to the unreleased section as features land.
- Probe scripts are one-off evidence, not product code; once key paths have been converted into proper
  unit tests during implementation, consider archiving `probes/` rather than extending it further.

## Language

- Documentation, code comments and commit messages are in English.
- Probe output quoted in `docs/` stays verbatim, even where a probe prints Chinese labels.
- User-facing panel strings are bilingual and live only in `src/client/i18n.ts`.

## Temporary files

Temporary files go in the system temp directory or this repo's `.tmp/` (gitignored); delete them once
they are no longer needed.

## Related repositories

- `D:\Build\deepseek-harness` — DSH source (the only authority for mechanism questions; do not guess)
- `D:\Build\dsh-chat-import` — external plugin paradigm reference: host route registration, client
  single-file bundle, slot registration
- `D:\Build\dsh-context` — another external plugin; its `.tmp/probe/` is the source of the throwaway
  probe-script methodology that this project replaces