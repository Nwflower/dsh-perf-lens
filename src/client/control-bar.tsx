// The three sampling controls, as three blocks.
//
// They are separate because they are separate cost decisions: how hard the
// foreground sampler works (a segmented tier), whether a cheap record keeps
// running while it is stopped, and whether to pay for heap sampling. The
// combination, not any one switch, is the sampling logic — the host resolves it
// in shared/sampling.ts and reports the result back, so the panel renders what
// the host is actually doing rather than what it last asked for.
//
// Every label names what it acts on ("sampling"), because "high" or
// "background" alone does not say what is high or what runs in the background.

import type { SamplingConfig, SamplingIntensity } from '../shared/contract'
import { t } from './i18n'

/** The intensity tiers, in the order the segment shows them. */
const INTENSITIES: readonly SamplingIntensity[] = ['paused', 'low', 'high']

const INTENSITY_LABEL = { paused: 'stop', low: 'low', high: 'high' } as const
const INTENSITY_HINT = { paused: 'stopHint', low: 'lowHint', high: 'highHint' } as const

export interface ControlBarProps {
  readonly sampling: SamplingConfig
  readonly busy: boolean
  /**
   * The scheduler probe lives in the page, not in the host, so this switch is
   * deliberately NOT routed through /api-perf/control: flipping it installs or
   * removes wrappers in the tab that is doing the rendering.
   */
  readonly probeOn: boolean
  readonly onToggleProbe: () => void
  /**
   * The host did not report a config, so it predates these controls and does not
   * know the fields they send. The buttons are drawn (so the panel still shows
   * the state its mode implies) but disabled: a click that the host silently
   * ignores is worse than a click that is visibly unavailable.
   */
  readonly unsupported?: boolean
  readonly onIntensity: (intensity: SamplingIntensity) => void
  readonly onToggleBackground: () => void
  readonly onToggleMemory: () => void
}

export function ControlBar({
  sampling, busy, unsupported = false, probeOn, onIntensity, onToggleBackground, onToggleMemory, onToggleProbe,
}: ControlBarProps) {
  const cls = (on: boolean): string => on ? 'pl-seg-btn pl-seg-on' : 'pl-seg-btn'
  const off = busy || unsupported
  return (
    <>
      <div className="pl-seg" role="group" aria-label={t('intensityLabel')}>
        {INTENSITIES.map(level => (
          <button
            key={level}
            type="button"
            className={cls(sampling.intensity === level)}
            disabled={off}
            aria-pressed={sampling.intensity === level}
            onClick={() => { onIntensity(level) }}
            title={t(INTENSITY_HINT[level])}
          >
            {t(INTENSITY_LABEL[level])}
          </button>
        ))}
      </div>
      <span className="pl-controls-divider" aria-hidden="true" />
      <div className="pl-seg" role="group" aria-label={t('extrasLabel')}>
        <button
          type="button"
          className={cls(sampling.background)}
          disabled={off}
          aria-pressed={sampling.background}
          onClick={onToggleBackground}
          title={t('backgroundHint')}
        >
          {t('background')}
        </button>
        <button
          type="button"
          className={cls(sampling.memory)}
          disabled={off}
          aria-pressed={sampling.memory}
          onClick={onToggleMemory}
          title={t('memoryHint')}
        >
          {t('memory')}
        </button>
      </div>
      {sampling.memory && !unsupported ? <span className="pl-controls-hint">{t('memoryOn')}</span> : null}
      <span className="pl-controls-divider" aria-hidden="true" />
      <div className="pl-seg" role="group" aria-label={t('probeLabel')}>
        <button
          type="button"
          className={cls(probeOn)}
          aria-pressed={probeOn}
          onClick={onToggleProbe}
          title={t('probeHint')}
        >
          {t('probe')}
        </button>
      </div>
      {probeOn ? <span className="pl-controls-hint">{t('probeReload')}</span> : null}
    </>
  )
}