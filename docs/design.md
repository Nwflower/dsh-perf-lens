# 架构设计

> 状态：**已定稿**（2026-09 评审通过，技术栈、历史留存、看板形态、面板落点四项关键决策已拍板）。
> 可行性依据见 [feasibility.md](feasibility.md)，实测数据见 [evidence.md](evidence.md)。
> 本文档与 feasibility.md 的分工：feasibility 回答「能不能做」，本文档回答「怎么做」。

---

## 1. 技术栈决策

两个参考仓库各代表一条已验证的路线，对比后选定：

| 维度 | 纯 JS ESM（dsh-chat-import 路线） | **TypeScript + tsdown（dsh-context 路线）✔ 选定** |
| --- | --- | --- |
| Host 源码 | lib/*.mjs 手写直发，零构建 | src/host/*.ts → tsdown 产出 lib/index.js |
| Client 产物 | 自研片段拼装脚本（契约靠约定） | tsdown 单入口产出自包含 lib/client.js |
| 类型保护 | 无 | **有**——采样状态机、profile 树回溯、指标契约是复杂逻辑 |
| 单测 | node --test | **vitest**（fake timers、覆盖率，dsh-context 已验证） |
| Lint | eslint | **oxlint** |

选定理由：本插件的核心是**采样状态机 + 调用树回溯 + 双端共享的指标契约**，
恰恰是全仓库类型密度最高的部分；client 侧表格/徽标/看板组件用 TSX 写远比
字符串拼装可维护。tsdown 一份配置同时覆盖 host 与 client 两个产物，
取代脆弱的片段拼装契约。

### 1.1 依赖清单

**运行时依赖：零。** 只依赖 Node 内置（node:inspector / node:async_hooks /
node:v8 / node:perf_hooks）与 cordis 注入的服务。不引入任何 npm 运行时包——
本插件测的就是别人的开销，自己必须先做到零负担。

**peerDependencies**：@deepseek-ai/cordis、@deepseek-ai/dsh、
@deepseek-ai/dsh-client-locale、@deepseek-ai/dsh-client-ui-primitives、
@deepseek-ai/schemastery（插件配置 Schema）、react（≥18）。

**devDependencies**：typescript（跟随 dsh-context 的版本线）、tsdown、
vitest、@vitest/coverage-v8、oxlint、react / react-dom /
@types/react / @types/react-dom、@types/node。

**client 构建 externals**（镜像 dsh-context 的平台模块表，走注入的 require，不内联）：
react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、
@deepseek-ai/dsh-client-store、@deepseek-ai/dsh-client-ui-slots、
@deepseek-ai/dsh-client-ui-primitives。

**不引入 tailwind**：看板 = 表格 + sparkline + 全局条，用
dsh-client-ui-primitives 的设计令牌内联样式即可（dsh-chat-import 的做法），
不为一个面板引入整条 CSS 工具链。sparkline 用 SVG 手绘，不引图表库。

### 1.2 目录结构

```
src/
  host/                  // host process side (Node)
    index.ts             // [done] composition root: name / inject / apply
    ctx.ts               // [done] structural HostCtx faces (loader / webServer)
    plugin-index.ts      // [done] ctx.loader.entries() -> path prefix -> owner map
    attribute.ts         // [done] ancestor-walk attribution (pure, zero ctx deps)
    sampler.ts           // [done] inspector state machine, paired start/stop
    io-tracker.ts        // [done] async_hooks counters + read/write split
    metrics.ts           // [done] global metrics (heap / lag / GC / resourceUsage)
    history.ts           // [done] ring buffer + JSONL persistence (rotation / retention)
    lens.ts              // [done] duty-cycle / continuous orchestration + snapshots
    routes.ts            // [done] /api-perf/* routes (webServer late injection)
    footprint.ts         // [todo] directory byte scan (path -> owner)
    self-monitor.ts      // [todo] own-overhead self measurement and reporting
  client/                // browser side
    index.tsx            // entry: sidebar.panellist + main registration
    ctx.ts               // structural ClientCtx faces (slots / locale / layout)
    sidebar-entry.tsx    // sidebar.panellist icon row (dsh >= 0.1.7 panel pattern)
    panel.tsx            // main-panel task-manager board
    api.ts               // /api-perf/* polling (interval follows sample window)
    global-bar.tsx       // global strip (RSS / heap / lag / window info)
    control-bar.tsx      // sampling controls / deep mode / export
    metrics-table.tsx    // sortable per-plugin table
    sparkline.tsx        // inline SVG sparkline (no chart lib)
    coverage-badge.tsx   // coverage badges and warnings
    plugin-detail.tsx    // per-plugin detail (Phase 2 body)
    api.ts               // [done] /api-perf client
    format.ts            // [done] byte / percent / duration formatting
    metrics-table.tsx    // [done] sortable per-plugin table
    global-bar.tsx       // [done] global strip + coverage warnings
    control-bar.tsx      // [done] pause / continuous / deep controls
    coverage-badge.tsx   // [done] partial-metric marker
    sparkline.tsx        // [done] inline SVG sparkline (no chart lib)
    i18n.ts              // [done] zh dictionary
  shared/
    contract.ts          // metric contract types (single source of truth)
    defaults.ts          // window lengths / duty cycle / thresholds
test/
  attribute.test.ts      // locks the 3.33 ratio fixture + synthetic tree walk
  sampler.test.ts        // start/stop pairing / unload stop / continuous toggle
  io-tracker.test.ts     // async counts per owner / sync exclusion / calibration
  history.test.ts        // ring semantics / JSONL rotation / retention sweep
  coverage.test.ts       // low coverage renders ">= N"
scripts/                 // build & local wiring (register / web smoke)
```

`attribute.ts` 与 `shared/` 保持**零 ctx 依赖纯函数**，是单测的核心靶区；
其余 host 模块都是消费 ctx 的薄壳（同 dsh-chat-import 的
「lib/convert/* 纯函数 / 其余薄壳」分层）。

---

## 2. 分层架构

```
+-- Client (browser) --------------------------------------------------+
|  lib/client.js                                                       |
|    sidebar-entry -> sidebar.panellist (left nav row, like Plugins)   |
|    panel         -> main (keyed panel, task-manager board)           |
|    polls /api-perf/* (interval follows the active sample window)     |
+----------------------------------------------------------------------+
                    ^ HTTP (webServer.register, late injection)
+-- Host (single Node process) ---------------------------------------+
|  dsh-perf-lens (cordis plugin, inject = [loader])                    |
|                                                                      |
|  PluginIndex       ctx.loader.entries() -> module path -> plugin     |
|  Sampler           inspector state machine: CPU / heap, duty cycle   |
|  Attributor        ancestor stack walk -> per-plugin attribution     |
|  IoTracker         async_hooks counts + ctx.fs wrap + calibration    |
|  FootprintScanner  directory byte scan (path -> owner)               |
|  Metrics           global metrics collection                         |
|  HistoryStore      ring buffer + JSONL persistence (default on)      |
|  SelfMonitor       own-overhead self measurement                     |
+----------------------------------------------------------------------+
```

Host 入口约定（与 dsh-chat-import 同构，已核实）：

- `inject = ['loader']`；**webServer 不进 inject**——它是可选且晚挂载的 host 服务，
  硬依赖会让插件在 headless profile 下无法激活。路由在 apply 内经
  ctx.inject(['webServer'], ...) 可选注册。
- 路由 API：ws.register({ kind: 'exact' | 'prefix', path, handler })，返回 disposer，
  交给 cordis effect 管理。
- 插件卸载时**无条件停止采样**（cordis effect disposer），不留后台采样。

Client 入口约定（对齐 dsh 0.1.7 新引入的插件面板 @deepseek-ai/dsh-client-ui-plugin-manager，
已核实其 lib/client.js 的注册代码与 sidebar/layout 槽位契约）：

- **落点 = 左栏条目 + 主区面板**（与内置「插件」面板同构，需 dsh ≥ 0.1.7-alpha.1）：
  1. ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
       { name: 'sidebar.panellist', id: PANEL_ID, order: 10,
         label: () => t('panel'), locale: NS }, SidebarEntry))
     —— sidebar.panellist 是 kind: 'list' 的全局面板图标列表，其 id 与 main 面板的 key 对应，
        由 sidebar 拥有按钮并解析 label；SidebarEntry 收到 { size, active }。
  2. ctx.slots.inject('main', () => ctx.slots.register(
       { name: 'main', key: PANEL_ID, locale: NS, inject, children }, PerfPanel))
     —— main 是 kind: 'keyed' 的主区面板，key 与 sidebar 条目的 id 对应；
        预留 conversation 之外的 key 不绑定 Session。
- 导航：ctx.layout.selectPanel(PANEL_ID)（ctx.layout 是 ILayout 服务，暴露
  activePanelId / selectPanel）。
- client 模块导出 inject = ['slots', 'locale', 'layout']；package.json 的
  dsh.client.inject 声明 ['@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar']，
  dsh.client.platform = 'web'。
- 右侧栏迷你视图（sidebar.right.pane.tab）降为 Phase 2 可选形态，不阻塞 v1。

---

## 3. 任务管理器看板（v1 核心形态）

**能做到，且机制全部现成。** 看板不是新数据源，而是 §2 各采集器的连续渲染：

### 3.1 落点形态

| 形态 | 落点 | 内容 |
| --- | --- | --- |
| **左栏条目** | sidebar.panellist | 图标 + 标签「性能」，与内置「插件」面板并列（dsh ≥ 0.1.7） |
| **主区看板** | main（keyed，key 同条目 id） | 实时表格 + 每插件 sparkline + 全局条 + 控制区 + 未归属警告 + 历史曲线 |
| 迷你视图（Phase 2 可选） | sidebar.right.pane.tab | 常驻右侧栏的可排序精简表格 |

### 3.2 实时性的诚实边界

采样本身是窗口制的，「实时」粒度天然 = 采样窗口粒度。不需要 WebSocket：
轮询 /api-perf/snapshot 即可，间隔跟随当前窗口。

### 3.3 连续采样模式（看板打开时）

默认占空比（5s 采样 / 30s 睡眠）下看板会有「停滞感」。设计：

- **看板可见时**，client 通过 POST /api-perf/control { mode: 'continuous' }
  让 host 把 idleMs 降为 0、窗口缩短（默认 2s，可配），实现秒级刷新的
  任务管理器体验；
- **看板关闭 / 页签切走时**发 { mode: 'duty' } 退回占空比；
- 连续模式有**开销上限保险**：连续运行超过 continuousMaxMs（默认 10 分钟）
  自动退回占空比并在 UI 提示；
- UI 常驻显示当前模式与采样自身开销（SelfMonitor），开销只在用户
  盯着看板时发生——这正是 feasibility「按需深度采样」结论的产品化。

### 3.4 sparkline 与历史曲线

- sparkline：内存环状缓冲（最近 1 小时全分辨率），每插件 CPU / 存活堆两条迷你线；
- 历史曲线：读 JSONL 落盘数据（见 §7），可选时间范围；
- 均为 SVG 手绘，零依赖。

---

## 4. 归因算法（核心）

### 4.1 插件索引

由 ctx.loader.entries() 建立：moduleName → 解析基准 baseUrl + 包目录 → 路径前缀集合。

帧分类：

| 类别 | 判定 | 展示 |
| --- | --- | --- |
| plugin:<name> | 路径落在某插件包目录内 | 按插件独立成行 |
| harness-core | 路径落在 @deepseek-ai/dsh-* 核心包内 | 折叠为一行「harness 内核」 |
| dep-of:<plugin> | 落在共享 node_modules，且回溯到某插件 | **并入该插件**（不单列） |
| runtime | node:*、native、(root) | 折叠为「运行时」 |
| self | 本插件自身路径 | **从所有归因中剔除**（开销由 SelfMonitor 单列） |

### 4.2 采样点归属

CPU profile 的 nodes[] 是调用树，children[] 给出子节点，需自建反向父指针表。
对每个采样打点：

```
walk(node):
  if owner(node.callFrame.url) is a plugin: return that plugin
  if node has no parent: return UNATTRIBUTED
  return walk(parent)
```

堆采样树同构（selfSize 加在回溯结果上）。

**为什么不按文件归属**：见 [evidence.md 证据 5](evidence.md#证据-5决定性归因必须做祖先栈回溯)——
朴素归属会把 573/574 的样本丢进无法归属的桶。这条规则由
test/attribute.test.ts 的 fixture（pluginA 200 次 / pluginB 60 次经共享依赖，
断言归因比 ≈ 3.33）**永久锁死**，任何重构不得退化为按帧归属。

### 4.3 异步边界

采样是**栈驱动**的，天然跨异步边界有效：await 恢复后插件的帧仍在栈上。
这是选择采样而非「按 ALS 上下文归属」的原因——后者在事件驱动的插件架构里，
listener 的归属取决于**注册时刻**而非**触发时刻**，会系统性错配。

async_hooks 仅用于**文件操作计数**（init 时栈上就有调用方），不用于 CPU/内存归属。

---

## 5. 指标契约

类型定义唯一事实源：src/shared/contract.ts。每插件每窗口一行：

| 字段 | 单位 | 精度 | 来源 |
| --- | --- | --- | --- |
| cpuShare | % | 采样估计 | CPU profiler |
| cpuSelfMs | ms | 采样估计 | CPU profiler |
| liveHeapBytes | B | 采样估计 | 堆采样 stopSampling |
| allocBytesPerSec | B/s | 采样估计 | 堆采样树差值 |
| fsReadOps / fsWriteOps | 次 | **精确** | async_hooks |
| fsReadBytes / fsWriteBytes | B | **部分覆盖** | ctx.fs 包装（标注覆盖率） |
| timers / listeners / handles | 个 | 精确 | cordis 生命周期包装 |
| diskFootprintBytes | B | **精确** | 目录扫描 |
| fiberPhase | 枚举 | 精确 | ctx.loader |
| coverage | % | — | 「部分覆盖」项必须携带 |

全局一行：rss / heapUsed / heapTotal / external / arrayBuffers /
eventLoopLagP99 / gcPauseMs / fsOpsTotal（进程级精确）/ sampleWindowMs / sampleCount / idleSamples。

**idle 必须与 runtime 分开。** CPU profiler 会采样空闲时间，其节点 url 为空、
functionName 为 `(idle)`（实测：空闲 3s 的 1716 个样本里 1715 个如此）。把空 url
当 runtime 会让空闲主机看起来像 90% runtime 开销。因此：
- `idle` 是独立 owner，不单列成插件行；
- 每插件 `cpuShare` 以**活动样本**为分母（`sampleCount - idleSamples`），
  否则空闲时间会把所有插件占比稀释到接近 0；
- 面板全局条展示「活动样本 N/M」与「空闲 %」。

### 覆盖度规则（产品硬约束）

- 任何非精确指标在 UI 上必须带**视觉标记**，不能与精确指标混排成同一可信度。
- 覆盖率低于阈值（默认 **60%**，可配）时，字节数列显示「≥ N（覆盖不足）」而非具体值。
- 未归属（UNATTRIBUTED）占比超过阈值（默认 **15%**，可配）时看板顶部直接警告，不静默展示。
- 面板顶部常驻一行说明当前采样模式、窗口长度与样本数。

---

## 6. 采样状态机

```
        +----------+  start   +-----------+  window elapsed  +----------+
        |  IDLE    |--------->| SAMPLING  |----------------->| COLLECT  |
        +----------+          +-----------+                  +-----+----+
             ^                                                      |
             |                  duty-cycle sleep                    |
             +------------------------------------------------------+

  CONTINUOUS = IDLE 与 SAMPLING 之间无睡眠（idleMs = 0），由看板可见性驱动。
```

- Profiler.stop 在未启动时抛 ERR_INSPECTOR_COMMAND（证据 8）→ 状态显式维护，禁止盲目 stop。
- 堆采样 profile 树随窗口增长 → 每窗口必须 stopSampling 释放，不允许无限累积。
- 默认：CPU 采样间隔 **250µs** / 窗口 5s / 睡眠 30s；堆采样默认关闭，随「深度模式」开启。
  250µs 是实测选定的：空闲 3s 窗口下 250µs 与 1000µs 的 CPU 开销相同（15 vs 16ms），
  但时间分辨率高 4 倍；100µs 则跳到 126ms（8 倍），悬崖在 250µs 与 100µs 之间。
- **空闲退避**：窗口空闲占比 ≥ 80% 时，把占空比睡眠拉长到 4 倍（上限 120s）。
  空闲主机上几乎每个样本都是 idle，继续按原节奏采样只是白烧 CPU 与磁盘。
  （依据：证据 8 唯一稳定趋势是「双采样同开最贵」，故默认只开 CPU。）
- 连续模式：idleMs = 0、窗口默认 2s，上限 continuousMaxMs（默认 10 分钟）后自动退回。
- 所有开关**立即生效**；插件卸载时无条件停止采样（cordis effect disposer）。
- 状态机用 vitest fake timers + mock inspector session 全覆盖测试，
  包括「stop 未启动的 session」「apply 中途失败」「重复 start」「连续模式超时退回」四条异常路径。

---

## 7. 数据持久化（已定：默认落盘）

**决策**：v1 默认落盘 JSONL（评审拍板），回答「哪个插件上周开始变差了」。

- 路径：$DSH_HOME/perf-lens/metrics-YYYYMMDD.jsonl，按天轮转。
- 内容：**每窗口一行聚合快照**（global + 每插件指标行），
  **原始 profile 树与调用帧永不落盘**（体积与隐私双重原因）。
- 保留：默认 **14 天**，总量上限默认 **200 MB**，超出按天清理最旧文件。
- 隐私：触碰文件的**具体路径默认不落盘**，只落读/写次数；
  persistFilePaths: true 时才写路径（配置项，默认关）。
- 写入纪律：单写者追加；perf-lens 自己的写盘会被 IoTracker 计到——
  靠 self 帧剔除保证它不出现在归因里，SelfMonitor 单独展示自身开销。
- 内存侧另保留短窗口环状缓冲（约最近 1 小时全分辨率），供 sparkline 与秒级刷新；
  历史曲线走 JSONL 读取。

---

## 8. HTTP API 契约

| 路由 | 方法 | 内容 | 阶段 |
| --- | --- | --- | --- |
| /api-perf/snapshot | GET | 当前窗口快照（global + plugins + unattributed 占比） | v1 |
| /api-perf/control | POST | pause / resume / mode: continuous \| duty / deep / shallow，立即生效 | v1 |
| /api-perf/history?plugin=&since= | GET | 时序查询（环状缓冲 + JSONL） | v1 |
| /api-perf/export | GET | 报告导出（JSON / Markdown） | Phase 2 |
| /api-perf/heap-snapshot | POST | 抓堆快照落盘，返回文件地址 | Phase 2 |

响应类型全部来自 src/shared/contract.ts，host 与 client 共享同一份定义。

---

## 9. 插件配置（schemastery Schema）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| cpuIntervalUs | 250 | CPU 采样间隔（实测 250µs 与 1000µs 同价、4 倍分辨率） |
| windowMs | 5000 | 占空比单窗口长度 |
| idleMs | 30000 | 占空比睡眠 |
| continuousWindowMs | 2000 | 连续模式窗口长度 |
| continuousMaxMs | 600000 | 连续模式自动退回上限 |
| heapSampling | off | off \| deep，深度模式开双采样 |
| history.persist | true | JSONL 落盘开关 |
| history.retentionDays | 14 | 保留天数 |
| history.maxBytes | 200MB | 总量上限 |
| history.persistFilePaths | false | 是否落具体文件路径 |
| idleBackoffThreshold | 0.8 | 空闲占比达到此值触发退避 |
| idleBackoffFactor | 4 | 空闲退避的睡眠倍数 |
| idleBackoffMaxMs | 120000 | 空闲退避的睡眠上限 |
| coverageWarnThreshold | 0.6 | 覆盖度警示阈值 |
| unattributedWarnThreshold | 0.15 | 未归属占比警告阈值 |

---

## 10. 看板信息架构

### 10.1 主区看板（main 面板）

```
+-- Perf Lens -------------------------------------[duty] 2s窗口 样本412-+
| RSS 680MB | heap 412MB | lag p99 12ms | GC 3ms | 自身开销 0.4%        |
| [暂停] [深度模式] [导出]   未归属 6%（正常）                            |
+------------------------------------------------------------------------+
| 插件             CPU%   sparkline   存活堆    磁盘R/W    分配速率  覆盖度 |
| v dsh-context    12.4   _/\~\_      88MB     980/210    2.1MB/s    98%  |
|   dsh-chat-import 8.1   __/~\_      41MB     300/40     0.8MB/s    72% ! |
|   harness 内核    31.2   /~~\~_     190MB    4.1k/1.2k  5.4MB/s    100% |
|   运行时           9.0   _~__~_     --       --         --         --   |
+------------------------------------------------------------------------+
| [历史曲线：dsh-context 最近 24h  CPU% 与存活堆，双轴 SVG]                |
+------------------------------------------------------------------------+
```

### 10.2 迷你视图（Phase 2 可选）

右侧栏 sidebar.right.pane.tab 的常驻精简表格（无 sparkline、无控制区），
点击经 ctx.layout.selectPanel(PANEL_ID) 跳到主区看板。v1 不做。

### 交互规则

- 默认按 cpuShare 降序；可切换内存 / 磁盘 / 分配速率排序。
- 覆盖度列对 < 100% 的项加警示样式，点击展开解释缺哪部分。
- 连续模式开启时全局条显示连续模式徽标与剩余自动退回时间。
- settings.section 完整分析页：Phase 2。

---

## 11. 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 归因错配（依赖甩锅） | 看板指错人 | 强制祖先栈回溯；单测锁死 3.33 比值场景 |
| 采样开销被低估 | 宿主变慢，用户卸载 | 占空比默认保守；SelfMonitor 自测量并展示；连续模式 10 分钟保险；一键全停 |
| 连续模式被遗忘开着 | 长期 +15%~26% 开销 | continuousMaxMs 自动退回 + 全局条常驻模式徽标 |
| 微基准数字被当作定值引用 | 设计决策建立在噪声上 | 只依据「两者同开最贵」这条稳定趋势；看板展示样本数与窗口长度 |
| 假精度（字节数） | 用户据此优化错方向 | 覆盖度列 + 低覆盖时显示 ≥ N |
| 堆快照撑爆内存 | 宿主 OOM | 落盘 + 离线解析，不在主进程 parse；限流（Phase 2） |
| 打包/worker 边界 | 部分帧无法归属 | 归入 UNATTRIBUTED 并**显式展示占比**，超阈值警告 |
| 与宿主 inspector 使用者冲突 | 调试端口占用 | 使用独立 inspector.Session，不依赖端口 |
| 自采样放大 | 自身占据榜首 | self 路径硬剔除 + SelfMonitor 单列 |
| JSONL 磁盘增长 | 占满 $DSH_HOME | 按天轮转 + 保留期 + 总量上限 + 单测覆盖清理逻辑 |
| 落盘文件路径隐私 | 泄漏用户目录结构 | 默认只落计数；persistFilePaths 显式开启才写路径 |

---

## 12. 阶段范围

### v1（本文档范围内）

插件清单 + 全局指标 + 每插件 CPU 采样 + 存活堆采样（深度模式）+
文件操作计数 + 定时器/监听器/句柄清单 + 目录字节扫描 +
**任务管理器看板（sidebar.panellist 条目 + main 主区面板 + 连续采样模式 + sparkline）** +
/api-perf/snapshot|control|history + **JSONL 落盘与历史曲线**。

### Phase 2

按需堆快照与离线解析 + 单插件详情（热点函数 / 分配点 / 触碰文件）+
报告导出 + settings.section 完整分析页 + 基线对比（已知良好状态 diff）。

### Phase 3（opt-in 实验性）

node:fs 加载钩子字节级磁盘 I/O + 子进程采样（dsh-subprocess-local / node-pty / LSP）+
渲染进程指标。默认关闭，UI 标注实验性。**v1 明确不做子进程**。

---

## 13. 已决事项（原待决问题）

| # | 原问题 | 结论 |
| --- | --- | --- |
| 1 | 历史留存策略 | **默认落盘 JSONL**（见 §7），隐私默认只落计数 |
| 2 | 是否加 settings.section | Phase 2 再加；v1 看板走 sidebar.panellist + main（插件面板同构） |
| 3 | 子进程是否纳入 v1 | **不纳入**，v1 只覆盖宿主进程内插件帧 |
| 4 | 覆盖度 / 未归属阈值 | 默认 60% / 15%，均可配 |
| 5 | 基线对比 | Phase 2 |
| 6 | 实时看板形态 | **v1**：sidebar.panellist 条目 + main 主区看板 + 连续采样模式（见 §3） |
| 7 | 面板注入位置 | **dsh 0.1.7 插件面板同构**：sidebar.panellist + main + ctx.layout.selectPanel（需 dsh ≥ 0.1.7-alpha.1） |

