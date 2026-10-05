// Build the owner index from the harness plugin inventory.
//
// ctx.loader.entries() is the source (the harness's own plugin-inventory plugin
// uses the same call): each entry yields a module name and the path its package
// resolves against. This module keeps the mapping pure — the caller supplies the
// resolved facts, so the classifier can be unit-tested without a cordis context.

import { createOwnerIndex, normalizePath, ownerKey, type OwnerIndex, type OwnerRule } from './attribute'

/** The three owner kinds a module name can resolve to. */
export interface ModuleOwner {
  readonly kind: 'plugin' | 'harness' | 'self'
  readonly name: string
}

/** The subset of a loader entry attribution needs. */
export interface LoaderEntryFacts {
  readonly moduleName: string
  readonly entryId: string
  /** Resolved base path of the entry (package directory or module file). */
  readonly baseUrl: string
  /**
   * The entry's cordis fiber, when the loader exposes one.
   *
   * Carried so per-fiber facts that are NOT path-based — registered event
   * listeners, which the event service stores with the context that registered
   * them — can be attributed to the same owner key the path index produces.
   */
  readonly fiber?: unknown
}

export interface BuildOwnerIndexOptions {
  /** This plugin's own package name; its frames are excluded from attribution. */
  readonly selfPackageName?: string
  /**
   * Directory containing the harness's own @deepseek-ai packages. Core packages
   * are nested under the running dsh install, which is not the profile anchor, so
   * resolving them by name can land on a different install; this prefix catches
   * every core frame wherever the running host actually lives.
   */
  readonly harnessPrefix?: string
}

/** Core harness packages fold into a single "harness" row. */
const HARNESS_PACKAGE = /^@deepseek-ai\/dsh(?:-|$)/

/**
 * The owner a plugin's module name belongs to.
 *
 * Path-based attribution and fiber-based attribution (event listeners) must
 * agree, so both go through this one function: a module is this plugin, a
 * harness internal package, or a third-party plugin.
 */
export function ownerOfModule(moduleName: string, selfPackageName = 'dsh-perf-lens'): ModuleOwner {
  if (moduleName === selfPackageName) return { kind: 'self', name: moduleName }
  if (HARNESS_PACKAGE.test(moduleName)) return { kind: 'harness', name: moduleName }
  return { kind: 'plugin', name: moduleName }
}

/** The tally key for a module name, matching what frame attribution produces. */
export function ownerKeyOfModule(moduleName: string, selfPackageName = 'dsh-perf-lens'): string {
  return ownerKey(ownerOfModule(moduleName, selfPackageName))
}

/**
 * Map each loader entry's fiber to its owner key.
 *
 * Used for facts that carry no path: the cordis event service stores every
 * listener with the context that registered it, so identity comes from the
 * fiber rather than from a call stack.
 */
export function fiberOwnerKeys(
  entries: readonly LoaderEntryFacts[],
  selfPackageName = 'dsh-perf-lens',
): Map<unknown, string> {
  const out = new Map<unknown, string>()
  for (const entry of entries) {
    if (entry.fiber === undefined || entry.fiber === null) continue
    out.set(entry.fiber, ownerKeyOfModule(entry.moduleName, selfPackageName))
  }
  return out
}

/**
 * The harness's own @deepseek-ai directory, derived from the running entry file
 * (e.g. `…/node_modules/@deepseek-ai/dsh/lib/bin.js`). Returns undefined when the
 * path does not sit under a node_modules/@deepseek-ai tree.
 */
export function harnessNodeModulesPrefix(entryPath: string | undefined): string | undefined {
  if (entryPath === undefined || entryPath === '') return undefined
  const normalized = normalizePath(entryPath)
  const marker = '/node_modules/@deepseek-ai/'
  const index = normalized.indexOf(marker)
  return index === -1 ? undefined : normalized.slice(0, index + marker.length)
}

/**
 * Directory prefix of a resolved base path. Accepts either a directory or a
 * module file: a trailing segment with an extension is dropped.
 */
export function directoryPrefixOf(baseUrl: string): string {
  const normalized = normalizePath(baseUrl)
  const lastSlash = normalized.lastIndexOf('/')
  const tail = normalized.slice(lastSlash + 1)
  if (tail.includes('.')) return normalized.slice(0, lastSlash + 1)
  return normalized.endsWith('/') ? normalized : `${normalized}/`
}

/** Turn loader entry facts into a longest-prefix owner index. */
export function buildOwnerIndex(
  entries: readonly LoaderEntryFacts[],
  options: BuildOwnerIndexOptions = {},
): OwnerIndex {
  const selfPackageName = options.selfPackageName ?? 'dsh-perf-lens'
  const rules: OwnerRule[] = []
  for (const entry of entries) {
    // An unresolved base path collapses to the prefix '/', which matches every
    // absolute frame and hands all samples to whichever rule sorts first. Skip
    // it instead: unattributable is honest, misattributed is not.
    if (entry.baseUrl === '') continue
    const prefix = directoryPrefixOf(entry.baseUrl)
    const owner = ownerOfModule(entry.moduleName, selfPackageName)
    rules.push({ kind: owner.kind, name: owner.name, prefix })
  }
  if (options.harnessPrefix !== undefined && options.harnessPrefix !== '') {
    rules.push({ kind: 'harness', name: '@deepseek-ai/dsh', prefix: options.harnessPrefix })
  }
  return createOwnerIndex(rules)
}
