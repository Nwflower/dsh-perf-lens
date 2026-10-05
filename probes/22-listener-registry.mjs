// Probe 22: can per-plugin listener counts be read without patching anything?
//
// Roadmap item 3 needs a per-plugin listener count. Wrapping `ctx.on` would be a
// patch, and listeners are not async resources so async_hooks cannot see them.
// The remaining route is introspection: the cordis event service stores every
// listener as a record, and if that record carries the context that registered
// it, the owning fiber identifies the plugin exactly.
//
// This probe checks that against the real cordis, using the same classification
// the plugin's owner index uses (a fiber map built from loader entries), and
// prints what a panel would show.

import { Context } from '@deepseek-ai/cordis'

function countListeners (registry, ownerKeyOfFiber) {
  const hooks = registry?._hooks
  if (hooks === undefined || hooks === null) return null
  const counts = new Map()
  for (const key of Object.keys(hooks)) {
    const list = hooks[key]
    if (!Array.isArray(list)) continue
    for (const hook of list) {
      const owner = ownerKeyOfFiber(hook?.ctx?.fiber)
      if (owner === null) continue
      counts.set(owner, (counts.get(owner) ?? 0) + 1)
    }
  }
  return counts
}

const alpha = { name: 'dsh-alpha', apply (ctx) { ctx.on('session/event', () => {}); ctx.on('tool/execute', () => {}) } }
const beta = { name: 'dsh-beta', apply (ctx) { ctx.on('session/event', () => {}) } }

const root = new Context()
const fiberA = await root.plugin(alpha)
const fiberB = await root.plugin(beta)

const registry = root.events
const hooks = registry?._hooks
const first = hooks?.['session/event']?.[0]

// The production mapping: loader entry fiber -> the same owner key the path
// index produces for that plugin.
const owners = new Map([[fiberA, 'plugin:dsh-alpha'], [fiberB, 'plugin:dsh-beta']])
const counts = countListeners(registry, fiber => owners.get(fiber) ?? null)

console.log('--- probe 22: the cordis listener registry as an attribution source ---')
console.log(`root.events present          : ${registry !== undefined}`)
console.log(`registry exposes _hooks      : ${hooks !== undefined}`)
console.log(`event names in the registry  : ${hooks === undefined ? '-' : Object.keys(hooks).join(', ')}`)
console.log(`session/event hook count     : ${hooks?.['session/event']?.length}`)
console.log(`a hook carries ctx.fiber     : ${first?.ctx?.fiber !== undefined}`)
console.log(`each plugin has its own fiber: ${fiberA !== fiberB}`)
console.log(`fiber.name (display name)    : ${fiberA.name}`)
console.log(`attributed counts            : ${[...counts].map(([key, value]) => `${key}=${value}`).join(', ')}`)
console.log(`unmapped fibers are skipped  : ${countListeners(registry, () => null).size} owners`)