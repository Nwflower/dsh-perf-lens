# Probes

可行性调研期的一次性验证脚本。每个脚本自包含、无外部依赖、自行清理临时文件，
输出可直接与 [docs/evidence.md](../docs/evidence.md) 的记录对照。

这些脚本的作用是**锁定机制性事实**，不是产品代码。实现阶段应把它们的关键路径
转成正式单测（尤其是 `04-ancestor-walk.mjs` 的比值断言）。

## 运行

```powershell
cd probes
node 01-esm-builtin-patchability.mjs
node 02-inspector-attribution.mjs
node 03-overhead.mjs
node 04-ancestor-walk.mjs
node 05-io-counters.mjs
node 06-async-hooks-fs.mjs
node 07-runtime-composition.mjs
```

## 清单

| 脚本 | 验证的结论 | 对应证据 |
| --- | --- | --- |
| `01-esm-builtin-patchability.mjs` | ESM 命名导入的内置模块无法被 monkey-patch；`v8.startSamplingHeapProfiler` 不存在，堆采样须走 inspector | [证据 3](../docs/evidence.md#证据-3esm-命名导入的内置模块无法被-monkey-patch) |
| `02-inspector-attribution.mjs` | CPU profile 与堆采样都能按 `callFrame.url` 归因到模块 | [证据 4](../docs/evidence.md#证据-4cpu-与堆分配可按模块-url-归因) |
| `03-overhead.mjs` | 采样开销矩阵；`Profiler.stop` 空转抛错 | [证据 8](../docs/evidence.md#证据-8采样开销矩阵) |
| `04-ancestor-walk.mjs` | **决定性**：归因必须做祖先栈回溯，按文件归属会失效 | [证据 5](../docs/evidence.md#证据-5决定性归因必须做祖先栈回溯) |
| `05-io-counters.mjs` | 进程级磁盘 I/O 操作次数可零依赖获取（Windows 实测精确） | [证据 6](../docs/evidence.md#证据-6进程级磁盘-io-操作次数精确零依赖) |
| `06-async-hooks-fs.mjs` | `async_hooks` + `AsyncLocalStorage` 零补丁按插件统计文件操作 | [证据 7](../docs/evidence.md#证据-7按插件的文件操作次数精确零补丁) |
| `07-runtime-composition.mjs` | `runtime` 桶由 GC / node 内部 / 原生帧 / 事件循环组成，必须细分 | [证据 9](../docs/evidence.md#证据-9runtime-桶的构成必须细分) |

## 注意事项

- 这些脚本测量的是 **Node 运行时能力**，与 DSH 无关；结论对 Electron 宿主同样成立。
- `03-overhead.mjs` 的绝对数字随机器波动，**看比值不看绝对值**，且属于微基准最坏情况。
- `05-io-counters.mjs` 给的是**操作次数**，不是字节数。不要据此推导流量。