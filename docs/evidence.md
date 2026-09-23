# 实测证据

本文件记录 [feasibility.md](feasibility.md) 中每条结论对应的**原始观测输出**与**复现方式**。

- 环境：Windows / Node v24.18.0 / @deepseek-ai/dsh 0.1.7-alpha.1（GUI 宿主为纯 Node 进程）
- 探针脚本位于 [`probes/`](../probes/)，全部可独立运行，无外部依赖
- 所有探针都在**普通 Node 进程**中运行；机制本身与 DSH 无关，是 Node 运行时能力

---

## 证据 1：运行时形态（宿主是纯 Node 单进程）

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId,@{n='WS_MB';e={[math]::Round($_.WorkingSetSize/1MB,1)}},CommandLine
```

观测：

```
ProcessId  WS_MB  CommandLine
    28108  680.80  "D:\Program Files\nodejs\node.exe" C:\Users\...\@deepseek-ai\dsh\lib\bin.js web --port 3081
```

**结论**：
- 当前 GUI（`http://127.0.0.1:3081`）由**单个 Node 进程**承载，RSS ≈ 680 MB。
- 全部 host 插件同进程 → 不存在 OS 级「每插件内存」，必须进程内归因。
- 纯 Node（非 Electron）→ `node:inspector` / `v8` / `async_hooks` 全部可用，无需 `--inspect` 端口。

---

## 证据 2：插件可枚举

来源：harness 自身实现 `packages/host/plugin-inventory/src/index.ts`。

```ts
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']
  ...
  for (const entry of ctx.loader.entries()) {
    if (entry.options.group) continue
    const base = entry.parent.tree.ctx.baseUrl
    const meta = base === undefined ? undefined : packages?.metaOf(entry.options.name, base)
    entries.push({ entryId: entry.id, moduleName: entry.options.name, enabled: !entry.disabled, ... })
  }
}
```

**结论**：任何 host 插件只要 `inject: ['loader']` 就能枚举插件清单，并拿到
`moduleName` / `entryId` / fiber 状态 / 路径解析基准。归因映射表由此建立。

---

## 证据 3：ESM 命名导入的内置模块**无法**被 monkey-patch

探针：[`probes/01-esm-builtin-patchability.mjs`](../probes/01-esm-builtin-patchability.mjs)

```
ns readFileSync patched? true
named-import saw patch: NO
v8 keys: getCppHeapStatistics,getHeapCodeStatistics,getHeapSnapshot,getHeapSpaceStatistics,getHeapStatistics,setHeapSnapshotNearHeapLimit,writeHeapSnapshot
startSamplingHeapProfiler: undefined stop: undefined
inspector ok: function
```

**结论**：
1. 替换 `fs.readFileSync` 后，`fs` 命名空间对象确实变了，但**命名导入绑定不变**——
   `import { readFileSync } from 'node:fs'` 走的是实例化时快照的绑定。
   → 「补丁 fs 模块」对插件主流的 ESM 命名导入**静默失效**，会产出系统性偏低的假数据。
2. `v8.startSamplingHeapProfiler` 在本 Node 版本**不存在**；堆采样必须走
   `inspector` 的 `HeapProfiler.startSampling`。
3. `v8.writeHeapSnapshot` 存在 → 精确 retained size 走「落盘 + 离线解析」。

---

## 证据 4：CPU 与堆分配可按模块 URL 归因

探针：[`probes/02-inspector-attribution.mjs`](../probes/02-inspector-attribution.mjs)

```
cpu profile nodes: 9 samples: 83
heap sampling samples: 1

CPU self-time by frame url:
     65  /D:/Build/Temp/feas-inspector.mjs
     17  (native)
      1  node:inspector

Allocation self-size by frame url (bytes):
       4144  /D:/Build/Temp/feas-inspector.mjs

heap stats: {"heapUsed":5190784}
writeHeapSnapshot available: function
```

**结论**：`Profiler.start/stop` 给出 `samples[]` + `nodes[].callFrame.url`；
`HeapProfiler.startSampling/stopSampling` 给出带 `selfSize` 的 callFrame 树。
两者都能按 url 聚合，而插件产物是自带 bundle 的 `lib/index.mjs`，url 与插件一一对应。

> 注：堆采样的 `selfSize` 落在哪个 url 上**逐次运行会变**（第二次运行落在 `node:inspector`，
> 因为采样窗口内最近的一次分配发生在那里）。这正说明该指标是**统计量**，
> 面板必须展示样本数与窗口长度，不能把单次结果当定值。

---

## 证据 5（决定性）：归因必须做**祖先栈回溯**

探针：[`probes/04-ancestor-walk.mjs`](../probes/04-ancestor-walk.mjs)

构造：`pluginA.runA(200)` 与 `pluginB.runB(60)` 各自循环调用**同一个共享依赖** `shared/dep.mjs`。
真实成本比应为 200 : 60 = **3.33**。

```
direct (self-frame) attribution:
   573  (shared/other)
     1  pluginA

ancestor-walk attribution:
   441  pluginA
   131  pluginB
     2  (unattributed)
```

| 策略 | pluginA | pluginB | 比值 | 结论 |
| --- | --- | --- | --- | --- |
| 按栈帧自身归属 | 1 | 0 | — | **失效**：573/574 样本落进无法归属的共享桶 |
| 祖先栈回溯 | 441 | 131 | 3.37 | 与真实比 3.33 误差 < 1.5% |

第二次运行（同一脚本，采样窗口内样本分布不同）：

```
direct (self-frame) attribution:
   601  (shared/other)
     1  pluginB

ancestor-walk attribution:
   469  pluginA
   131  pluginB
     2  (unattributed)

ancestor-walk ratio = 3.58
```

两次运行都指向同一结论：**朴素归属几乎全部失效（601/602、573/574 落入共享桶），
祖先栈回溯稳定给出 3.37 ~ 3.58 的比值（真值 3.33，误差 < 8%）**。
绝对误差来自采样随机性，随窗口加长收敛。

**结论**：归因算法必须是「沿 `nodes[].children` 反向父指针回溯，直到遇到属于某个插件的栈帧」。
这同时解决了「插件依赖的 node_modules 算谁的」——**算调用方插件的**。

> 若采用朴素的文件归属，任何带依赖的插件都会把自己的成本甩给共享依赖，
> 面板会系统性地指错人。

---

## 证据 6：进程级磁盘 I/O 操作次数（精确、零依赖）

探针：[`probes/05-io-counters.mjs`](../probes/05-io-counters.mjs)

```
resourceUsage before: {"fsRead":1,"fsWrite":0}
resourceUsage after : {"fsRead":21,"fsWrite":20}
delta fsRead: 20  delta fsWrite: 20

report.resourceUsage: {"free_memory":9582219264,"total_memory":34137300992,"rss":89481216,
  "userCpuSeconds":0.062,"kernelCpuSeconds":0.156,"cpuConsumptionPercent":21.8,
  "maxRss":128921600,"pageFaults":{"IORequired":43250,"IONotRequired":0},
  "fsActivity":{"reads":21,"writes":23}}
```

**结论**：
- `process.resourceUsage().fsRead / fsWrite` 在 Windows 上给出**精确的进程级读写操作次数**
  （实测 20 写 + 20 读 → delta 恰好 20/20）。
- `process.report.getReport()` 提供同源的 `fsActivity`，外加
  `rss` / `maxRss` / `pageFaults` / `cpuConsumptionPercent`。
- **这是操作次数，不是字节数。** 面板不能把它当作流量展示。

---

## 证据 7：按插件的文件操作次数（精确、零补丁）

探针：[`probes/06-async-hooks-fs.mjs`](../probes/06-async-hooks-fs.mjs)

机制：`AsyncLocalStorage` 标记「当前插件」，`async_hooks` 的 `init(asyncId, type)` 观察
`FSREQPROMISE` / `FSREQCALLBACK` / `FILEHANDLECLOSEREQ` / `FSEVENTWRAP` 等资源类型。

```
per-owner fs async-resource counts:
    2  pluginA :: FILEHANDLECLOSEREQ
    7  pluginA :: FSREQPROMISE
    2  pluginB :: FILEHANDLECLOSEREQ
    4  pluginB :: FSREQPROMISE

(process-level op counts, exact, for calibration)
  fsRead: 5  fsWrite: 10
```

**结论**：**无需任何 monkey-patch** 即可按插件统计异步文件操作。

**局限**：`readFileSync` / `writeFileSync` 不创建异步资源，**不计入**。
同步 I/O 改由 CPU 采样中 `node:fs` 帧的祖先回溯覆盖（次数近似，归属正确）。

---

## 证据 8：采样开销矩阵

探针：[`probes/03-overhead.mjs`](../probes/03-overhead.mjs)

```
--- compute-bound ---
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

**结论**：双采样常开在纯计算负载上 **+15% ~ +26%**（两次运行：+15.1% / +25.8%），不可接受。
必须占空比轮转 + 按需深度采样 + 排除自身帧。

第二次运行（同一脚本）：

```
--- compute-bound ---
baseline                         8 ms
CPU profiler 1000us             10 ms
heap sampling 32KB               8 ms
both                            10 ms
  overhead: cpu +22.7%  heap -1.8%  both +25.8%

--- async+io-mixed ---
baseline                        67 ms
CPU profiler 1000us             65 ms
heap sampling 32KB              70 ms
both                            62 ms
  overhead: cpu -2.1%  heap +5.7%  both -7.3%
```

**读数须知**：这是微基准，绝对百分比波动很大，甚至会出现负值（异步 + I/O 负载被
I/O 等待时间淹没，测量噪声大于采样开销）。可稳定复现的只有一条趋势：
**纯计算负载上「两者同开」始终是最贵的一档**。不要引用单次具体数字做设计决策。

**附带发现**：`Profiler.stop` 在未启动状态下抛
`Inspector error -32000: No recording profiles found`，
start/stop 必须严格配对，状态机需要显式维护。

---

## 复现方式

```powershell
cd D:\Build\dsh-perf-lens\probes
node 01-esm-builtin-patchability.mjs
node 02-inspector-attribution.mjs
node 03-overhead.mjs
node 04-ancestor-walk.mjs
node 05-io-counters.mjs
node 06-async-hooks-fs.mjs
```

全部脚本在临时目录下创建自己的测试文件，运行结束后自行清理。

## 证据 9：`runtime` 桶的构成——必须细分

面板曾把无插件栈帧的样本全部记为一行 `runtime`。实机上面板显示它常驻榜首
（平均 36.8%、峰值 100%），这回答不了任何问题：GC 和 syscall 是两种完全不同的优化方向。

探针：[probes/07-runtime-composition.mjs](../probes/07-runtime-composition.mjs)
（Node v24，3079 个样本，250µs 间隔，3s 混合负载）。

| 叶帧 | 占 runtime 桶 | 归类 |
| --- | --- | --- |
| `(idle)` @ 空 url | 54.7% | `idle`（已在活动样本分母中剔除，不属于 runtime） |
| `(garbage collector)` @ 空 url | 19.2% | `runtime:gc` |
| `write` @ `node:string_decoder` 等 node 内部 | 13.7% + 长尾 | `runtime:node` |
| `fstat` / `writeBuffer` / `close` @ 空 url | 长尾 | `runtime:native` |
| `(program)` @ 空 url | 4.1% | `runtime:event-loop` |

结论：空 url + 有函数名 = 原生/libuv 帧；`node:` 与 `internal/` = node 内部；
`(garbage collector)` = GC；`(root)` / `(program)` = 事件循环/程序根；其余为 `runtime` 残差。
由 `attribute.ts` 的 `runtimeKindOfName` / `runtimeKindOfUrl` 实现，单测锁定。