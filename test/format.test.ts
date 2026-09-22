// Presentation formatting: the panel must show a dash, not a fake zero, for a
// metric that has no value.

import { describe, expect, test } from 'vitest'
import { formatBytes, formatMs, formatOps, formatPercent } from '../src/client/format'

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

describe('formatMs / formatOps', () => {
  test('formats durations and operation pairs', () => {
    expect(formatMs(12.34)).toBe('12ms')
    expect(formatMs(0)).toBe('0ms')
    expect(formatOps(2, 1)).toBe('2 / 1')
    expect(formatOps(0, 0)).toBe('—')
  })
})
