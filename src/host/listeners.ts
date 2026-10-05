// Per-plugin event-listener counts (roadmap item 3, listener half).
//
// "Which plugin registered two thousand listeners and never removed them" is
// the one question the board could not answer. Listeners are not async
// resources, so async_hooks cannot see them; but they do not need a hook
// either. The cordis event service stores every listener as a record carrying
// the context that registered it, and that context's fiber identifies the
// plugin — so the count is exact and read-only, with no wrapping of `ctx.on`,
// no prototype patching, and no change to a listener's identity, `this` binding
// or dispatch order.
//
// The timers and handles half of item 3 was dropped after measurement: the only
// mechanism is async_hooks, and an always-on hook costs +123% on promise-heavy
// work while a stack capture per timer costs two orders of magnitude more
// (docs/evidence.md, evidence 15). A gauge that is only true during a sampling
// window would be worse than no gauge, so those columns are reported as "not
// measured" instead.

/** One stored listener record, as far as listener counting needs it. */
export interface HookLike {
  readonly ctx?: { readonly fiber?: unknown } | undefined
}

/** The cordis event service's registry, read read-only. */
export interface EventsRegistryFace {
  readonly _hooks?: Record<string, readonly HookLike[]> | undefined
}

/**
 * Count registered event listeners per owner key.
 *
 * Returns null when the registry cannot be read at all (a cordis version that
 * renamed the field), so the caller reports "not measured" rather than zero —
 * a false zero would read as "this plugin registers nothing".
 */
export function countListeners(
  events: EventsRegistryFace | undefined,
  ownerKeyOfFiber: (fiber: unknown) => string | null,
): Map<string, number> | null {
  const hooks = events?._hooks
  if (hooks === undefined || hooks === null) return null
  const counts = new Map<string, number>()
  try {
    for (const key of Object.keys(hooks)) {
      const list = hooks[key]
      if (!Array.isArray(list)) continue
      for (const hook of list) {
        const owner = ownerKeyOfFiber(hook?.ctx?.fiber)
        if (owner === null) continue
        counts.set(owner, (counts.get(owner) ?? 0) + 1)
      }
    }
  } catch {
    return null
  }
  return counts
}