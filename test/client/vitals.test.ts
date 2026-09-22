// Folding raw long-task and frame-gap observations into a report.

import { describe, expect, test } from 'vitest'
import { summarizeVitals } from '../../src/client/vitals'

describe('summarizeVitals', () => {
  test('counts long tasks, sums their duration and takes the p95 frame gap', () => {
    const report = summarizeVitals([60, 120], [16, 17, 16, 200], 5000, 42)
    expect(report).toEqual({ longTaskCount: 2, longTaskTotalMs: 180, rafGapP95Ms: 200, windowMs: 5000, at: 42 })
  })

  test('an empty window is all zeros', () => {
    expect(summarizeVitals([], [], 5000, 1)).toEqual({
      longTaskCount: 0, longTaskTotalMs: 0, rafGapP95Ms: 0, windowMs: 5000, at: 1,
    })
  })
})
