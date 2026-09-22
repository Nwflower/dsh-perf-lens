# DSH 插件性能分析面板 — 可行性分析

> 调研日期：2026-09（环境：Windows / Node v24.18.0 / @deepseek-ai/dsh 0.1.7-alpha.1 与 0.1.5-rc.2）
> 状态：**结论已确认，尚未实现**。所有机制性结论均有实测证据，见 [evidence.md](evidence.md)。

---

## 1. 结论

**可行，但必须接受一条硬边界**：DSH 宿主是**单进程**，不存在「每插件 RSS」这种 OS 级真相。

可行的路径是**进程内采样归因**：

1. 用 `node:inspector` 采样 CPU 与堆分配，把样本**沿调用栈回溯到最近的插件栈帧**；
2. 用 `async_hooks` **零补丁**统计每个插件的文件操作次数；
3. 用 `ctx.loader.entries()` 建立「模块路径 → 插件」映射表；
4. 通过 Web GUI 右侧栏 tab 展示。

CPU、内存分配/存活、文件操作次数、插件清单、面板 UI —— 全部有可靠落点。

**唯一实质性妥协是「每插件磁盘字节数」**：操作次数可精确归因，字节数无法在不做侵入式拦截的前提下精确获取。
详见 [§6 能力边界](#6-能力边界必须标注在-ui-上)。

---

## 2. 运行时事实（已核实）

| 项 | 实测值 |
| --- | --- |
| 当前 GUI 宿主 | PID 28108，`node .../@deepseek-ai/dsh/lib/bin.js web --port 3081` —— **纯 Node 进程**，非 Electron |
| Node 版本 | v24.18.0 |
| 宿主 RSS | ~680 MB（单进程承载全部 host 插件） |
| 已装插件 | `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`：`dsh-base`、`dsh-web-app` + 13 个第三方 bundle |
| 插件可枚举 | `ctx.loader.entries()`，harness 自身的 `@deepseek-ai/dsh-plugin-inventory` 即 `inject = ['loader']`，可拿到 `moduleName` / `entryId` / fiber 状态 / 解析基准 `baseUrl` |
| 插件产物形态 | 各插件自带打包好的 `lib/index.mjs`（host）与 `lib/client.js`（client 单文件 bundle），模块 URL 与插件一一对应，归因干净 |

因为宿主是纯 Node，`node:inspector`、`v8`、`async_hooks`、`process.resourceUsage()` 全部可用，
且**不需要 `--inspect` 端口**（同进程 `new inspector.Session()` 即可）。

> 补充：DSH Desktop（Electron）形态下 host 跑在 Electron 主进程，上述 API 同样可用。结论对两种形态都成立。

---

## 3. 逐项机制的实测验证

### 3.1 CPU 归因 —— 成立

`inspector.Session` → `Profiler.enable` / `start` / `stop` 返回 Chrome CPU profile：
`nodes[].callFrame.url` + `nodes[].children` + `samples[]` 打点。

按 url 前缀映射到插件即可得到每插件 CPU 占比。实测能正确区分模块：

```
CPU self-time by frame url:
     65  /D:/Build/Temp/feas-inspector.mjs
     17  (native)
      1  node:inspector
```

### 3.2 内存归因 —— 成立（两种粒度）

- **分配 / 存活采样**：`HeapProfiler.startSampling` / `stopSampling` 返回带 `callFrame` 的树，节点带 `selfSize`。
  `stopSampling` 返回的是**停止时仍存活**的采样对象 → 这本身就是「按分配点的存活字节」信号，
  比单纯的分配速率更有诊断价值（能区分「一直在分配但被回收」和「真的泄漏/常驻」）。
- **精确 retained size**：`v8.writeHeapSnapshot()` 存在，可落盘后离线解析（`HeapProfiler.takeHeapSnapshot` 亦可）。
- **全局指标**：`v8.getHeapStatistics()`、`process.memoryUsage()`、
  `process.report.getReport()`（含 `rss` / `maxRss` / `pageFaults` / `cpuConsumptionPercent`）。

实测堆采样按 url 聚合输出：

```
Allocation self-size by frame url (bytes):
       4144  /D:/Build/Temp/feas-inspector.mjs
```

### 3.3 决定性实验：归因必须做「祖先栈回溯」

构造两个假插件共用一个共享依赖模块，分别调用 200 次 / 60 次，对比两种归因策略：

```
direct (self-frame) attribution:      ancestor-walk attribution:
   573  (shared/other)                   441  pluginA
     1  pluginA                          131  pluginB
                                          2  (unattributed)
```

- **按栈帧自身归属**：574 个样本里 573 个落进「共享依赖」这个无法归属的桶，归因基本失效。
- **沿父节点回溯到最近的插件栈帧**：得到 441 : 131 = 3.37，真实比 200 : 60 = 3.33，误差 < 1.5%。

> **这是整个方案的核心设计点。** 归因算法必须是「栈回溯到最近插件帧」，而不是「看这个函数定义在哪个文件里」。
> 它顺带解决了「插件依赖的 node_modules 该算谁的」这个问题——**算调用方插件的**。
> 否则任何带依赖的插件（如 `dsh-chat-import` 依赖 `fzstd`）都会把自己的成本甩给依赖。

### 3.4 磁盘 I/O —— 分三层，能力递减

#### 第一层：进程级操作次数（精确、零依赖）

`process.resourceUsage().fsRead / fsWrite` 在 Windows 上给出**精确的进程级读写操作次数**。实测：

```
resourceUsage before: {"fsRead":1,"fsWrite":0}
resourceUsage after : {"fsRead":21,"fsWrite":20}
delta fsRead: 20  delta fsWrite: 20     ← 正好对应 20 次写 + 20 次读
```

`process.report.getReport().resourceUsage.fsActivity.{reads,writes}` 是同源数据，另外附带
`rss` / `maxRss` / `pageFaults` / `cpuConsumptionPercent`。

**注意：这是操作次数，不是字节数。**

#### 第二层：按插件的操作次数（精确、零补丁）

`async_hooks` 的 `init(asyncId, type)` + `AsyncLocalStorage` 标记「当前插件」。实测：

```
per-owner fs async-resource counts:
    2  pluginA :: FILEHANDLECLOSEREQ
    7  pluginA :: FSREQPROMISE
    2  pluginB :: FILEHANDLECLOSEREQ
    4  pluginB :: FSREQPROMISE
```

**无需任何 monkey-patch** 即可按插件统计异步文件操作。

局限：`readFileSync` / `writeFileSync` **不产生异步资源，不计入**——这部分改由 CPU 采样中
`node:fs` 帧的祖先回溯覆盖（次数近似，但归属正确）。

#### 第三层：字节级（需要拦截，代价高）

必须拦截调用点。这里有一个**必须避开的静默错误陷阱**——实测 ESM 内置模块的可补丁性：

```
fs.readFileSync 被替换后 → ns readFileSync patched? true
命名导入是否看到补丁？      → named-import saw patch: NO
```

`import { readFileSync } from 'node:fs'` 的绑定在模块实例化时快照，
**运行时 monkey-patch `fs` 会被 ESM 命名导入静默绕过**。

> 这意味着「补丁 fs 模块」这条路只能覆盖 CJS 调用点与默认导入的属性访问，
> 对插件主流的 ESM 命名导入**完全无效**。如果不知道这一点，
> 做出来的工具会给出**看起来正常但系统性偏低**的数据——比报错更危险。

字节级精确只有两条真路：

| 方案 | 覆盖 | 风险 |
| --- | --- | --- |
| 包装 `ctx.fs` 服务（`@deepseek-ai/dsh-fs` 的 `FileSystem` 抽象基类） | 仅走 harness 的 I/O | 低，但覆盖不全 |
| `module.register()` 加载钩子重写 `node:fs` 说明符 | 我们加载之后导入的模块 | 改变函数标识，与 `graceful-fs` 等自补丁库冲突；插件加载顺序敏感 |

**建议**：v1 不做字节级拦截；用 `ctx.fs` 包装拿到「harness 中介 I/O」的精确字节，
其余标注为未覆盖。字节级加载钩子留作 Phase 3 的 opt-in 深度模式。

### 3.5 其余可用信号

| 信号 | 机制 |
| --- | --- |
| 每插件定时器 / 监听器 / 打开句柄 | 包装 `ctx.setInterval` / `ctx.setTimeout` / `ctx.on`，或按 fiber 归属统计 |
| 事件循环延迟 | `perf_hooks.monitorEventLoopDelay()` |
| GC 停顿 | `PerformanceObserver` 的 `gc` entry |
| 每插件磁盘占用（字节，精确） | 扫描 `$DSH_HOME/**` 与工作区目录，按「路径 → 归属插件」映射 |
| 插件生命周期 | fiber phase、加载顺序、HMR 重载次数 |
| 当前 CDP 端口 | 如需外部调试可另开，但本方案不需要 |

---

## 4. 开销实测（决定默认策略）

| 场景 | CPU profiler 1000µs | 堆采样 32KB | 两者同开 |
| --- | --- | --- | --- |
| 纯计算微基准 | +7% ~ +23% | ~0%（噪声内） | **+15% ~ +26%** |
| 异步 + 文件 I/O 混合 | ~0%（可负） | ~0%（可负） | ~0% ~ +12% |

原始数据：

```
--- compute-bound ---                      第一次运行
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

第二次运行同脚本，纯计算负载上 `both` 达到 **+25.8%**，异步混合负载则全部落在噪声内。

**读数须知**：这是微基准，绝对百分比波动大（异步 + I/O 负载甚至出现负值，
因为 I/O 等待时间淹没了采样开销）。可稳定复现的只有一条趋势：
**纯计算负载上「两者同开」始终是最贵的一档**。设计决策应基于这条趋势，而非某个具体数字。

**结论**：不能常开「双采样」。设计上必须：

- 占空比轮转（如 5s 采样 / 30s 停止）；
- 按需深度采样（用户点「开始剖析」才开双采样）；
- 随时可停；
- **排除自身帧**（`dsh-perf-lens` 自己的模块路径必须从归因中剔除，否则会自我放大）。

另注：`Profiler.stop` 在未启动时会抛 `Inspector error -32000: No recording profiles found`，
状态机必须严格维护 start/stop 配对。

---

## 5. 面板与集成路径（全部有现成范式）

### 5.1 Host 侧

ESM 插件，导出 `name` / `inject` / `apply`。

`webServer` 是**可选且晚挂载**的 host 服务，必须走延迟注入，不能进 `inject` 数组（否则 headless profile 下整个插件无法激活）：

```js
ctx.inject(['webServer'], (webCtx) => {
  registerRoutes(ctx, webCtx.webServer)
})
```

路由 API：`ws.register({ kind: 'exact' | 'prefix', path, handler }): () => void`。

这与 `dsh-chat-import` 的 `/api-import/*` 完全同构，可直接照搬。

### 5.2 Client 侧

- 单文件 `lib/client.js`，经 `window.__ModuleLoader__.load({ id, factory })` 加载；
- `package.json` 声明 `dsh.client.inject` 与 `dsh.client.platform = "web"`；
- factory 内可 `require("react")`、`require("react-dom")`、`require("@deepseek-ai/dsh-client-ui-primitives")`；
- 槽位注册：`ctx.slots.inject(slotName, () => ctx.slots.register(...))`。

**已确认的面板落点（本仓库决策）**：`sidebar.right.pane.tab`（右侧栏 tab）。

可用的相关槽位：

| 槽位 | 用途 |
| --- | --- |
| `sidebar.right.pane.tab` | **本方案采用**：常驻右侧栏，随时瞄一眼 |
| `settings.section` | 设置页分区，适合放完整分析（Phase 2 可加） |
| `sidebar.footer.action` | 底部动作按钮 |

> 客户端 bundle 约束：DSH 的客户端模块加载器没有相对 `require`、也没有资源 URL，
> 插件浏览器侧产物必须是**单个自包含文件**。源码可以分片，但需要构建脚本拼回单文件
> （`dsh-chat-import` 的 `scripts/build-client.mjs` 是这个模式的参考实现）。

### 5.3 分发

`cordis.patch.yml` 插入一行：

```yaml
- insert:
    - id: perf-lens
      name: dsh-perf-lens
```

---

## 6. 能力边界（必须标注在 UI 上）

以下几点建议直接做进面板的「覆盖度 / 置信度」列。**否则工具会变成新的误导源**——
这是本方案最大的产品风险，不是技术风险。

1. **没有每插件 RSS。** 只有全局 RSS + 每插件**采样归因**的存活堆字节。两者量纲不同，不能相加对齐。
2. **每插件磁盘字节数不精确。** 操作次数可精确归因；字节数只有 `ctx.fs` 覆盖范围内的部分，
   其余必须标注为「未覆盖」。
3. **客户端（浏览器）内存无法归因。** 那是另一个进程，只能给全局渲染进程指标。
4. **子进程不在内。** `dsh-subprocess-local/runner.js`、node-pty、LSP server 都是独立 PID，
   v1 只覆盖宿主进程内的插件帧；这些进程的开销只能靠进程级采样另算。
5. **采样即统计。** 短窗口噪声大，面板必须显式展示采样窗口长度与样本数。

---

## 7. 生态调研

`dsh-plugin` topic 下**没有同类插件**：

- `dsh-plugin-bench` 是**静态质量评分**（八维度 scorecard），不测运行时开销；
- 各类 usage meter / cost meter 统计的是**模型成本**，不是插件资源占用。

这是一个空位。

---

## 8. 分阶段建议

### Phase 1（MVP，风险低）

插件清单 + 全局指标（RSS / heap / event-loop lag / GC）+ 每插件 CPU 采样 +
存活堆采样 + 文件操作计数 + 定时器/监听器/句柄清单 + 右侧栏面板表格排序。

基本上是「接线」工作，全部机制已实测。

### Phase 2

时序历史（环状缓冲 + 可选 JSONL 落盘）+ 按需堆快照与 CPU 深度剖析 +
单插件详情（热点函数、分配点、触碰的文件路径）+ 报告导出。

主要工作量在**堆快照离线解析**，以及归因质量调优（打包插件、worker 线程、异步边界）。

### Phase 3（opt-in 深度模式）

`node:fs` 加载钩子实现字节级磁盘 I/O + 子进程采样 + 渲染进程指标。

风险最高，默认关闭，UI 明确标注为实验性。

---

## 9. 与被取代的临时脚本的关系

`dsh-context/.tmp/probe/probe.mts` 那套一次性基准脚本（回放本地会话语料，逐模块测 CPU）
正是本插件要取代的东西。它的方法学值得继承：

- 逐模块 / 逐事件类型隔离测量；
- JIT 预热 + 重复运行 + 取中位数；
- 报告落 JSON 供后续比对。

差别在于：本插件是**常驻**的，测的是**真实运行时**而非离线回放，
并且能回答「哪个插件」而不是「哪个函数」。