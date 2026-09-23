# Probes

One-off scripts written during research to pin down how the runtime actually behaves. Each one is
self-contained, has no dependencies and cleans up its own temporary files; the output can be checked
directly against [docs/evidence.md](../docs/evidence.md) and the design documents.

They **lock in mechanism facts** and are not product code. The key paths have been turned into unit
tests (the ancestor-walk ratio from `04-ancestor-walk.mjs` lives in `test/attribute.test.ts`), so new
work should add tests rather than more probes.

## Running

```powershell
cd probes
node 01-esm-builtin-patchability.mjs
node 02-inspector-attribution.mjs
node 03-overhead.mjs
node 04-ancestor-walk.mjs
node 05-io-counters.mjs
node 06-async-hooks-fs.mjs
node 07-runtime-composition.mjs
node 08-cpu-clock-quantization.mjs
node 09-sampler-cost-matrix.mjs            # run 3 times and read the trend; never quote one run
node --max-old-space-size=4096 10-heap-snapshot-and-analyzer.mjs
$env:DSH_HOST_PID=<pid>; node --max-old-space-size=4096 11-real-host-heap-snapshot.mjs
node 12-history-share-audit.mjs            # reads the real history in $DSH_HOME/perf-lens
node --max-old-space-size=8192 13-real-host-anchor-discovery.mjs  # needs the snapshot from 11
node --max-old-space-size=8192 14-heap-snapshot-module-owners.mjs <snapshot> <rules.json>
node 15-empty-window-audit.mjs            # empty windows / resolution / cadence (real history)
node 16-achieved-sample-rate.mjs          # configured interval vs the sampling rate achieved
node 17-log-line-compaction.mjs            # share of all-zero rows in the JSONL and the slimmed size
node 18-sentinel-cost.mjs                  # sampling budget added by the two-tier sentinel
node 19-mechanism-c.mjs                    # can async_hooks windows re-attribute async work (mechanism C)?
```

## Inventory

| Script | What it establishes | Evidence |
| --- | --- | --- |
| `01-esm-builtin-patchability.mjs` | Built-ins imported by ESM name cannot be monkey-patched; `v8.startSamplingHeapProfiler` does not exist, so heap sampling goes through the inspector | [Evidence 3](../docs/evidence.md#evidence-3-built-ins-imported-by-esm-name-cannot-be-monkey-patched) |
| `02-inspector-attribution.mjs` | Both the CPU profile and heap sampling can be attributed to modules by `callFrame.url` | [Evidence 4](../docs/evidence.md#evidence-4-cpu-and-heap-allocation-can-be-attributed-by-module-url) |
| `03-overhead.mjs` | Sampling overhead matrix; `Profiler.stop` throws when idle | [Evidence 8](../docs/evidence.md#evidence-8-sampling-overhead-matrix) |
| `04-ancestor-walk.mjs` | **Decisive:** attribution must walk the ancestor stack; per-file attribution fails | [Evidence 5](../docs/evidence.md#evidence-5-decisive-attribution-must-walk-the-ancestor-stack) |
| `05-io-counters.mjs` | Process-wide disk I/O operation counts need no dependencies (exact on Windows) | [Evidence 6](../docs/evidence.md#evidence-6-process-wide-disk-io-operation-counts-exact-no-dependencies) |
| `06-async-hooks-fs.mjs` | `async_hooks` + `AsyncLocalStorage` count file operations per plugin without patching | [Evidence 7](../docs/evidence.md#evidence-7-per-plugin-file-operation-counts-exact-no-patching) |
| `07-runtime-composition.mjs` | The `runtime` bucket is GC, Node internals, native frames and the event loop, and must be split | [Evidence 9](../docs/evidence.md#evidence-9-the-runtime-bucket-must-be-split) |
| `08-cpu-clock-quantization.mjs` | `process.cpuUsage()` is quantized to ~15.6ms on this machine: a short slice reads 0 or 16ms | [Background analyzer §3](../docs/design-overnight-analyzer.md) |
| `09-sampler-cost-matrix.mjs` | Tier cost matrix: CPU profiler cost rises with the sampling rate; heap sampling has no fixed cost on compute workloads | [Background analyzer §4](../docs/design-overnight-analyzer.md) |
| `10-heap-snapshot-and-analyzer.mjs` | Snapshot cost (668MB heap → 760ms pause) and child-process parsing cost (dominators + attribution 286ms) | [Background analyzer §5](../docs/design-overnight-analyzer.md) |
| `11-real-host-heap-snapshot.mjs` | A snapshot of the real host freezes its event loop for 8.7–10.3s | [Background analyzer §11.1](../docs/design-overnight-analyzer.md) |
| `12-history-share-audit.mjs` | In real history harness holds ~75% **share** but only ~0.75% of one core in **absolute** terms; the share's denominator is active samples | [Background analyzer §6.5](../docs/design-overnight-analyzer.md) |
| `13-real-host-anchor-discovery.mjs` | A real heap has **no** recognisable plugin root: identity lives only in string/code nodes, candidate anchors retain ≈ 0, and idom and DFS attribution disagree on 89.7% of bytes | [Background analyzer §11.2](../docs/design-overnight-analyzer.md) |
| `14-heap-snapshot-module-owners.mjs` | A **dominator** partition rooted at modules: only **0.3% (1.2MB / 363.9MB)** of a real heap belongs to any module and **99.7% has no module root**; the old DFS-tree basis overstated it at 10.7% (corrected in review) | [Background analyzer §11.2](../docs/design-overnight-analyzer.md) |
| `15-empty-window-audit.mjs` | The three meanings of an "empty window" in real history: never 0 samples; at 99.1% idle a median of only **17 active samples per window** (5.9% share granularity); idle backoff stretches the gap to a p90 of **125s** | [Background analyzer §13](../docs/design-overnight-analyzer.md) |
| `16-achieved-sample-rate.mjs` | **The configured 250µs does not take effect on Windows:** 100/250/500µs all achieve ~540µs (the platform tick floor); only 1000µs actually halves the rate | [Background analyzer §13](../docs/design-overnight-analyzer.md) |
| `17-log-line-compaction.mjs` | In the real JSONL only **4.0 of 218.6 rows per window** have activity; dropping all-zero rows takes a line from 67.9 KB to 1.5 KB (**−97.8%**) | [Evidence 10](../docs/evidence.md#evidence-10-all-zero-rows-made-up-98-of-the-log) |
| `18-sentinel-cost.mjs` | Two-tier sentinel budget: a 1s probe is **98 samples** against **9222** for a 5s fine window; 11 probes per 120s backoff = **+11.7% sampling budget** | [Background analyzer §13.7](../docs/design-overnight-analyzer.md) |
| `19-mechanism-c.mjs` | Mechanism C measured: in one profile the stack gives all 714 samples to harness, while async-window correlation hands **701** back to the plugin; V8's profile clock is monotonic since boot and must be rebased | [Evidence 11](../docs/evidence.md#evidence-11-mechanism-c-async-boundaries-is-attributable) |

## Notes

- These scripts measure **Node runtime behaviour**, not DSH; the conclusions hold for an Electron
  host too.
- The absolute numbers from `03-overhead.mjs` and `09-sampler-cost-matrix.mjs` vary by machine:
  **read ratios and trends, not absolute values**, and remember they are worst-case microbenchmarks.
  `09` has a noise floor of about ±4%.
- `05-io-counters.mjs` reports **operation counts**, not bytes. Do not derive throughput from it.
- `08`'s quantization is **platform-specific** (about 15.6ms on Windows). Run `08` on a platform
  before measuring CPU deltas there, or you will conclude "zero overhead" from noise.
- `10` defaults to a 300MB heap (set `PROBE_HEAP_MB`); give `--max-old-space-size` enough room or it
  runs out of memory before the snapshot exists.
- `11` attaches to a **running host** and needs `DSH_HOST_PID`. The host freezes during the snapshot,
  so do not run it while someone is using it.
- `13` / `14` only read the snapshot file and never touch the host. They complement each other: `13`
  asks "what in the graph carries plugin identity", `14` asks "how many bytes can be assigned with
  modules as roots". `14` needs a rules JSON:
  `Invoke-RestMethod http://127.0.0.1:3081/api-perf/diagnostics | ConvertTo-Json -Depth 6 | Set-Content $env:TEMP\pl-rules.json -Encoding UTF8`.
- `12` reads **real runtime data** and produces none; with no history files it exits straight away.
  It reports two measures, `cpuShare` (share of active samples) and `ms/sampled-sec` (absolute).
  **Only the latter compares across hosts**; the former is inflated by orders of magnitude on an idle
  host.
