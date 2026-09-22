// Per-plugin hot functions: the leaf frames a plugin actually spent CPU in.
//
// HARD CONSTRAINT (docs/design.md §7): these are frame-level facts and must
// NEVER be persisted. They live in memory, are refreshed only while deep mode
// is on, and are dropped the moment it is off. The history log only ever sees
// aggregated snapshots.
//
// This is not a new measurement mechanism: the V8 CPU profile already carries
// functionName / url / lineNumber on every node. Attribution used to throw them
// away once it had resolved an owner; this keeps them.

import type { Hotspot } from '../shared/contract'
import {
  attributeNode,
  buildNodeMap,
  buildParentMap,
  type OwnerIndex,
  type ProfileNode,
} from './attribute'

export type { Hotspot }

/** Cap on rows kept per plugin; the long tail is noise in a panel. */
export const HOTSPOT_LIMIT = 20

/**
 * Group sampled leaf frames by plugin and function, keeping the top
 * `limit` by self time per plugin. Owners are resolved once per node, exactly
 * like tallySamples, because the ancestor walk dominates the cost.
 */
export function aggregateHotspots(
  samples: readonly number[],
  nodes: readonly ProfileNode[],
  index: OwnerIndex,
  intervalMs: number,
  limit: number = HOTSPOT_LIMIT,
): Map<string, Hotspot[]> {
  const nodesById = buildNodeMap(nodes)
  const parentOf = buildParentMap(nodes)
  const ownerOfNode = new Map<number, string | null>()
  const counts = new Map<string, Map<string, { frame: ProfileNode['callFrame']; samples: number }>>()
  for (const nodeId of samples) {
    let ownerKey = ownerOfNode.get(nodeId)
    if (ownerKey === undefined) {
      const owner = attributeNode(nodeId, nodesById, parentOf, index)
      ownerKey = owner.kind === 'plugin' ? `plugin:${owner.name}` : null
      ownerOfNode.set(nodeId, ownerKey)
    }
    if (ownerKey === null) continue
    const node = nodesById.get(nodeId)
    if (node === undefined) continue
    const frame = node.callFrame
    const functionName = frame.functionName === undefined || frame.functionName === '' ? '(anonymous)' : frame.functionName
    const url = frame.url ?? ''
    const lineNumber = frame.lineNumber ?? 0
    const functionKey = `${functionName}\u0000${url}\u0000${lineNumber}`
    let perFunction = counts.get(ownerKey)
    if (perFunction === undefined) {
      perFunction = new Map()
      counts.set(ownerKey, perFunction)
    }
    const existing = perFunction.get(functionKey)
    if (existing === undefined) perFunction.set(functionKey, { frame, samples: 1 })
    else existing.samples += 1
  }
  const result = new Map<string, Hotspot[]>()
  for (const [ownerKey, perFunction] of counts) {
    const rows: Hotspot[] = []
    for (const entry of perFunction.values()) {
      rows.push({
        functionName: entry.frame.functionName === undefined || entry.frame.functionName === ''
          ? '(anonymous)'
          : entry.frame.functionName,
        url: entry.frame.url ?? '',
        lineNumber: entry.frame.lineNumber ?? 0,
        samples: entry.samples,
        selfMs: entry.samples * intervalMs,
      })
    }
    rows.sort((a, b) => b.selfMs - a.selfMs)
    result.set(ownerKey, rows.slice(0, limit))
  }
  return result
}

/**
 * In-memory hotspot table keyed by `plugin:<name>`. There is deliberately no
 * persistence path and no serializer: nothing here may reach the JSONL log.
 */
export class HotspotStore {
  #byOwner = new Map<string, readonly Hotspot[]>()

  /** Replace the whole table with one deep window's result. */
  replace(table: ReadonlyMap<string, readonly Hotspot[]>): void {
    this.#byOwner = new Map(table)
  }

  /** Hotspots for a module name, or null when none were collected. */
  get(moduleName: string): readonly Hotspot[] | null {
    return this.#byOwner.get(`plugin:${moduleName}`) ?? null
  }

  clear(): void {
    this.#byOwner.clear()
  }
}
