// Sampling controls as one segmented group. Every toggle takes effect
// immediately on the host. Two of them raise cost: continuous sampling (bounded
// host-side by continuousMaxMs) and deep sampling (adds heap sampling). Each
// label names what it acts on ("sampling") and its hint says what a second
// click does, because "continuous" alone does not say what continues.

import type { SampleMode } from '../shared/contract'
import { t } from './i18n'

export interface ControlBarProps {
  readonly mode: SampleMode
  readonly deep: boolean
  readonly busy: boolean
  readonly onPause: () => void
  readonly onResume: () => void
  readonly onToggleContinuous: () => void
  readonly onToggleBackground: () => void
  readonly onToggleDeep: () => void
}

export function ControlBar({ mode, deep, busy, onPause, onResume, onToggleContinuous, onToggleBackground, onToggleDeep }: ControlBarProps) {
  const cls = (on: boolean): string => on ? 'pl-seg-btn pl-seg-on' : 'pl-seg-btn'
  return (
    <>
      <div className="pl-seg" role="group" aria-label={t('modeLabel')}>
        <button
          type="button"
          className={cls(mode === 'paused')}
          disabled={busy}
          onClick={mode === 'paused' ? onResume : onPause}
          title={mode === 'paused' ? t('resumeHint') : t('pauseHint')}
        >
          {mode === 'paused' ? t('resume') : t('pause')}
        </button>
        <button
          type="button"
          className={cls(mode === 'continuous')}
          disabled={busy}
          onClick={onToggleContinuous}
          title={t('continuousHint')}
        >
          {t('continuous')}
        </button>
        <button
          type="button"
          className={cls(mode === 'background')}
          disabled={busy}
          onClick={onToggleBackground}
          title={t('backgroundHint')}
        >
          {t('background')}
        </button>
        <button type="button" className={cls(deep)} disabled={busy} onClick={onToggleDeep} title={t('deepHint')}>
          {t('deep')}
        </button>
      </div>
      {deep ? <span className="pl-controls-hint">{t('deepOn')}</span> : null}
    </>
  )
}
