// Global strip: process totals, the sampling window, and the two numbers that
// qualify every per-plugin figure — unattributed share and own overhead.

import type { PerfSnapshot } from '../shared/contract'
import { DEFAULTS } from '../shared/defaults'
import { formatBytes, formatMs, formatPercent } from './format'
import { t } from './i18n'

export interface GlobalBarProps {
  readonly snapshot: PerfSnapshot
}

export function GlobalBar({ snapshot }: GlobalBarProps) {
  const { global } = snapshot
  const activeSamples = Math.max(0, global.sampleCount - global.idleSamples)
  const idleShare = global.sampleCount === 0 ? 0 : global.idleSamples / global.sampleCount
  const items = [
    `${t('rss')} ${formatBytes(global.rss)}`,
    `${t('heap')} ${formatBytes(global.heapUsed)}`,
    `${t('lag')} ${formatMs(global.eventLoopLagP99Ms)}`,
    `${t('gc')} ${formatMs(global.gcPauseMs)}`,
    `${t('window')} ${global.sampleWindowMs}ms`,
    `${t('active')} ${activeSamples}/${global.sampleCount}`,
    `${t('idle')} ${formatPercent(idleShare)}`,
  ]
  const modeLabel = snapshot.mode === 'continuous' ? t('continuous') : snapshot.mode === 'paused' ? t('paused') : t('duty')
  const unattributedLow = snapshot.unattributedShare > DEFAULTS.unattributedWarnThreshold
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', fontSize: '12px' }}>
      <strong>{t('panel')}</strong>
      <span style={{ opacity: 0.8 }}>[{modeLabel}]</span>
      {items.map(item => <span key={item} style={{ opacity: 0.85 }}>{item}</span>)}
      <span style={{ opacity: 0.85 }}>
        {t('unattributed')} {formatPercent(snapshot.unattributedShare)}
        {unattributedLow ? ' ⚠' : ''}
      </span>
      <span style={{ opacity: 0.6 }}>{t('self')} {formatPercent(snapshot.selfShare)}</span>
    </div>
  )
}
