// Panel strings, bilingual.
//
// The harness locale service ships 'zh' and 'en' (FALLBACK_LOCALE is 'en'), and
// every registered namespace must carry both dictionaries. The active locale is
// read at call time, so the panel follows a language switch without a reload:
// apply() binds the service and pushes changes into setActiveLocale(), which
// notifies subscribers (the panel re-renders on that notification).
//
// Copy rules (a review of the first draft found the panel written in profiler
// vocabulary rather than user language):
//   1. No unexplained jargon in a label. Acronyms a developer reads daily (CPU,
//      GC, p95) stay, but each carries a *Hint key explaining it in one line.
//      Obscure loan-terms are replaced: 占空比 -> 间歇采样, 存活堆 -> 存活对象 / 内存占用.
//   2. "self" is the panel's own cost, not the measured plugin's: it reads
//      本插件开销 rather than 自身开销, which begs "whose self?".
//   3. "harness" is a product name, not a kernel: harness 内置, never 内核.
//   4. A hint answers "what is this number and how do I read it", never "what
//      is the code doing".
//
// Module default is Chinese, the panel's original language; it is also what the
// panel shows when no locale service is attached (unit tests, a host that
// composes no locale namespace).

/** Primary dictionary. Every key here is the message-key union. */
export const DICT_ZH = {
  title: '性能透镜',
  intensityLabel: '采样强度',
  stop: '停止采样',
  low: '低采样',
  high: '高采样',
  stopHint: '停止采样：不再采集新窗口；已记录的历史与当前看板保留',
  lowHint: '低采样（默认）：采一个窗口后休眠一段时间，把常驻开销压到最低',
  highHint: '高采样：窗口之间不休息，看板更实时但开销更高；10 分钟后自动回到低采样',
  extrasLabel: '附加采样',
  background: '后台采样',
  backgroundHint: '后台采样：低采样率常驻，面板关闭也继续采集。强度选「停止」时由它决定是否继续记录；强度为低或高时前台采样已经覆盖',
  memory: '内存采样',
  memoryHint: '内存采样：在 CPU 之外同时采集内存分配，开销最高；用于内存归因、热点函数与异步归因；再次点击关闭',
  memoryOn: '内存采样已开（同时采 CPU 与内存分配）',
  probe: '卡顿探针',
  probeLabel: '卡顿探针',
  probeHint: '卡顿探针：在页面里测量「哪些插件注册的回调占用了主线程」。桌面窗口的浏览器不上报长动画帧的脚本归属，这是该环境下唯一能定位到插件的测量。默认关闭；开启时会自动刷新一次页面，之后每次加载都会在插件注册之前装上探针',
  probeReload: '探针已开：正在刷新页面，让已注册的回调被计入',
  probeOff: '探针未开启',
  probeUnresolved: '未能归因',
  scheduleTitle: '主线程调度（按注册位置）',
  scheduleOwner: '插件',
  scheduleMs: '回调耗时 (ms)',
  scheduleCalls: '调用次数',
  scheduleMax: '单次最长 (ms)',
  scheduleCoverage: '回调时间已归因 {coverage}；其余为未解析位置',
  scheduleBasis: '按注册位置统计，是注册方视图：同一插件可注册他人的回调，嵌套包装会重复计入',
  scheduleContractMismatch: '探针自检不一致：插件拼接规则与段表假设不符，归因结果不可信，已隐藏',
  hostSkew: '面板与主机不是同一次构建（主机没有上报采样配置），这些开关暂不可用：重启主机后即可生效',
  overview: '进程总览',
  rss: '常驻内存',
  heap: '堆内存',
  lag: '事件循环延迟 p99',
  gc: 'GC 停顿',
  window: '窗口',
  activeSamples: '有效样本',
  idleShare: '空闲占比',
  rssHint: '进程占用的物理内存总量（Resident Set Size）',
  heapHint: 'Node/V8 堆中已使用的内存，不含外部内存与缓冲区',
  lagHint: '事件循环延迟的第 99 百分位：99% 的延迟都低于它；越高说明主线程越忙',
  gcHint: '垃圾回收暂停主线程的累计时间（本采样窗口内）',
  windowHint: '一个采样窗口的长度；面板里所有「每秒」数字都按它换算',
  activeSamplesHint: '有效样本 / 总样本：空闲样本不计入，份额按有效样本计算',
  idleShareHint: '空闲样本的比例；越高说明宿主越闲，份额列越容易被放大',
  cpuCoverage: '采样覆盖',
  cpuCoverageHint: '采样归因到的 CPU ÷ 进程实际消耗的 CPU。低于 100% 说明有一部分 CPU 在采样线程之外（线程池、原生代码、GC 线程）；接近 100% 说明宿主确实很闲，不是没采到',
  cpuCoverageUnknown: '采样覆盖不可测（本窗口进程 CPU 太低）',
  sampleResolution: '采样分辨率',
  sampleResolutionHint: '本窗口 {total} 个样本里只有 {active} 个非空闲：1 个样本 ≈ {interval}ms CPU，份额粒度 {granularity}。单窗口测不到的开销，请看「累计」列的跨窗口聚合',
  unattributed: '无法归属',
  unattributedHint: '采样时定位不到归属的部分：框架内部、运行时、或未被采样的代码',
  self: '本插件开销',
  selfHint: '性能透镜插件自身采样与分析的开销（不是被测插件的开销）',
  processTree: '后代进程',
  processTreeHint: '宿主进程派生的子进程：总数 / 合计 CPU 占单核比例 / 合计常驻内存。shell 命令、终端、语言服务器都在子进程里跑，所以「宿主很闲但机器很忙」是正常的。这些开销不归因到任何插件，只用来解释这个差距',
  processTreeWarn: '机器忙在子进程里',
  processTreeNone: '后代进程不可读',
  unexplainedCpu: '未解释 CPU',
  unexplainedCpuHint: '进程实际消耗的 CPU 减去采样归因到的 CPU。采样器只看得到主线程，这部分很可能在 worker 线程或主线程之外的原生代码里；它不是任何插件的开销，插件份额因此会偏低',
  activeResources: '进程资源',
  activeResourcesHint: '进程当前持有的异步资源数量（定时器 / socket / 句柄等）。按插件归因需要常驻 async_hooks，实测会带来 +123% 的 promise 开销，所以这里只给进程级总量；看趋势比看数值有用',
  listeners: '监听器',
  listenersHint: '该插件在 cordis 事件总线上注册的监听器数量，直接从事件服务的注册表读出，精确且不包装任何调用。0 表示确实没注册；「—」表示注册表不可读',
  onDisk: '磁盘占用',
  onDiskHint: '该插件在 $DSH_HOME 下占用的字节数（代码与缓存），目录扫描得出，精确；空表示首次扫描尚未完成',
  diskScanPending: '磁盘扫描未完成',
  diskScanTruncated: '磁盘扫描达到预算上限，数值是下界',
  notMeasured: '未测量',
  harness: 'harness 内置',
  harnessHint: 'DeepSeek Harness 自带内部包的合计；展开可看内部包排名',
  composition: '开销构成',
  cpuComposition: 'CPU 占比构成（按有效样本）',
  heapComposition: '内存占用构成（采样估算）',
  heapEstimate: '内存占用来自内存采样的归因，按进程堆内存总量换算；未开内存采样时只显示能归属的部分',
  otherPlugins: '其他插件',
  unattributedHeap: '无法归属（框架 / 未采样）',
  freeRest: '空闲 / 未采样',
  topConsumers: '主要消耗',
  avg: '平均',
  peak: '峰值',
  coreShare: '单核占比',
  coreShareHint: '占单核的百分比与每秒 CPU 毫秒数：跨宿主、跨时段可比的绝对值',
  liveHeap: '存活对象',
  liveHeapHint: '采样时仍存活、未被回收的对象占用',
  heapShort: '内存占用',
  trend: '趋势（CPU）',
  range: '范围',
  metricLabel: '趋势口径',
  metricShare: '占比',
  metricAbsolute: '绝对值',
  noTrend: '趋势数据不足（至少两个窗口）',
  hiddenZero: '已隐藏占用低于阈值的插件',
  linesCapped: '仅绘制峰值最高的前 12 条曲线',
  moreLines: '另有 {n} 条曲线未在图例标注',
  trendBasisHint: '纵轴是「有效样本占比」：宿主空闲时会放大读数；跨时段比较请用「绝对值」',
  vitals: '前台卡顿（浏览器）',
  longTasks: '长任务',
  rafGap: '帧间隔 p95',
  longTasksHint: '浏览器主线程上超过 50ms 的任务数量与总时长',
  rafGapHint: '浏览器帧间隔的第 95 百分位；约 16.7ms 对应流畅的 60fps',
  janky: '卡顿',
  smooth: '流畅',
  noVitals: '等待浏览器上报…',
  correlation: '时间相关不等于因果：此浏览器不支持长动画帧归因，只能与宿主 CPU 按时间并列',
  jankOwner: '插件',
  jankScriptMs: '脚本耗时 (ms)',
  jankLayoutMs: '强制布局 (ms)',
  jankFrames: '长帧条目',
  jankCoverage: '长帧脚本时间已归因 {coverage}；其余为聚合折叠或未能解析',
  jankTableHint: '长动画帧（LoAF）实测的脚本执行耗时，按插件归因',
  jankUnresolved: '未能归因',
  jankOther: '其他（小条目聚合）',
  scoreboard: '累计开销排行（累计核时）',
  cumulative: '累计',
  estimate: '估算',
  estimateHint: '按采样覆盖率（{coverage}）把采到的 CPU 放大到整个时段；是推算，不是测量',
  estimateHidden: '采样只覆盖了此时段的 {coverage}，整段估算将是 {factor} 倍的放大推算，因此不显示',
  scoreboardIdle: '另有 {n} 个插件在此时段内没有采到 CPU，未列出',
  noScoreboard: '此时段内还没有采到 CPU',
  showAll: '显示全部 {n} 个',
  showTop: '只看前 {n} 名',
  p95: 'p95',
  p95Hint: '第 95 百分位：95% 的采样窗口低于该值',
  plugins: '插件明细',
  plugin: '插件',
  cpu: 'CPU',
  spark: '走势',
  disk: '磁盘 读/写',
  alloc: '分配速率',
  lowCoverage: '覆盖不足',
  absolute: '绝对值',
  absoluteHint: '每秒采样时间内的 CPU 毫秒数，以及占单核的比例；跨时段比较请看它',
  idleBasisHint: '本轮大部分时间空闲：份额只按有效样本计算，会被放大；跨时段比较请看「单核占比」',
  groupExternal: '外部插件',
  groupHarness: 'harness 内置',
  groupRuntime: '运行时',
  groupSelf: '本插件开销',
  groupOther: '其他',
  runtime: '运行时',
  runtimeGc: 'GC 回收',
  runtimeNative: '原生 / 系统调用',
  runtimeNode: 'Node.js 内部',
  runtimeEventLoop: '事件循环',
  staticFold: '本窗口无开销',
  harnessBreakdown: '内部包',
  harnessBreakdownHint: '折叠的 harness 行隐藏了内部包排名；这里按绝对开销列出前几个',
  hotspot: '热点函数（自身耗时）',
  hotspotNone: '暂无热点数据（需开启内存采样并等待一个窗口）',
  empty: '等待第一个采样窗口…',
  error: '采样面板不可用',
  renderFailed: '面板渲染失败',
  renderFailedHint: '宿主与客户端版本可能不一致：重启宿主（或刷新页面）后重试；控制台有完整堆栈',
} as const

/** Message-key union; the English dictionary must cover it exactly. */
export type MessageKey = keyof typeof DICT_ZH

/**
 * English dictionary. Typed as a full Record so a missing or extra key is a
 * compile error — the harness enforces bilingual balance at registration, and
 * this makes it impossible to reach that check with an incomplete pair.
 */
export const DICT_EN: Record<MessageKey, string> = {
  title: 'Perf Lens',
  intensityLabel: 'Sampling intensity',
  stop: 'Stop sampling',
  low: 'Low sampling',
  high: 'High sampling',
  stopHint: 'Stop sampling: no new windows; recorded history and the current board stay',
  lowHint: 'Low sampling (default): samples one window, then sleeps, keeping the always-on cost minimal',
  highHint: 'High sampling: no sleep between windows, a more live board at a higher cost; drops back to low after 10 minutes',
  extrasLabel: 'Extra sampling',
  background: 'Background sampling',
  backgroundHint: 'Background sampling: low-rate always-on capture, keeps sampling while the panel is closed. It decides what happens while the intensity is Stop; at Low or High the foreground already covers it',
  memory: 'Memory sampling',
  memoryHint: 'Memory sampling: samples memory allocation alongside CPU at the highest cost; used for memory attribution, hot functions and async re-attribution; click again to turn it off',
  memoryOn: 'Memory sampling on (CPU and memory allocation)',
  probe: 'Jank probe',
  probeLabel: 'Jank probe',
  probeHint: 'Jank probe: measures in the page which plugins\' registered callbacks occupy the main thread. The desktop window\'s browser reports no script attribution on long animation frames, so this is the only per-plugin measurement available there. Off by default; turning it on reloads once, and every later load installs it before the plugins register',
  probeReload: 'Probe on: reloading so callbacks registered earlier are counted',
  probeOff: 'Probe off',
  probeUnresolved: 'Unresolved',
  scheduleTitle: 'Main-thread scheduling (by registration site)',
  scheduleOwner: 'Plugin',
  scheduleMs: 'Callback ms',
  scheduleCalls: 'Calls',
  scheduleMax: 'Longest ms',
  scheduleCoverage: '{coverage} of callback time attributed; the rest is unresolvable registration sites',
  scheduleBasis: 'Counted by registration site — the registrar view: one plugin can register another\'s callback, and nested wrappers count twice',
  scheduleContractMismatch: 'Probe self-test failed: the plugin concatenation rule no longer matches the segment table, so the attribution is hidden',
  hostSkew: 'The panel and the host are different builds (the host reports no sampling config), so these controls are unavailable: restart the host to use them',
  overview: 'Process overview',
  rss: 'Resident memory',
  heap: 'Heap memory',
  lag: 'Event-loop lag p99',
  gc: 'GC pause',
  window: 'Window',
  activeSamples: 'Active samples',
  idleShare: 'Idle share',
  rssHint: 'Physical memory held by the process (Resident Set Size)',
  heapHint: 'Memory in use on the Node/V8 heap; excludes external memory and buffers',
  lagHint: '99th percentile of event-loop lag: 99% of delays stay below it; higher means a busier main thread',
  gcHint: 'Total time garbage collection paused the main thread during this sampling window',
  windowHint: 'Length of one sampling window; every per-second figure in the panel is derived from it',
  activeSamplesHint: 'Active over total samples: idle samples are excluded, and shares are computed over active samples only',
  idleShareHint: 'Share of samples that were idle; the higher it is, the more the share column is inflated',
  cpuCoverage: 'Sampled coverage',
  cpuCoverageHint: 'Sampled CPU divided by the CPU the process actually burned. Below 100% some CPU ran outside the sampled thread (thread pool, native code, GC threads); near 100% means the host really was idle, not that sampling missed it',
  cpuCoverageUnknown: 'Coverage unmeasurable (process CPU too low this window)',
  sampleResolution: 'Sample resolution',
  sampleResolutionHint: 'Only {active} of this window\'s {total} samples were non-idle: one sample is about {interval}ms of CPU, so the share granularity is {granularity}. For cost below that, use the cumulative column across windows',
  unattributed: 'Unattributed',
  unattributedHint: 'Samples that resolved to no owner: framework internals, runtime, or code that was never sampled',
  self: "This plugin's overhead",
  selfHint: 'Overhead of the Perf Lens plugin itself (sampling and analysis), not of the measured plugin',
  processTree: 'Descendants',
  processTreeHint: 'Processes the host spawned: count / combined CPU as a share of one core / combined resident memory. Shell commands, terminals and language servers all run as children, so an idle host on a busy machine is normal. None of this is attributed to a plugin; it explains the gap',
  processTreeWarn: 'the machine is busy in child processes',
  processTreeNone: 'Descendant processes unreadable',
  unexplainedCpu: 'Unexplained CPU',
  unexplainedCpuHint: 'CPU the process actually burned minus the CPU the samples account for. The sampler only sees the main thread, so this is likely a worker thread or native code off the main thread. It is not any plugin\'s cost, and plugin shares read low because of it',
  activeResources: 'Process resources',
  activeResourcesHint: 'Async resources the process is holding right now (timers, sockets, handles). Attributing them per plugin needs an always-on async_hooks hook, measured at +123% on promise-heavy work, so this is a process total only; the trend matters more than the number',
  listeners: 'Listeners',
  listenersHint: 'Event listeners this plugin registered on the cordis event bus, read straight out of the event service registry: exact, and nothing is wrapped. 0 means none registered; an em dash means the registry was unreadable',
  onDisk: 'On disk',
  onDiskHint: 'Bytes this plugin holds under $DSH_HOME (code and caches), from a directory scan and exact; empty until the first scan finishes',
  diskScanPending: 'Disk scan not finished yet',
  diskScanTruncated: 'Disk scan hit its budget; the figures are a lower bound',
  notMeasured: 'not measured',
  harness: 'Harness built-ins',
  harnessHint: 'All DeepSeek Harness internal packages combined; expand to see the internal ranking',
  composition: 'Cost composition',
  cpuComposition: 'CPU composition (by active samples)',
  heapComposition: 'Memory composition (sampled estimate)',
  heapEstimate: 'Memory comes from memory-sampling attribution, scaled to the process heap total; without memory sampling only the attributable part is shown',
  otherPlugins: 'Other plugins',
  unattributedHeap: 'Unattributed (framework / unsampled)',
  freeRest: 'Idle / unsampled',
  topConsumers: 'Top consumers',
  avg: 'Avg',
  peak: 'Peak',
  coreShare: 'Share of one core',
  coreShareHint: 'Percent of one core and CPU milliseconds per second: the absolute figure comparable across hosts and periods',
  liveHeap: 'Live objects',
  liveHeapHint: 'Bytes held by objects still alive at sampling time',
  heapShort: 'Memory',
  trend: 'Trend (CPU)',
  range: 'Range',
  metricLabel: 'Trend basis',
  metricShare: 'Share',
  metricAbsolute: 'Absolute',
  noTrend: 'Not enough trend data (at least two windows)',
  hiddenZero: 'Plugins below the threshold are hidden',
  linesCapped: 'Only the top 12 series by peak are drawn',
  moreLines: '{n} more series not labelled in the legend',
  trendBasisHint: 'The y-axis is share of active samples: an idle host inflates it; compare periods with the Absolute basis',
  vitals: 'Foreground jank (browser)',
  longTasks: 'Long tasks',
  rafGap: 'Frame gap p95',
  longTasksHint: 'Count and total duration of browser main-thread tasks longer than 50ms',
  rafGapHint: '95th percentile of the browser frame gap; about 16.7ms is a smooth 60fps',
  janky: 'Janky',
  smooth: 'Smooth',
  noVitals: 'Waiting for the browser report…',
  correlation: 'Time correlation is not causation: this browser lacks long-animation-frame attribution, so host CPU is merely juxtaposed in time',
  jankOwner: 'Plugin',
  jankScriptMs: 'Script ms',
  jankLayoutMs: 'Forced layout ms',
  jankFrames: 'Frame entries',
  jankCoverage: '{coverage} of long-frame script time attributed; the rest is aggregated or unresolvable',
  jankTableHint: 'Script execution time on long animation frames (LoAF), attributed per plugin',
  jankUnresolved: 'Unresolved',
  jankOther: 'Other (small entries aggregated)',
  scoreboard: 'Cumulative cost ranking (core-time)',
  cumulative: 'Cumulative',
  estimate: 'Estimate',
  estimateHint: 'Sampled CPU scaled up to the whole range by sampling coverage ({coverage}); an extrapolation, not a measurement',
  estimateHidden: 'Sampling covered only {coverage} of this range; a whole-range estimate would be a {factor}x extrapolation, so it is hidden',
  scoreboardIdle: '{n} more plugins had no sampled CPU in this range and are not listed',
  noScoreboard: 'No CPU sampled in this range yet',
  showAll: 'Show all {n}',
  showTop: 'Show top {n}',
  p95: 'p95',
  p95Hint: '95th percentile: 95% of sampling windows stay below this value',
  plugins: 'Plugin detail',
  plugin: 'Plugin',
  cpu: 'CPU',
  spark: 'Spark',
  disk: 'Disk r/w',
  alloc: 'Alloc rate',
  lowCoverage: 'Low coverage',
  absolute: 'Absolute',
  absoluteHint: 'CPU milliseconds per sampled second and the share of one core; use it to compare across periods',
  idleBasisHint: 'The host was mostly idle this window: shares divide by active samples only, so they read high; compare the share-of-one-core figure across periods',
  groupExternal: 'External plugins',
  groupHarness: 'Harness built-ins',
  groupRuntime: 'Runtime',
  groupSelf: "This plugin's overhead",
  groupOther: 'Other',
  runtime: 'Runtime',
  runtimeGc: 'GC',
  runtimeNative: 'Native / syscalls',
  runtimeNode: 'Node.js internals',
  runtimeEventLoop: 'Event loop',
  staticFold: 'No cost this window',
  harnessBreakdown: 'internal packages',
  harnessBreakdownHint: 'The folded harness row hides the internal ranking; these are the biggest internal packages by absolute cost',
  hotspot: 'Hot functions (self time)',
  hotspotNone: 'No hotspot data yet (turn on memory sampling and wait one window)',
  empty: 'Waiting for the first sampling window…',
  error: 'Sampling panel unavailable',
  renderFailed: 'Panel render failed',
  renderFailedHint: 'The host and client builds may differ: restart the host (or refresh the page) and retry; the console has the full stack',
}

/** Locales this panel ships. */
export type PanelLocale = 'zh' | 'en'

/** Locale used until a locale service pushes the active one. */
export const DEFAULT_LOCALE: PanelLocale = 'zh'

const DICTS: Record<PanelLocale, Record<MessageKey, string>> = { zh: DICT_ZH, en: DICT_EN }

let activeLocale: PanelLocale = DEFAULT_LOCALE
const listeners = new Set<() => void>()

/**
 * Map a harness locale id onto a dictionary this panel ships.
 *
 * The built-ins are exactly 'zh' and 'en'; a language pack may hand over a
 * regional tag ('zh-CN', 'en-US'), so match on the primary subtag. Anything
 * else takes English, mirroring the harness FALLBACK_LOCALE.
 */
export function normalizeLocale(id: string | undefined): PanelLocale {
  const value = (id ?? '').toLowerCase()
  if (value.startsWith('zh')) return 'zh'
  return 'en'
}

export function getActiveLocale(): PanelLocale {
  return activeLocale
}

/** Switch dictionaries and notify subscribers; a no-op switch notifies nobody. */
export function setActiveLocale(id: string | undefined): void {
  const next = normalizeLocale(id)
  if (next === activeLocale) return
  activeLocale = next
  // Snapshot the listeners: one of them may unsubscribe (or switch again) while
  // being notified, and a live Set iteration would visit the change mid-flight.
  for (const listener of Array.from(listeners)) listener()
}

/** Subscribe to dictionary switches; returns the unsubscribe. */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Translate one panel message. `{name}` placeholders are substituted from
 * `params`; an unknown placeholder is left verbatim so a missing parameter is
 * visible rather than silently blank.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const dict = DICTS[activeLocale]
  const template = dict[key] ?? DICT_ZH[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (
    name in params ? String(params[name]) : match
  ))
}

/**
 * Short label for a harness internal package key. The board is already inside
 * the harness group, so the `harness:` prefix and the `@deepseek-ai/` scope are
 * pure noise: `harness:@deepseek-ai/dsh-client-hmr` reads as `dsh-client-hmr`.
 */
export function displayHarnessPackage(moduleName: string): string {
  const bare = moduleName.startsWith('harness:') ? moduleName.slice('harness:'.length) : moduleName
  return bare.replace(/^@deepseek-ai\//, '')
}

/**
 * Human name for an owner row. Runtime subkinds get a label; plugin rows keep
 * their module name.
 */
export function displayOwner(moduleName: string): string {
  switch (moduleName) {
    case 'runtime': return t('runtime')
    case 'runtime:gc': return t('runtimeGc')
    case 'runtime:native': return t('runtimeNative')
    case 'runtime:node': return t('runtimeNode')
    case 'runtime:event-loop': return t('runtimeEventLoop')
    case 'harness': return t('harness')
    case 'self': return t('self')
    default: return moduleName
  }
}
