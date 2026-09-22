// Build the owner index from the harness plugin inventory.
//
// ctx.loader.entries() is the source (the harness's own plugin-inventory plugin
// uses the same call): each entry yields a module name and the path its package
// resolves against. This module keeps the mapping pure — the caller supplies the
// resolved facts, so the classifier can be unit-tested without a cordis context.

import { createOwnerIndex, normalizePath, type OwnerIndex, type OwnerRule } from './attribute'

/** The subset of a loader entry attribution needs. */
export interface LoaderEntryFacts {
  readonly moduleName: string
  readonly entryId: string
  /** Resolved base path of the entry (package directory or module file). */
  readonly baseUrl: string
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
    if (entry.moduleName === selfPackageName) {
      rules.push({ kind: 'self', name: entry.moduleName, prefix })
    } else if (HARNESS_PACKAGE.test(entry.moduleName)) {
      rules.push({ kind: 'harness', name: entry.moduleName, prefix })
    } else {
      rules.push({ kind: 'plugin', name: entry.moduleName, prefix })
    }
  }
  if (options.harnessPrefix !== undefined && options.harnessPrefix !== '') {
    rules.push({ kind: 'harness', name: '@deepseek-ai/dsh', prefix: options.harnessPrefix })
  }
  return createOwnerIndex(rules)
}
