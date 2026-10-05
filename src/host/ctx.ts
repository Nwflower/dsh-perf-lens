// The harness host API surface this plugin consumes, declared structurally.
//
// The cordis Context carries effect/inject, but the loader and webServer
// services are contributed by harness packages that are not installable as type
// dependencies at the 0.1.7 baseline (see .npmrc). Declaring exactly the faces
// used here keeps the boundary explicit and testable; the runtime services come
// from the user's harness.

/** One plugin-inventory entry, as far as attribution needs. */
export interface LoaderEntryLike {
  readonly id: string
  readonly options: { readonly name: string }
  readonly parent: { readonly tree: { readonly ctx: { readonly baseUrl?: string | undefined } } }
  /**
   * The entry's cordis fiber. Used to attribute facts that carry no path — the
   * event listeners the plugin registered — to the same owner key attribution
   * derives from frame URLs. Absent for an entry that never activated.
   */
  readonly fiber?: unknown
}

/** Plugin inventory service. */
export interface LoaderFace {
  entries(): Iterable<LoaderEntryLike>
}

/** Route registration on the optional webServer service. */
export interface WebServerFace {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
  }): () => void
}

/** The cordis context as this host plugin uses it. */
export interface HostCtx {
  readonly loader: LoaderFace
  /** Install a side effect; the returned callback runs on unload. */
  effect(callback: () => (() => void) | void): void
  /** Run a callback once the named services become available. */
  inject(names: readonly string[], callback: (ctx: HostCtx) => void): void
}

/** The host context with the optional web service present. */
export interface HostWebCtx extends HostCtx {
  readonly webServer: WebServerFace
}
