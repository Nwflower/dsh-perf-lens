// Ancestor-walk attribution for sampled call trees.
//
// Hard constraint (docs/evidence.md evidence 5): a sample is attributed to the
// nearest PLUGIN frame on its ancestor stack, never to the file a frame is
// defined in. Direct self-frame attribution drops almost every sample of a
// plugin that calls a shared dependency into an unattributable bucket, which
// makes the panel point at the wrong plugin.

/** How a single frame's URL resolves against the owner index. */
export type FrameOwner =
  | { readonly kind: 'plugin'; readonly name: string }
  | { readonly kind: 'harness'; readonly name: string }
  | { readonly kind: 'self'; readonly name: string }
  | { readonly kind: 'runtime' }
  /**
   * Wall time the profiler sampled while the thread was idle. Kept separate
   * from runtime: counting it as runtime made an idle host look like ~90%
   * runtime cost, which is the opposite of the question the panel answers.
   */
  | { readonly kind: 'idle' }
  | { readonly kind: 'unattributed' }

/** One longest-prefix rule mapping an absolute path prefix to an owner. */
export interface OwnerRule {
  readonly kind: 'plugin' | 'harness' | 'self'
  readonly name: string
  /** Absolute directory prefix, forward-slash normalized. */
  readonly prefix: string
}

/** Rules sorted longest-prefix-first; build with createOwnerIndex. */
export interface OwnerIndex {
  readonly rules: readonly OwnerRule[]
}

/** The parts of a call frame attribution reads. */
export interface FrameLike {
  readonly url?: string | undefined
  readonly functionName?: string | undefined
}

/** One node of a CPU profile or heap-sampling tree, as far as attribution needs. */
export interface ProfileNode {
  readonly id: number
  readonly callFrame: FrameLike
  readonly children?: readonly number[] | undefined
}

/** Stable key for tallying an owner in maps and logs. */
export function ownerKey(owner: FrameOwner): string {
  switch (owner.kind) {
    case 'plugin': return `plugin:${owner.name}`
    case 'harness': return `harness:${owner.name}`
    case 'self': return 'self'
    case 'runtime': return 'runtime'
    case 'idle': return 'idle'
    case 'unattributed': return 'unattributed'
  }
}

/** Normalize a path or file URL for prefix comparison. */
export function normalizePath(value: string): string {
  const stripped = value.replace(/^file:\/\//, '').replace(/\\/g, '/')
  // V8 frame URLs carry a leading slash before a Windows drive (`/D:/x`), while
  // loader base paths often do not (`D:/x`). Canonicalize both to `/D:/x`, or
  // every prefix comparison on Windows silently misses.
  return /^[A-Za-z]:\//.test(stripped) ? `/${stripped}` : stripped
}

/** Sort rules longest-prefix-first so the most specific owner wins. */
export function createOwnerIndex(rules: readonly OwnerRule[]): OwnerIndex {
  return { rules: [...rules].sort((a, b) => b.prefix.length - a.prefix.length) }
}

// Frame URLs that are never plugin code: Node internals, native frames, and the
// synthetic roots the V8 profiler emits.
const RUNTIME_URL = /^(?:node:|internal\/|native|\(root\)|\(program\)|\(idle\)|\(anonymous\)|\()/

/** Classify one call frame against the owner index. */
export function classifyFrame(frame: FrameLike, index: OwnerIndex): FrameOwner {
  // The V8 profiler's idle node has an empty URL; its function name is the only
  // marker that distinguishes it from real native work.
  if (frame.functionName === '(idle)') return { kind: 'idle' }
  const url = frame.url
  if (url === undefined || url === '' || RUNTIME_URL.test(url)) return { kind: 'runtime' }
  const normalized = normalizePath(url)
  for (const rule of index.rules) {
    if (normalized.startsWith(rule.prefix)) return { kind: rule.kind, name: rule.name }
  }
  return { kind: 'unattributed' }
}

/** Classify one frame URL (no function name available, e.g. a captured stack). */
export function classifyFrameUrl(url: string | undefined, index: OwnerIndex): FrameOwner {
  return classifyFrame({ url }, index)
}

/** Index nodes by id for O(1) lookup during the walk. */
export function buildNodeMap(nodes: readonly ProfileNode[]): Map<number, ProfileNode> {
  return new Map(nodes.map(node => [node.id, node]))
}

/** Reverse the children links into a parent pointer per node. */
export function buildParentMap(nodes: readonly ProfileNode[]): Map<number, number> {
  const parentOf = new Map<number, number>()
  for (const node of nodes) {
    for (const child of node.children ?? []) parentOf.set(child, node.id)
  }
  return parentOf
}

/**
 * Walk from a sampled node up its ancestor stack to the nearest owner.
 *
 * A plugin or self frame anywhere above the sample wins outright. When no such
 * frame exists, a harness frame is preferred over a runtime frame: a harness
 * helper calling into node:fs is harness cost, not runtime cost. Only a stack
 * with neither resolves to unattributed.
 */
/** Options shared by every frame-list walk. */
export interface AttributeOptions {
  /**
   * Skip this plugin's own frames instead of returning them. Async-resource
   * attribution needs this: the captured stack always starts inside this
   * plugin's own hook, and returning `self` there would hide the real caller.
   */
  readonly skipSelf?: boolean
}

/**
 * Attribute a leaf-first list of frame URLs to the nearest owner.
 *
 * A plugin (or self, unless skipped) frame wins outright. Otherwise a harness
 * frame is preferred over a runtime frame, and a stack with neither is
 * unattributed.
 */
export function attributeFrameList(
  urls: readonly (string | undefined)[],
  index: OwnerIndex,
  options: AttributeOptions = {},
): FrameOwner {
  return attributeFrames(urls.map(url => ({ url })), index, options)
}

/**
 * Attribute a leaf-first list of call frames to the nearest owner.
 *
 * A plugin (or self, unless skipped) frame wins outright. Otherwise a harness
 * frame is preferred; then idle outranks runtime, because an idle leaf's only
 * other frame is the structural root and must not turn idle time into cost.
 */
export function attributeFrames(
  frames: readonly FrameLike[],
  index: OwnerIndex,
  options: AttributeOptions = {},
): FrameOwner {
  let weakHarness: FrameOwner | null = null
  let weakIdle: FrameOwner | null = null
  let weakRuntime: FrameOwner | null = null
  for (const frame of frames) {
    const owner = classifyFrame(frame, index)
    if (owner.kind === 'self') {
      if (options.skipSelf === true) continue
      return owner
    }
    if (owner.kind === 'plugin') return owner
    if (owner.kind === 'harness' && weakHarness === null) weakHarness = owner
    if (owner.kind === 'idle' && weakIdle === null) weakIdle = owner
    if (owner.kind === 'runtime' && weakRuntime === null) weakRuntime = owner
  }
  return weakHarness ?? weakIdle ?? weakRuntime ?? { kind: 'unattributed' }
}

/** Extract frame URLs from a V8 stack string, innermost first. */
export function frameUrlsOfStack(stack: string): string[] {
  const urls: string[] = []
  for (const line of stack.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('at ')) continue
    const url = frameUrlOfStackLine(trimmed)
    if (url !== undefined) urls.push(url)
  }
  return urls
}

/** Pull the script URL out of one `at ...` stack line. */
export function frameUrlOfStackLine(line: string): string | undefined {
  const withoutPosition = line.replace(/:(\d+):(\d+)\)?$/, '')
  const openParen = withoutPosition.lastIndexOf('(')
  const candidate = openParen === -1 ? withoutPosition.slice(3) : withoutPosition.slice(openParen + 1)
  const trimmed = candidate.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Walk from a sampled node up its ancestor stack to the nearest owner.
 *
 * A plugin or self frame anywhere above the sample wins outright. When no such
 * frame exists, a harness frame is preferred over a runtime frame: a harness
 * helper calling into node:fs is harness cost, not runtime cost. Only a stack
 * with neither resolves to unattributed.
 */
export function attributeNode(
  nodeId: number,
  nodes: ReadonlyMap<number, ProfileNode>,
  parentOf: ReadonlyMap<number, number>,
  index: OwnerIndex,
  options: AttributeOptions = {},
): FrameOwner {
  const frames: FrameLike[] = []
  let current: number | undefined = nodeId
  while (current !== undefined) {
    const node = nodes.get(current)
    if (node === undefined) break
    frames.push(node.callFrame)
    current = parentOf.get(current)
  }
  return attributeFrames(frames, index, options)
}

/** Attribute a whole sample list and count samples per owner key. */
export function tallySamples(
  samples: readonly number[],
  nodes: readonly ProfileNode[],
  index: OwnerIndex,
): Map<string, number> {
  const nodesById = buildNodeMap(nodes)
  const parentOf = buildParentMap(nodes)
  // A profile has far fewer distinct nodes than samples, so resolve each node's
  // owner once and reuse it. The walk is the expensive part, not the counting.
  const ownerOfNode = new Map<number, string>()
  const counts = new Map<string, number>()
  for (const nodeId of samples) {
    let key = ownerOfNode.get(nodeId)
    if (key === undefined) {
      key = ownerKey(attributeNode(nodeId, nodesById, parentOf, index))
      ownerOfNode.set(nodeId, key)
    }
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}
