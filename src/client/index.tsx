// dsh-perf-lens browser half.
//
// Registration follows the dsh 0.1.7 plugin panel (dsh-client-ui-plugin-manager):
// a sidebar.panellist row plus a keyed main panel sharing one id. Cross-plugin
// value imports are forbidden by the client bundle purity gate, so DSH packages
// are imported type-only here and React arrives through the injected require.

import { PANEL_ID } from '../shared/defaults'
import './styles/panel.css'
import type { ClientCtx } from './ctx'
import { DICT_EN, DICT_ZH, t } from './i18n'
import { PerfPanel } from './panel'
import { PerfSidebarEntry } from './sidebar-entry'
import { setActiveLocale } from './i18n'

/** Locale namespace reserved for this plugin's dictionary. */
export const NS = 'perf-lens'

// Services this client half needs before apply runs; package.json's
// dsh.client.inject list pins the load order of the packages providing them.
export const inject = ['slots', 'locale']

export function apply(ctx: ClientCtx): void {
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
