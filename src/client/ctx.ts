// The harness client API surface this plugin consumes, declared structurally.
//
// The harness's client Context augmentation is not available as an installable
// type package at the 0.1.7 baseline (see .npmrc), and dsh-context takes the same
// approach: declare exactly the faces used here rather than depend on the whole
// client type graph. The runtime services come from the user's harness; these
// interfaces are erased at build time. Shapes transcribed from
// @deepseek-ai/dsh-client-ui-slots / -sidebar / -layout 0.1.7-alpha.1.

/** One slot registration's definition. List slots dispatch on id + order, keyed slots on key. */
export interface SlotRegistration {
  readonly name: string
  /** List-slot identity; the matching main panel is keyed by the same value. */
  readonly id?: string
  readonly order?: number
  /** Keyed-slot identity. */
  readonly key?: string
  /** Locale namespace; the framework then synthesizes the `t` prop seat. */
  readonly locale?: string
  /** Row title, resolved lazily so a language change needs no re-registration. */
  readonly label?: () => string
}

/** Client slot registry service. */
export interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(registration: SlotRegistration, component: unknown): unknown
}

/** Client locale service. */
export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
}

/** Client layout service; `selectPanel` opens a keyed main panel by id. */
export interface LayoutService {
  readonly activePanelId: string | null
  selectPanel(panelId: string): void
}

/** The cordis context as the browser half sees it. */
export interface ClientCtx {
  readonly slots: SlotsService
  readonly locale: LocaleService
  readonly layout: LayoutService
}
