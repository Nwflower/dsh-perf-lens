# Phase 2 方向：从「极客表格」到可用看板

> 状态：**已定稿**（作者评审）。本文档是开发 Agent 的执行依据。
> 硬约束不变：AGENTS.md 六条 + design.md §7 隐私红线（帧级数据永不落盘）。

## 问题（来自实机截图）

1. **226 行扁平表格**：官方 harness 的每个子包各自成行（`harness:@deepseek-ai/dsh-client-hmr`…），
   设计里早就写了「harness 折叠为一行」，实现漏了。用户要的是「哪个插件在吃资源」，
   不是 harness 内部模块清单。
2. **只有瞬时值**：表格只有当前窗口 cpuShare，看不到平均/峰值——而积分榜在页面很下面。
3. **重进页面序列清零**：sparkline 序列是 client 本地 state，刷新即空。
4. **无分组、无静态折叠**：绝大多数插件常年 0 开销，却和真正的消耗者平铺在一起。
5. **界面太生**：纯表格，没有视觉层级。

## 方向

### Track 1 · 归并与分组（host + shared）

- host：`lens.#build` 把所有 `harness:*` owner 归并成单行 `harness`（cpu / heap / io 三处）。
  诊断里的 ownerKeys 仍保留原始键，便于排查。
- shared：新增纯函数 `grouping.ts`
  - 分组：`external`（profile 里的插件）/ `harness` / `runtime` / `self` / `other`；
  - 静态判定：cpu / heap / io / alloc 全为 0 → 归入该组静态子集；
  - 单测锁定分组与静态判定。

### Track 2 · 卡片式看板（client）

- 新增 `plugin-cards.tsx`：Top-N 消耗卡片，每张显示 **当前 / 平均 / 峰值** + sparkline。
- `metrics-table.tsx` 增加分组渲染：组头（名称 + 数量 + 组内合计占比）+ 组内行；
  静态行折叠为「静态 N 个（无开销）」一行，点击展开。
- 表格新增「平均」「峰值」列（来自 stats，按 moduleName join）。

### Track 3 · 后台采样档（host + client）

- 新 `SampleMode = 'background'`：低采样率常驻档
  - `backgroundCpuIntervalUs: 1000`（默认档 250µs）、`backgroundWindowMs: 2000`、
    `backgroundIdleMs: 120000`；
  - 面板关闭时仍在后台按此档持续采样并落 JSONL，保证重进页面有历史。
- `Sampler.startCpu(intervalUs?)` 支持逐窗口覆盖采样间隔。
- 控制区加「后台」档按钮；全局条常驻显示当前档位。

### Track 4 · 序列回填（client）

- 面板挂载时用已加载的 `/api-perf/trend` 回填 sparkline 序列（取每插件最近 30 点），
  解决「重进页面就清零」。

### Track 5 · 收尾

- 四门禁全绿；design.md 已决事项追加分组规则、后台档、回填策略；分轨道 commit。

## 明确不做

火焰图；报告导出；子进程采样；worker 归因；卡片拖拽/自定义布局；主题皮肤。
