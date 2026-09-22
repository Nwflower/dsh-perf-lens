// Sampling controls. Every toggle takes effect immediately on the host; the
// continuous toggle is the only one that raises overhead, and it is bounded
// host-side by continuousMaxMs.

import type { SampleMode } from '../shared/contract'
import { t } from './i18n'

export interface ControlBarProps {
  readonly mode: SampleMode
  readonly deep: boolean
  readonly busy: boolean
  readonly onPause: () => void
  readonly onResume: () => void
  readonly onToggleContinuous: () => void
  readonly onToggleDeep: () => void
}

export function ControlBar({ mode, deep, busy, onPause, onResume, onToggleContinuous, onToggleDeep }: ControlBarProps) {
  const button: React.CSSProperties = {
    padding: '3px 10px',
    fontSize: '12px',
    borderRadius: '6px',
    border: '1px solid var(--dsw-color-border, rgba(127,127,127,0.35))',
    background: 'transparent',
    color: 'inherit',
    cursor: busy ? 'progress' : 'pointer',
  }
  const active: React.CSSProperties = { ...button, borderColor: 'var(--dsw-color-accent, #4c8dff)', fontWeight: 600 }
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px' }}>
      <button
        type="button"
        style={mode === 'paused' ? active : button}
        disabled={busy}
        onClick={mode === 'paused' ? onResume : onPause}
      >
        {mode === 'paused' ? t('resume') : t('pause')}
      </button>
      <button
        type="button"
        style={mode === 'continuous' ? active : button}
        disabled={busy}
        onClick={onToggleContinuous}
      >
        {t('continuous')}
      </button>
      <button type="button" style={deep ? active : button} disabled={busy} onClick={onToggleDeep}>
        {t('deep')}
      </button>
      {deep ? <span style={{ opacity: 0.7 }}>{t('deepOn')}</span> : null}
    </div>
  )
}
