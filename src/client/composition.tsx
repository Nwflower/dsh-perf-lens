// Process-level composition: two stacked bars answering the question a
// per-plugin table cannot — "of THIS whole process, how much is plugin X?".
//
// CPU bar: each plugin's cpuShare (share of active samples) plus the
// bookkeeping slices the contract surfaces — unattributed, self-overhead —
// and the idle/unsampled remainder, so the bar always totals the process.
// Heap bar: liveHeapBytes normalized by heapUsed, with the heap nobody
// claimed shown explicitly instead of disappearing.
//
// Segment building is pure and exported for tests; rendering is classes
// from styles/panel.css plus the shared chart palette.

import type { PerfSnapshot } from '../shared/contract'
import { formatBytes, formatPercent } from './format'
import { displayOwner, t } from './i18n'
import { chartColor, FREE_COLOR, REST_COLOR, UNATTRIBUTED_COLOR } from './palette'

/** Top plugins named individually; everything smaller folds into "Other plugins". */
export const COMPOSITION_TOP_LIMIT = 5

export interface CompositionSegment {
  readonly key: string
  readonly label: string
  /** 0..1 of the bar's total. */
  readonly share: number
  /** Absolute byte size; heap segments only. */
  readonly bytes?: number
  readonly color: string
}

interface RankedRow {
  readonly name: string
  readonly value: number
}

function segmentsOf(
  ranked: readonly RankedRow[],
  total: number,
  toSegment: (name: string, value: number) => { readonly bytes?: number },
): CompositionSegment[] {
  const segments: CompositionSegment[] = []
  ranked.slice(0, COMPOSITION_TOP_LIMIT).forEach((row, index) => {
    segments.push({
      key: row.name,
      label: displayOwner(row.name),
      share: row.value / total,
      ...toSegment(row.name, row.value),
      color: chartColor(index),
    })
  })
  const rest = ranked.slice(COMPOSITION_TOP_LIMIT).reduce((sum, row) => sum + row.value, 0)
  if (rest > 0) {
    segments.push({ key: '__rest', label: t('otherPlugins'), share: rest / total, color: REST_COLOR })
  }
  return segments
}

/**
 * CPU composition over the window's active samples. The remainder slice is
 * what no owner claimed and the lens did not spend itself — mostly runtime
 * work between attributions — clamped at zero because sampled shares are
 * estimates and can overshoot slightly.
 */
export function buildCpuSegments(snapshot: PerfSnapshot): CompositionSegment[] {
  // 'self'/'unattributed' arrive BOTH as bookkeeping fields and (on some
  // hosts) as plugin rows — merge each pair into one slice so the bar never
  // counts the same samples twice.
  const rows = snapshot.plugins.filter(row => row.cpuShare > 0)
  const rowShareOf = (name: string): number => rows.find(row => row.moduleName === name)?.cpuShare ?? 0
  const ranked = rows
    .filter(row => row.moduleName !== 'self' && row.moduleName !== 'unattributed')
    .map(row => ({ name: row.moduleName, value: row.cpuShare }))
    .sort((left, right) => right.value - left.value)
  const segments = segmentsOf(ranked, 1, () => ({}))
  const unattributed = Math.max(snapshot.unattributedShare, rowShareOf('unattributed'))
  if (unattributed > 0) {
    segments.push({ key: '__unattributed', label: t('unattributed'), share: unattributed, color: UNATTRIBUTED_COLOR })
  }
  const self = Math.max(snapshot.selfShare, rowShareOf('self'))
  if (self > 0) {
    segments.push({ key: '__self', label: t('self'), share: self, color: UNATTRIBUTED_COLOR })
  }
  const used = segments.reduce((sum, segment) => sum + segment.share, 0)
  const free = Math.max(0, 1 - used)
  if (free > 0.001) {
    segments.push({ key: '__free', label: t('freeRest'), share: free, color: FREE_COLOR })
  }
  return segments
}

/**
 * Heap composition over the process's heapUsed. The unclaimed slice —
 * harness internals, runtime structures, anything the sampler could not
 * attribute — is explicit, per the honesty rule that an estimate must never
 * look exact. When the sampled attribution overshoots heapUsed (sampling
 * skew), the bar normalizes against the attribution sum instead of lying.
 */
export function buildHeapSegments(snapshot: PerfSnapshot): CompositionSegment[] {
  const heapUsed = snapshot.global.heapUsed
  if (!Number.isFinite(heapUsed) || heapUsed <= 0) return []
  const ranked = snapshot.plugins
    .filter(row => row.liveHeapBytes > 0)
    .map(row => ({ name: row.moduleName, value: row.liveHeapBytes }))
    .sort((left, right) => right.value - left.value)
  const attributed = ranked.reduce((sum, row) => sum + row.value, 0)
  const total = Math.max(heapUsed, attributed)
  const segments = segmentsOf(ranked, total, (_name, value) => ({ bytes: value }))
  const unclaimed = Math.max(0, heapUsed - attributed)
  if (unclaimed / total > 0.001) {
    segments.push({ key: '__unclaimed', label: t('unattributedHeap'), share: unclaimed / total, bytes: unclaimed, color: UNATTRIBUTED_COLOR })
  }
  const free = Math.max(0, total - attributed - unclaimed)
  if (free / total > 0.001) {
    segments.push({ key: '__free', label: t('freeRest'), share: free, color: FREE_COLOR })
  }
  return segments
}

export interface CompositionProps {
  readonly snapshot: PerfSnapshot
}

function CompositionBar({ label, segments, heap, note }: {
  readonly label: string
  readonly segments: readonly CompositionSegment[]
  readonly heap: boolean
  readonly note?: string
}) {
  return (
    <div className="pl-comp-col">
      <div className="pl-comp-label"><strong>{label}</strong></div>
      {segments.length === 0 ? <div className="pl-empty">{t('empty')}</div> : (
        <>
          <div className="pl-bar" role="img" aria-label={label}>
            {segments.map(segment => (
              <div
                key={segment.key}
                className="pl-bar-seg"
                title={segment.label + ' ' + formatPercent(segment.share)}
                style={{ width: (segment.share * 100).toFixed(2) + '%', background: segment.color }}
              />
            ))}
          </div>
          <div className="pl-legend">
            {segments.map(segment => (
              <div key={segment.key} className="pl-legend-row">
                <span className="pl-legend-dot" style={{ background: segment.color }} />
                <span className="pl-legend-name">{segment.label}</span>
                <span className="pl-legend-val">
                  {heap && segment.bytes !== undefined ? formatBytes(segment.bytes) + ' · ' : ''}
                  <strong>{formatPercent(segment.share)}</strong>
                </span>
              </div>
            ))}
          </div>
          {note === undefined ? null : <div className="pl-note" style={{ marginTop: '6px' }}>{note}</div>}
        </>
      )}
    </div>
  )
}

export function Composition({ snapshot }: CompositionProps) {
  const cpu = buildCpuSegments(snapshot)
  const heap = buildHeapSegments(snapshot)
  return (
    <div className="pl-card">
      <div className="pl-card-title">{t('composition')}</div>
      <div className="pl-comp">
        <CompositionBar label={t('cpuComposition')} segments={cpu} heap={false} />
        <CompositionBar label={t('heapComposition')} segments={heap} heap note={t('heapEstimate')} />
      </div>
    </div>
  )
}
