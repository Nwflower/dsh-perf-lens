// The three control blocks, and the one mode they add up to.
//
// The panel shows intensity (stop / low / high), background sampling and memory
// sampling as three independent controls, because they are three independent
// cost decisions. The sampling loop, however, can only run one profile at a
// time, so something has to resolve the combination — that is this module, and
// it is the only place that does it. Keeping it here (not in the Lens) is what
// makes "what does this combination actually run?" a unit test rather than an
// integration question.

import type { PerfControlRequest, SampleMode, SamplingConfig, SamplingIntensity } from './contract'

const INTENSITIES: readonly SamplingIntensity[] = ['paused', 'low', 'high']

/** The mode the sampling loop runs for a configuration. */
export function effectiveMode(config: SamplingConfig): SampleMode {
  if (config.intensity === 'high') return 'continuous'
  if (config.intensity === 'low') return 'duty'
  // Stopped. Background sampling is the whole reason its switch is separate from
  // the intensity segment: it is what keeps a cheap record going while nobody is
  // watching, which is exactly the case the intensity segment alone would make
  // "nothing at all".
  return config.background ? 'background' : 'paused'
}

/**
 * The configuration a persisted mode implies. Used for records written before
 * the config existed (history strips it) and for any snapshot that arrives
 * without one, so a rebuilt panel can still render its controls.
 */
export function configFromMode(mode: SampleMode, memory = false): SamplingConfig {
  switch (mode) {
    case 'continuous': return { intensity: 'high', background: false, memory }
    case 'background': return { intensity: 'paused', background: true, memory }
    case 'paused': return { intensity: 'paused', background: false, memory }
    default: return { intensity: 'low', background: false, memory }
  }
}

/**
 * The configuration a snapshot reports, falling back to what its mode implies.
 * Every consumer that reads controls off a snapshot goes through this, so an
 * older host (or a replayed record) cannot leave a control undefined.
 */
export function samplingOf(snapshot: { readonly mode: SampleMode; readonly sampling?: SamplingConfig }): SamplingConfig {
  return snapshot.sampling ?? configFromMode(snapshot.mode)
}

/** Whether a value off the wire is an intensity we accept. */
export function isSamplingIntensity(value: unknown): value is SamplingIntensity {
  return typeof value === 'string' && (INTENSITIES as readonly string[]).includes(value)
}

/**
 * Apply a control request to a configuration. Unknown or malformed fields are
 * ignored rather than rejected: the route serves one trusted client, and a
 * panel built against a newer contract must not be able to wedge the host by
 * sending a field it does not know yet.
 */
export function applyControl(config: SamplingConfig, body: PerfControlRequest): SamplingConfig {
  return {
    intensity: isSamplingIntensity(body.intensity) ? body.intensity : config.intensity,
    background: typeof body.background === 'boolean' ? body.background : config.background,
    memory: typeof body.memory === 'boolean' ? body.memory : config.memory,
  }
}