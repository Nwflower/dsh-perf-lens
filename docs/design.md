# 架构草案

> 状态：草案，未评审。可行性依据见 [feasibility.md](feasibility.md)，实测数据见 [evidence.md](evidence.md)。

---

## 1. 分层

```
┌─ Client (浏览器) ────────────────────────────────────────────┐
│  lib/client.js  →  sidebar.right.pane.tab                    │
│    · 指标表格（可排序 / 可筛选 / 覆盖度徽标）                  │
│    · 全局条（RSS / heap / event-loop lag / GC）               │
│    · 控制区（采样开关、窗口长度、抓堆快照、导出）              │
│    轮询 /api-perf/*                                          │
└──────────────────────────────────────────────────────────────┘
                    ▲ HTTP (webServer.register)
┌─ Host (单 Node 进程) ────────────────────────────────────────┐
│  dsh-perf-lens (cordis 插件)                                 │
│                                                              │
│  PluginIndex     ctx.loader.entries() → 模块路径 → 插件映射   │
│  Sampler         inspector 状态机：CPU / 堆采样，占空比轮转   │
│  Attributor      祖先栈回溯 → 每插件归因                      │
│  IoTracker       async_hooks 计数 + ctx.fs 包装 + 进程校准     │
│  FootprintScanner 目录字节扫描（路径 → 归属插件）              │
│  HistoryStore    环状时序 + 可选 JSONL 落盘                   │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 归因算法（核心）

### 2.1 插件索引

由 `ctx.loader.entries()` 建立：

```
moduleName (e.g. "dsh-context")
  → 解析基准 baseUrl + 包目录
  → 归属判定用路径前缀集合
```

帧分类：

| 类别 | 判定 | 展示 |
| --- | --- | --- |
| `plugin:<name>` | 路径落在某插件包目录内 | 按插件独立成行 |
| `harness-core` | 路径落在 `@deepseek-ai/dsh-*` 核心包内 | 折叠为一行「harness 内核」 |
| `dep-of:<plugin>` | 落在共享 node_modules，且回溯到某插件 | **并入该插件**（不单列） |
| `runtime` | `node:*`、native、`(root)` | 折叠为「运行时」 |
| `self` | 本插件自身路径 | **从所有归因中剔除** |

### 2.2 采样点归属

CPU profile 的 `nodes[]` 是调用树，`children[]` 给出子节点，需自建反向父指针表。
对每个采样打点：

```
walk(node):
  if owner(node.callFrame.url) is a plugin: return that plugin
  if node has no parent: return UNATTRIBUTED
  return walk(parent)
```

堆采样树同构（`selfSize` 加在回溯结果上）。

**为什么不按文件归属**：见 [evidence.md 证据 5](evidence.md#证据-5决定性归因必须做祖先栈回溯)——
朴素归属会把 573/574 的样本丢进无法归属的桶。

### 2.3 异步边界

采样是**栈驱动**的，天然跨异步边界有效：`await` 恢复后插件的帧仍在栈上。
这是选择采样而非「按 ALS 上下文归属」的原因——后者在事件驱动的插件架构里，
listener 的归属取决于**注册时刻**而非**触发时刻**，会系统性错配。

`async_hooks` 仅用于**文件操作计数**（`init` 时栈上就有调用方），不用于 CPU/内存归属。

---

## 3. 指标契约

每插件每窗口一行：

| 字段 | 单位 | 精度 | 来源 |
| --- | --- | --- | --- |
| `cpuShare` | % | 采样估计 | CPU profiler |
| `cpuSelfMs` | ms | 采样估计 | CPU profiler |
| `liveHeapBytes` | B | 采样估计 | 堆采样 `stopSampling` |
| `allocBytesPerSec` | B/s | 采样估计 | 堆采样树差值 |
| `fsReadOps` / `fsWriteOps` | 次 | **精确** | async_hooks |
| `fsReadBytes` / `fsWriteBytes` | B | **部分覆盖** | ctx.fs 包装（标注覆盖率） |
| `timers` / `listeners` / `handles` | 个 | 精确 | cordis 生命周期包装 |
| `diskFootprintBytes` | B | **精确** | 目录扫描 |
| `fiberPhase` | 枚举 | 精确 | `ctx.loader` |
| `coverage` | % | — | 上述「部分覆盖」项必须携带 |

全局一行：`rss` / `heapUsed` / `heapTotal` / `external` / `arrayBuffers` /
`eventLoopLagP99` / `gcPauseMs` / `fsOpsTotal`（进程级精确）/ `sampleWindowMs` / `sampleCount`。

### 覆盖度规则（产品硬约束）

- 任何非精确指标在 UI 上必须带**视觉标记**，不能与精确指标混排成同一可信度。
- 当覆盖率低于阈值（如 60%）时，字节数列显示为「≥ N（覆盖不足）」而非具体值。
- 面板顶部常驻一行说明当前采样窗口长度与样本数。

---

## 4. 采样状态机

```
        ┌──────────┐  start   ┌───────────┐  window elapsed  ┌──────────┐
        │  IDLE    │─────────▶│ SAMPLING  │─────────────────▶│ COLLECT  │
        └──────────┘          └───────────┘                  └────┬─────┘
             ▲                                                      │
             │                  duty-cycle sleep                    │
             └──────────────────────────────────────────────────────┘
```

- `Profiler.stop` 在未启动时抛错（见证据 8）→ 状态必须显式维护，禁止盲目 stop。
- 堆采样 profile 树会随窗口增长 → 每窗口必须 `stopSampling` 释放，不允许无限累积。
- 默认：CPU 采样 1000µs / 窗口 5s / 间隔 30s；堆采样默认关闭，随「深度模式」开启。
- 所有开关都必须能**立即生效**，且插件卸载时无条件停止采样（cordis effect disposer）。

---

## 5. 面板信息架构（右侧栏 tab）

```
┌─ Perf Lens ─────────────────────────────┐
│ RSS 680MB · heap 412MB · lag 12ms · 5s窗口│  ← 全局条
│ [▶ 采样中] [深度模式] [抓堆快照] [导出]    │  ← 控制区
├─────────────────────────────────────────┤
│ 插件            CPU   内存   磁盘  覆盖度 │
│ ▼ dsh-context   12.4% 88MB   1.2k   98%  │
│   dsh-chat-import 8.1% 41MB  340    72% ⚠│
│   harness 内核   31.2% 190MB 4.1k   100% │
│   运行时         9.0%  —     —      —    │
├─────────────────────────────────────────┤
│ ▼ dsh-context 详情                        │
│   热点函数 Top 5（self ms）               │
│   分配点 Top 5（存活字节）                 │
│   触碰文件 Top 10（读/写次数）             │
└─────────────────────────────────────────┘
```

- 默认按 `cpuShare` 降序；可切换内存 / 磁盘 / 分配速率。
- 「覆盖度」列对 < 100% 的项加警示样式，点击展开解释缺哪部分。
- 详情区复用同一份快照数据，不额外采样。

---

## 6. 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 归因错配（依赖甩锅） | 面板指错人 | 强制祖先栈回溯；写单测锁死 3.33 比值场景 |
| 采样开销被低估 | 宿主变慢，用户卸载 | 占空比默认保守；开销自测量并展示；一键全停 |
| 微基准数字被当作定值引用 | 设计决策建立在噪声上 | 只依据「两者同开最贵」这条稳定趋势；面板展示样本数与窗口长度 |
| 假精度（字节数） | 用户据此优化错方向 | 覆盖度列 + 低覆盖时显示 `≥ N` |
| 堆快照撑爆内存 | 宿主 OOM | 落盘 + 离线解析，不在主进程 parse；限流 |
| 打包/worker 边界 | 部分帧无法归属 | 归入 `UNATTRIBUTED` 并**显式展示占比**，不隐藏 |
| 与宿主 inspector 使用者冲突 | 调试端口占用 | 使用独立 `inspector.Session`，不依赖端口 |
| 自采样放大 | 自身占据榜首 | 自身路径硬剔除 |

---

## 7. 待决问题

1. 历史数据留存策略：仅内存环状（重启即失）还是落 `$DSH_HOME/perf-lens/*.jsonl`？后者能回答「哪个插件变差了」，
   但有磁盘增长与隐私（文件路径）问题。
2. 是否需要在设置页再加一个 `settings.section` 承载完整分析（右侧栏宽度有限）？
3. 子进程（`dsh-subprocess-local/runner.js`、node-pty、LSP）是否纳入 v1 的进程级采样？
4. 覆盖度阈值的具体数值，以及「未归属」占比超过多少时应当直接警告而非静默展示。
5. 是否需要「基线对比」能力：记录一次已知良好状态，之后与基线 diff。