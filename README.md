# dsh-perf-lens

DeepSeek Harness 插件资源开销分析面板（**Phase 1 MVP 已实现**）。

目的是把「排查性能问题时每次临时写脚本」变成常驻能力：回答**哪个插件在吃 CPU、吃内存、读写磁盘**，
并把结论展示在 Web GUI 面板上。

host 采样链路（归因 / 采样器 / IoTracker / 全局指标 / JSONL / 路由）与 client 看板均已落地，
文档与探针保留在 `docs/` 与 `probes/`。

## 结论摘要

**可行。** 宿主是单进程，因此不存在 OS 级的「每插件内存」；可行路径是**进程内采样归因**：
用 `node:inspector` 采样 CPU 与堆，把样本沿调用栈回溯到最近的插件栈帧；用 `async_hooks`
零补丁统计每个插件的文件操作次数。核心机制均已实测跑通。

唯一实质性妥协：**每插件磁盘字节数无法精确获取**，只能精确到操作次数 + 部分覆盖的字节数，
必须在 UI 上标注覆盖度。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/feasibility.md](docs/feasibility.md) | 完整可行性分析：运行时事实、逐机制验证、开销实测、能力边界、集成路径、分阶段建议 |
| [docs/evidence.md](docs/evidence.md) | 实测原始输出与复现命令，逐条对应可行性结论 |
| [docs/design.md](docs/design.md) | 已定稿架构设计：技术栈、任务管理器看板、归因算法、指标契约、采样状态机、JSONL 持久化 |
| [probes/README.md](probes/README.md) | 探针脚本清单与运行方式 |

## 已确认的关键事实

- 宿主是**纯 Node 进程**（`dsh web --port 3081`，Node v24.18.0），`node:inspector` / `v8` / `async_hooks` 全部可用，无需 `--inspect` 端口。
- 插件可枚举：`ctx.loader.entries()`（harness 自身的 `dsh-plugin-inventory` 即如此）。
- **ESM 命名导入的内置模块无法被运行时 monkey-patch**——这是必须避开的静默错误陷阱。
- 归因必须做**祖先栈回溯**：按栈帧自身归属，实测 574 个样本里 573 个落到「共享依赖」无法归属的桶。
- 双采样常开开销在纯计算负载上 **+15% ~ +26%**（两次运行），必须占空比轮转。

## 开发

```bash
pnpm install      # 只装工具链；harness peer 依赖不自动安装（见 .npmrc / pnpm-workspace.yaml）
pnpm test         # vitest 单测
pnpm typecheck    # tsc --noEmit
pnpm build        # tsdown：lib/index.js（host）+ lib/client.js（client 单文件 bundle）
pnpm lint         # oxlint
```

> harness 客户端类型包没有作为 devDependency 安装：registry 的 `latest` tag 指向
> 已损坏的 0.0.1-rc.1 线（依赖下线的 `@deepseek-ai/dsh-compact`）。client 侧按
> dsh-context 的做法在 `src/client/ctx.ts` 声明结构化接口，不依赖 harness 的
> Context 增强。接入真实类型时把它换回 `@deepseek-ai/dsh-client-ui-*`。

### 本地联调（link 到 DSH profile）

profile 用 `link:` 依赖 + `dsh.profile.bundles` 列表挂本地插件，与
`dsh-chat-import` 的做法一致：

```jsonc
// ~/.dsh/profiles/web/package.json
"dsh": { "profile": { "bundles": [ /* … */, "dsh-perf-lens" ] } },
"dependencies": { "dsh-perf-lens": "link:D:/Build/dsh-perf-lens" }
```

```bash
cd ~/.dsh/profiles/web && pnpm install
# host 插件在服务启动时加载：重启 dsh web 服务后生效
```

若 profile 的 pnpm 供应链策略（`minimumReleaseAge`）拦住既有包，用一次性覆盖
`pnpm install --config.minimumReleaseAge=0`，不要为此改持久配置。

### 排查

面板为空或数值异常时，先看 `/api-perf/diagnostics`：

```powershell
Invoke-RestMethod http://127.0.0.1:3081/api-perf/diagnostics | ConvertTo-Json -Depth 4
```

- `sampleCount` 为 0 → 采样窗口没采到样本；`lastError` 会给出被 duty loop 吞掉的异常。
- `ownerRules` 里应是真实包目录（如 `…/node_modules/dsh-context/lib`）；若为空或指向 profile
  目录，说明包名解析失败，样本会落进 `unattributed`。

已知踩坑（均已修复并有回归测试）：CDP 的 `Profiler.stop` 结果包在 `profile` 下；
loader 的 `ctx.baseUrl` 是**目录 file URL**（不是插件路径）；连续模式下窗口同步抛错
若不 await 会形成微任务死循环饿死事件循环。

## 状态

- [x] 可行性调研
- [x] 机制实测验证
- [x] 设计评审
- [x] Phase 1 MVP 实现
  - [x] 脚手架：package.json / tsconfig / tsdown 双产物 / cordis.patch.yml
  - [x] 归因核心（祖先栈回溯）+ 单测锁定 3.33 比值
  - [x] 指标契约（src/shared/contract.ts）与默认值
  - [x] 采样器状态机（Profiler 严格配对 + 占空比/连续模式）
  - [x] IoTracker（async_hooks 零补丁计数 + 读/写分类）
  - [x] 全局指标（RSS / heap / event-loop lag / GC / 进程级 fs 次数）
  - [x] JSONL 历史落盘（按天轮转 + 保留期 + 总量上限 + 隐私默认只落计数）
  - [x] /api-perf/snapshot | control | history 路由（webServer 延迟注入）
  - [x] 任务管理器面板：sidebar.panellist 条目 + main 看板（表格 / sparkline / 全局条 / 控制区）
  - [x] 107 项单测（host 100 + client 7）+ 类型检查 + 构建 + lint 全绿
  - [x] CPU 采样间隔默认 250µs（实测与 1000µs 同价、4 倍分辨率）+ 空闲退避 + per-node 归因记忆化
- [x] 趋势与积分（/api-perf/stats?range=1h|24h|7d）
  - [x] 范围聚合纯函数：avg / peak / p95 / 累计核时 / 采样覆盖率（估算值带标注）
  - [x] SVG 百分比趋势图，隐藏峰值 < 0.5% 的插件；积分榜按累计核时排序
- [x] 热点函数 Top-N（/api-perf/hotspots?plugin=）
  - [x] 仅深度模式采集；**只驻留内存、永不落盘**（design.md §7 隐私红线）
  - [x] 面板按插件行展开；sourcemap 未做（host 侧实测基本无 map，见评审结论）
- [x] 前台卡顿桥接（/api-perf/vitals）
  - [x] client 测 Long Tasks + rAF 帧间隔，POST 聚合回 host；host 内存环状缓冲
  - [x] 面板并列展示卡顿指标与 host CPU Top-3 插件，标注「相关性≠因果」
- [x] Phase 2 产品化（见 [docs/plan-phase2.md](docs/plan-phase2.md)）
  - [x] harness owner 归并为单行 + 五组分组（shared/grouping.ts）+ 静态行折叠
  - [x] 卡片式看板：Top-N 消耗卡片（当前 / 平均 / 峰值 + sparkline）
  - [x] 明细表分组渲染 + 平均/峰值列
  - [x] 后台采样档 SampleMode='background'（1000µs / 2s / 120s）
  - [x] sparkline 序列用 /api-perf/trend 回填，刷新不再清零
  - [x] 127 项单测 + 四门禁全绿
- [ ] Phase 1 收尾：目录字节扫描 / 自身开销自测量 / 定时器与句柄计数 / ctx.fs 字节包装