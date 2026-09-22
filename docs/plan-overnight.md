# 过夜开发方案：趋势与积分 + 热点函数 + 前台耗时桥接

> 状态：**已敲定**（评审拍板）。本文档是开发 Agent 的执行依据，轨道间弱依赖，
> 按 0 → 1 → 2 → 3 → 4 串行执行。每轨道完成后跑四门禁（test / typecheck / build / lint）。
> 硬约束继续适用：AGENTS.md 六条 + design.md §7 隐私红线（帧级数据永不落盘）。

## Track 0 · 基线修复（先做，< 0.5h）

1. **提交基线**：当前 src/、test/、全部实现代码处于 untracked 状态，git 里只有一个
   docs commit。开工前先 commit 当前全绿状态（82 项测试），否则过夜工作没有回滚点。
2. README 头部改为"已实现"口径；状态区 57 → 82 项测试；补记本轮采样改动
   （250µs 默认 / 空闲退避 / per-node 记忆化）。
3. design.md §1.2 client 目录表去重（api.ts 等列了两遍）。

## Track 1 · 积分与趋势（核心，~3-4h）

回应需求：后台持续捕获积分占用比、随时间百分比趋势图（隐藏 0% 插件）、峰值 vs 平均。

### host

- 每插件会话级累计量 `cumulativeCpuMs`（采样窗口内累计核时）+ 采样覆盖率
  （采样时长 / 墙钟时长，占空比下必须展示，外推值打"估算"标）。
- 新增 `GET /api-perf/stats?range=1h|24h|7d`：从环状缓冲 + JSONL 聚合每插件
  `{ avgCpuShare, peakCpuShare, p95CpuShare, cumulativeCpuMs, coverage }`。
- contract.ts 加对应类型；**峰值/平均沿用活动样本口径**的 cpuShare，与现有分母一致。
- 聚合逻辑必须是零 ctx 依赖纯函数（同 attribute.ts 分层），单测锁定：
  已知输入序列的 avg/peak/p95 值；隐藏规则（见下）的边界。

### client

- 趋势图组件：SVG 手绘（延续 sparkline 做法，不引图表库），time 轴百分比折线，
  数据源 `/api-perf/history`。**隐藏规则：时间范围内 max(cpuShare) < 0.5% 的插件不进图**
  （阈值可配，默认即覆盖"隐藏 0%"）。
- 积分排行榜区块：按 cumulativeCpuMs 降序，每行带 avg / p95 / peak 徽标。
- 轮询节奏沿用现有 pollMs 逻辑。

## Track 2 · 热点函数 Top-N（~2h）

- host：**仅深度模式开启时**按插件聚合 `functionName + url:line` 的 self time Top-N；
  新增 `GET /api-perf/plugin/:name/hotspots`。
- **硬约束：只驻留内存、只随深度模式、永不进 JSONL**（帧级数据，design.md §7 红线）。
  加一条隐私回归测试：持久化路径的输出断言不含任何 functionName。
- sourcemap：仅当目标包存在 `*.map` 时 best-effort 还原，失败回退原始
  `functionName (file:line)`。实测 dsh-context 只发 client.js.map，host 侧基本无 map，
  **覆盖率不写入验收标准**，UI 也不承诺。
- client：插件行展开热点函数 Top-N（self time 降序）。

## Track 3 · 前台耗时桥接（~2h）

回应需求：前台耗时（拖垮动画）与后台占用的量化对比。

- client：`PerformanceObserver('longtask')` + rAF 帧间隔采样（仅面板页面，开销可忽略），
  窗口内聚合 `{ longTaskCount, longTaskTotalMs, rafGapP95Ms }`。
- 新增 `POST /api-perf/vitals`：上报上述聚合 + 时间戳；host 存环状缓冲。
- snapshot 增加 `vitals` 段：当前窗口前台卡顿指标 + 卡顿时刻 host cpuShare Top-3 插件。
- **UI 必须带"相关性≠因果"标签**：浏览器无法把 longtask 归因到具体插件 bundle，
  只呈现时间相关性。这条写进 coverage-badge 的既有警示体系。
- 单测：vitals 聚合与相关性计算的纯函数。

## Track 4 · 收尾门禁（~0.5h）

- 四门禁全绿（pnpm test / typecheck / build / lint）。
- README 状态区更新；design.md「已决事项」表追加三条：
  积分口径（采样内累计 + 覆盖率标注）、vitals 相关性标注规则、热点函数不落盘。
- git 按轨道分 commit，commit message 用英文。

## 明确不做（防止跑偏，留到下一轮）

100µs 深度采样常开；子进程采样；worker 线程归因；把归因搬进 worker 线程；
async 根聚合；报告导出（JSON/Markdown）；卡片式看板重构（需求②，等 Track 1
数据落地后再做 UI 重构）；活动触发采样（CPU 门控）。
