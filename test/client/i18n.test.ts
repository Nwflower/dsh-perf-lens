// Bilingual dictionary coverage and the locale switch itself.
//
// The harness enforces bilingual balance at registration (every namespace must
// carry all built-in locales), so an incomplete pair must fail here first — the
// English dictionary is typed as a full Record, and these tests lock the runtime
// behaviour of lookup, fallback and the switch notification.

import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_LOCALE, DICT_EN, DICT_ZH, displayHarnessPackage, displayOwner,
  getActiveLocale, normalizeLocale, setActiveLocale, subscribeLocale, t,
} from '../../src/client/i18n'

afterEach(() => { setActiveLocale(DEFAULT_LOCALE) })

describe('dictionary balance', () => {
  test('both locales cover exactly the same keys', () => {
    expect(Object.keys(DICT_EN).sort()).toEqual(Object.keys(DICT_ZH).sort())
  })

  test('no translation is empty or a bare key', () => {
    for (const [key, value] of Object.entries(DICT_ZH)) {
      expect(value.trim(), 'zh:' + key).not.toBe('')
    }
    for (const [key, value] of Object.entries(DICT_EN)) {
      expect(value.trim(), 'en:' + key).not.toBe('')
    }
  })
})

describe('normalizeLocale', () => {
  test('maps the built-ins and regional tags onto a shipped dictionary', () => {
    expect(normalizeLocale('zh')).toBe('zh')
    expect(normalizeLocale('zh-CN')).toBe('zh')
    expect(normalizeLocale('en')).toBe('en')
    expect(normalizeLocale('en-US')).toBe('en')
  })

  test('anything else takes English, mirroring the harness fallback', () => {
    expect(normalizeLocale('ja')).toBe('en')
    expect(normalizeLocale(undefined)).toBe('en')
  })
})

describe('translate', () => {
  test('defaults to Chinese', () => {
    expect(getActiveLocale()).toBe('zh')
    expect(t('title')).toBe('性能透镜')
    expect(displayOwner('runtime')).toBe('运行时')
  })

  test('follows a switch to English without a reload', () => {
    setActiveLocale('en')
    expect(getActiveLocale()).toBe('en')
    expect(t('title')).toBe('Perf Lens')
    expect(t('groupHarness')).toBe('Harness built-ins')
    expect(displayOwner('runtime')).toBe('Runtime')
    expect(displayOwner('runtime:event-loop')).toBe('Event loop')
    expect(displayOwner('pluginA')).toBe('pluginA')
  })

  test('substitutes {name} placeholders in both languages', () => {
    expect(t('moreLines', { n: 4 })).toBe('另有 4 条曲线未在图例标注')
    setActiveLocale('en')
    expect(t('moreLines', { n: 4 })).toBe('4 more series not labelled in the legend')
    expect(t('estimateHidden', { coverage: '1.50%', factor: 67 }))
      .toBe('Sampling covered only 1.50% of this range; a whole-range estimate would be a 67x extrapolation, so it is hidden')
  })

  test('a missing parameter stays visible instead of blanking the line', () => {
    expect(t('moreLines', {})).toContain('{n}')
  })
})

describe('subscribeLocale', () => {
  test('notifies on a real switch only, and stops after unsubscribe', () => {
    const listener = vi.fn()
    const stop = subscribeLocale(listener)
    setActiveLocale('en')
    expect(listener).toHaveBeenCalledTimes(1)
    // Same locale: republishing would churn every subscriber for nothing.
    setActiveLocale('en-US')
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    setActiveLocale('zh')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('displayHarnessPackage', () => {
  test('strips the owner prefix and scope so a package name fits the column', () => {
    expect(displayHarnessPackage('harness:@deepseek-ai/dsh-client-hmr')).toBe('dsh-client-hmr')
    expect(displayHarnessPackage('harness:@michengai/dsh-archive')).toBe('@michengai/dsh-archive')
    expect(displayHarnessPackage('plain')).toBe('plain')
  })
})

describe('copy review (plain language over profiler jargon)', () => {
  test('the terms a user cannot decode were replaced', () => {
    // Retired: 占空比 (electrical-engineering loan), 自身开销 (whose self?),
    // harness 内核 (it is a product, not a kernel), 存活堆 (terse), 未归属.
    expect(t('low')).toBe('低采样')
    expect(t('self')).toBe('本插件开销')
    expect(t('harness')).toBe('harness 内置')
    expect(t('liveHeap')).toBe('存活对象')
    expect(t('unattributed')).toBe('无法归属')
    expect(t('hotspot')).toBe('热点函数（自身耗时）')
  })

  test('the retired jargon never comes back in either language', () => {
    const retired = ['占空比', '内核', '自身开销', '存活堆', '未归属', 'libuv']
    for (const [key, value] of Object.entries(DICT_ZH)) {
      for (const word of retired) {
        // 'harness 内置' legitimately contains neither; the check is word-level.
        expect(value, key + ' contains retired jargon ' + word).not.toContain(word)
      }
    }
  })

  test('every dense label ships a one-line explanation', () => {
    // The labels a non-specialist cannot decode on sight; each must have a
    // matching *Hint key, in both dictionaries.
    const explained = [
      'rss', 'heap', 'lag', 'gc', 'window', 'activeSamples', 'idleShare',
      'coreShare', 'absolute', 'estimate', 'p95', 'longTasks', 'rafGap',
      'unattributed', 'self', 'harness', 'stop', 'low', 'high', 'background', 'memory', 'liveHeap',
    ]
    for (const key of explained) {
      const hint = key + 'Hint'
      expect(Object.keys(DICT_ZH), hint + ' missing in zh').toContain(hint)
      expect(Object.keys(DICT_EN), hint + ' missing in en').toContain(hint)
      expect(DICT_ZH[hint as keyof typeof DICT_ZH].length).toBeGreaterThan(6)
      expect(DICT_EN[hint as keyof typeof DICT_EN].length).toBeGreaterThan(6)
    }
  })
})
describe('sampling controls read as action + object', () => {
  test('no button is a bare mode adjective', () => {
    // "高" alone does not say what is high; the labels carry their object.
    for (const key of ['stop', 'low', 'high', 'background', 'memory'] as const) {
      expect(DICT_ZH[key], key).toContain('采样')
      expect(DICT_EN[key], key).toContain('sampling')
    }
  })

  test('the three blocks say how they combine', () => {
    // The intensity segment is a radio, so its tiers explain what they do
    // rather than how to get back; the two switches are toggles, so they must
    // say how to turn off, and background sampling must say when it applies —
    // otherwise it looks broken while the foreground is running.
    expect(DICT_ZH.highHint).toContain('自动回到低采样')
    expect(DICT_EN.highHint).toContain('drops back to low')
    expect(DICT_ZH.backgroundHint).toContain('停止')
    expect(DICT_EN.backgroundHint).toContain('Stop')
    expect(DICT_ZH.memoryHint).toContain('再次点击关闭')
    expect(DICT_EN.memoryHint).toContain('click again')
  })
})