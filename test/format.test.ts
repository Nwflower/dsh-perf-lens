// Presentation formatting: the panel must show a dash, not a fake zero, for a
// metric that has no value.

import { describe, expect, test } from 'vitest'
import { cpuCoreShare, cpuMsPerSecond, formatBytes, formatMs, formatMsPerSecond, formatOps, formatPercent, formatTimeOfDay } from '../src/client/format'

describe('formatBytes', () => {
  test('scales to the largest unit', () => {
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(2048)).toBe('2.0KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0MB')
  })

  test('shows a dash for a missing value', () => {
    expect(formatBytes(0)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('formatPercent', () => {
  test('keeps precision where it matters', () => {
    expect(formatPercent(0.5)).toBe('50.0%')
    expect(formatPercent(0.0123)).toBe('1.23%')
    expect(formatPercent(0)).toBe('0%')
  })
})

describe('formatTimeOfDay', () => {
  test('renders local HH:mm for axis labels', () => {
    // Constructed from local components, so the expectation is timezone-independent.
    expect(formatTimeOfDay(new Date(2026, 0, 1, 9, 5).getTime())).toBe('09:05')
    expect(formatTimeOfDay(Number.NaN)).toBe('—')
  })
})

describe('formatMs / formatOps', () => {
  test('formats durations and operation pairs', () => {
    expect(formatMs(12.34)).toBe('12ms')
    expect(formatMs(0)).toBe('0ms')
    expect(formatOps(2, 1)).toBe('2 / 1')
    expect(formatOps(0, 0)).toBe('—')
  })
})

describe('absolute CPU cost (share is not comparable across hosts)', () => {
  test('ms per sampled second and fraction of one core', () => {
    // The §6.5 case: a package at 1.31 ms/s showed as a 96% share on an idle host.
    expect(cpuMsPerSecond(1.31, 1000)).toBeCloseTo(1.31)
    expect(cpuMsPerSecond(18.25, 5000)).toBeCloseTo(3.65)
    expect(cpuCoreShare(18.25, 5000)).toBeCloseTo(0.00365)
    // 18.25ms / 5000ms = 0.365% of one core; float rounding lands on 0.36%.
    expect(formatPercent(cpuCoreShare(18.25, 5000))).toBe('0.36%')
    expect(formatMsPerSecond(18.25, 5000)).toBe('3.65ms/s')
  })

  test('a zero window or a missing value never produces a fake number', () => {
    expect(cpuMsPerSecond(10, 0)).toBe(0)
    expect(cpuCoreShare(10, 0)).toBe(0)
    expect(formatMsPerSecond(0, 5000)).toBe('—')
    expect(formatMsPerSecond(Number.NaN, 5000)).toBe('—')
  })

  test('scales units for the big and small ends', () => {
    expect(formatMsPerSecond(1500, 1000)).toBe('1500ms/s')
    expect(formatMsPerSecond(15, 1000)).toBe('15.0ms/s')
  })
})
