// dsh-perf-lens browser half.
//
// Registration follows the dsh 0.1.7 plugin panel (dsh-client-ui-plugin-manager):
// a sidebar.panellist row plus a keyed main panel sharing one id. Cross-plugin
// value imports are forbidden by the client bundle purity gate, so DSH packages
// are imported type-only here and React arrives through the injected require.

import { PANEL_ID } from '../shared/defaults'
import type { ClientCtx } from './ctx'
import { PerfPanel } from './panel'
import { PerfSidebarEntry } from './sidebar-entry'

/** Locale namespace reserved for this plugin's dictionary. */
export const NS = 'perf-lens'

// Services this client half needs before apply runs; package.json's
// dsh.client.inject list pins the load order of the packages providing them.
// `locale` joins this list once a dictionary is registered with ctx.locale.
export const inject = ['slots']

export function apply(ctx: ClientCtx): void {
  // Left-nav entry: the id addresses the main panel registered under the same key.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    label: () => 'Perf Lens',
  }, PerfSidebarEntry))

  // Main-column board. v1 declares no child slots for other plugins.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, PerfPanel))
}
