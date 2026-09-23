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
  pause: '暂停采样',
  resume: '恢复采样',
  continuous: '连续采样',
  background: '后台采样',
  deep: '深度采样',
  deepOn: '深度模式已开（同时采 CPU 与内存分配）',
  modeLabel: '采样模式',
  duty: '间歇采样',
  paused: '已暂停',
  backgroundHint: '后台采样：低采样率常驻，面板关闭也继续采集；再次点击回到间歇采样',
  continuousHint: '连续采样：窗口之间不休息，看板更实时但开销更高；10 分钟后自动回到间歇采样；再次点击可立即回到间歇采样',
  deepHint: '深度采样：在 CPU 之外同时采集内存分配，开销更高；用于热点函数与内存归因；再次点击关闭',
  dutyHint: '间歇采样（默认）：采一个窗口后休眠一段时间，把常驻开销压到最低',
  pauseHint: '暂停采样：停止采集新窗口；已记录的历史与当前看板保留',
  resumeHint: '恢复采样：回到暂停前的采样档位，继续采集',
  pausedHint: '已暂停：不再采集新窗口；点击「恢复采样」继续',
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
  harness: 'harness 内置',
  harnessHint: 'DeepSeek Harness 自带内部包的合计；展开可看内部包排名',
  composition: '开销构成',
  cpuComposition: 'CPU 占比构成（按有效样本）',
  heapComposition: '内存占用构成（采样估算）',
  heapEstimate: '内存占用来自深度采样的归因，按进程堆内存总量换算；未开深度模式时只显示能归属的部分',
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
  correlation: '时间相关不等于因果：浏览器无法把卡顿归因到具体插件，只能按时间并列',
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
  hotspotNone: '暂无热点数据（需开启深度模式并等待一个窗口）',
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
  pause: 'Pause sampling',
  resume: 'Resume sampling',
  continuous: 'Continuous sampling',
  background: 'Background sampling',
  deep: 'Deep sampling',
  deepOn: 'Deep mode on (CPU and memory allocation sampling)',
  modeLabel: 'Sampling mode',
  duty: 'Intermittent',
  paused: 'Paused',
  backgroundHint: 'Background sampling: low-rate always-on capture, keeps sampling while the panel is closed; click again for intermittent',
  continuousHint: 'Continuous sampling: no sleep between windows, a more live board at a higher cost; reverts to intermittent after 10 minutes; click again to return now',
  deepHint: 'Deep sampling: samples memory allocation alongside CPU at a higher cost; used for hotspots and memory attribution; click again to turn it off',
  dutyHint: 'Intermittent (default): samples one window, then sleeps, keeping the always-on cost minimal',
  pauseHint: 'Pause sampling: stops opening new windows; recorded history and the current board stay',
  resumeHint: 'Resume sampling: returns to the tier that was active before the pause',
  pausedHint: 'Paused: no new windows are collected; click "Resume sampling" to continue',
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
  harness: 'Harness built-ins',
  harnessHint: 'All DeepSeek Harness internal packages combined; expand to see the internal ranking',
  composition: 'Cost composition',
  cpuComposition: 'CPU composition (by active samples)',
  heapComposition: 'Memory composition (sampled estimate)',
  heapEstimate: 'Memory comes from deep-sampling attribution, scaled to the process heap total; without deep mode only the attributable part is shown',
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
  correlation: 'Time correlation is not causation: the browser cannot attribute jank to a plugin; times are merely juxtaposed',
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
  hotspotNone: 'No hotspot data yet (enable deep mode and wait one window)',
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
