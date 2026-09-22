// Panel strings. Chinese is the primary dictionary (the repo's documentation
// language); the locale service namespace is wired when the dictionary is
// registered with ctx.locale.

const DICT = {
  panel: '性能',
  cpu: 'CPU',
  liveHeap: '存活堆',
  disk: '磁盘 读/写',
  alloc: '分配速率',
  coverage: '覆盖度',
  plugin: '插件',
  rss: 'RSS',
  heap: '堆',
  lag: '事件循环延迟 p99',
  gc: 'GC 停顿',
  window: '窗口',
  samples: '样本',
  mode: '模式',
  duty: '占空比',
  continuous: '连续',
  paused: '已暂停',
  deep: '深度模式',
  pause: '暂停',
  resume: '恢复',
  idle: '空闲',
  active: '活动样本',
  unattributed: '未归属',
  self: '自身开销',
  harness: 'harness 内核',
  runtime: '运行时',
  empty: '等待第一个采样窗口…',
  error: '采样面板不可用',
  lowCoverage: '覆盖不足',
  deepOn: '深度模式已开（双采样）',
  trend: '趋势（CPU 占比）',
  scoreboard: '积分榜（累计核时）',
  range: '范围',
  avg: '平均',
  peak: '峰值',
  p95: 'p95',
  cumulative: '累计',
  estimate: '估算',
  refresh: '刷新',
  noTrend: '趋势数据不足（至少两个窗口）',
  hiddenZero: '已隐藏占用 < 阈值 的插件',
  hotspot: '热点函数（self 时间）',
  hotspotNone: '暂无热点数据（需开启深度模式并等待一个窗口）',
  selfTime: 'self',
} as const

export type MessageKey = keyof typeof DICT

/** Translate one panel message. */
export function t(key: MessageKey): string {
  return DICT[key]
}
