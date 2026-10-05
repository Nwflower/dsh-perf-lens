// dsh-perf-lens browser half.
//
// Registration follows the dsh 0.1.7 plugin panel (dsh-client-ui-plugin-manager):
// a sidebar.panellist row plus a keyed main panel sharing one id. Cross-plugin
// value imports are forbidden by the client bundle purity gate, so DSH packages
// are imported type-only here and React arrives through the injected require.

import { DEFAULTS, PANEL_ID } from '../shared/defaults'
import './styles/panel.css'
import { createPerfApi } from './api'
import type { ClientCtx } from './ctx'
import { DICT_EN, DICT_ZH, t } from './i18n'
import { PerfPanel } from './panel'
import { PerfSidebarEntry } from './sidebar-entry'
import { setActiveLocale } from './i18n'
import { installRememberedProbe, scheduleProbe } from './schedule-probe'
import { startVitalsReporter } from './vitals'

/** Locale namespace reserved for this plugin's dictionary. */
export const NS = 'perf-lens'

// Services this client half needs before apply runs; package.json's
// dsh.client.inject list pins the load order of the packages providing them.
export const inject = ['slots', 'locale']

export function apply(ctx: ClientCtx): void {
  // A remembered "on" installs the scheduler wrappers HERE, before the other
  // plugins' apply() bodies register their callbacks: the page reload that
  // follows the switch is what lets the probe see them at all.
  installRememberedProbe()
  // Bilingual dictionaries, registered through an effect so a stop or HMR
  // reload disposes them (the harness rejects a duplicate namespace/locale
  // pair, so a leaked registration would break the next reload). The panel
  // reads the active locale at call time; the subscription below pushes every
  // switch into the dictionary layer.
  const effect = ctx.effect ?? ((callback: () => unknown) => callback())
  effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'perf-lens: dictionaries')
  effect(() => {
    const sync = (): void => { setActiveLocale(ctx.locale.getSnapshot?.().active) }
    sync()
    return ctx.locale.subscribe?.(sync)
  }, 'perf-lens: locale sync')

  // Foreground vitals (long tasks, frame gaps, LoAF script entries) report
  // from the entry, not the panel: jank during ordinary chat use — panel
  // closed — is otherwise never observed, which is the failure mode this
  // plugin exists to answer. The reporter's own cost is one rAF tick plus two
  // observers that only fire on real work.
  const vitalsApi = createPerfApi()
  effect(() => startVitalsReporter({
    windowMs: DEFAULTS.vitalsWindowMs,
    // The scheduler probe is off until the panel's switch turns it on, so the
    // report carries no schedule field by default and the sample is byte-for-byte
    // what it was before this feature existed.
    schedule: windowMs => scheduleProbe.state.active ? scheduleProbe.takeReport(windowMs) : undefined,
    onReport: report => {
      // A dropped report is a missed window, not an error worth surfacing.
      void vitalsApi.postVitals(report).catch(() => {})
    },
  }), 'perf-lens: vitals reporter')

  // Left-nav entry: the id addresses the main panel registered under the same key.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    locale: NS,
    label: () => t('title'),
  }, PerfSidebarEntry))

  // Main-column board. v1 declares no child slots for other plugins.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
  }, PerfPanel))
}
