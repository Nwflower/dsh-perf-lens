// Locks WHERE harness cost can legitimately come from, using the real owner
// index and the real ancestor walk against a realistic install layout.
//
// Motivation: on a live host the `harness` row dominates the board. That is
// partly real (the harness IS 200+ packages doing the agent loop, session
// persistence and tool dispatch) and partly an artefact of two presentation
// choices: every `harness:<pkg>` key is folded into one row, and `harness`
// outranks `runtime` whenever a harness frame is anywhere on the stack.
//
// These tests pin the mechanisms so the diagnosis of a big harness row can be
// done from the code rather than from guesswork. Each `console.log` line is a
// diagnosis aid; the assertions are the contract.

import { describe, expect, test } from 'vitest'
import { attributeFrames, ownerKey, tallySamples, type ProfileNode } from '../src/host/attribute'
import { collapseOwnerCounts } from '../src/host/lens'
import { buildOwnerIndex, harnessNodeModulesPrefix, type LoaderEntryFacts } from '../src/host/plugin-index'

const NPM = 'C:/Users/me/AppData/Roaming/npm'
const HOME = 'C:/Users/me/.dsh'

/** The layout a real install produces: harness core, external plugin, plugin dep. */
const ENTRIES: LoaderEntryFacts[] = [
  { moduleName: '@deepseek-ai/dsh-agent-loop', entryId: 'a1', baseUrl: `${NPM}/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` },
  { moduleName: '@deepseek-ai/dsh-fs-local', entryId: 'a2', baseUrl: `${NPM}/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js` },
  { moduleName: '@deepseek-ai/dsh-session-persistence-jsonl', entryId: 'a3', baseUrl: `${NPM}/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` },
  { moduleName: 'dsh-chat-import', entryId: 'p1', baseUrl: `${HOME}/dsh-chat-import/lib/index.mjs` },
  { moduleName: 'dsh-perf-lens', entryId: 'p2', baseUrl: `${HOME}/dsh-perf-lens/lib/index.js` },
]

const HARNESS_PREFIX = harnessNodeModulesPrefix(`${NPM}/node_modules/@deepseek-ai/dsh/lib/bin.js`)
const INDEX = buildOwnerIndex(ENTRIES, { harnessPrefix: HARNESS_PREFIX })

/**
 * Owner key for a leaf-first stack, i.e. what the board would charge.
 *
 * The V8 profiler marks synthetic frames with a bracketed name and an empty
 * URL, so `(garbage collector)` arrives as `functionName` with `url` undefined,
 * never as a URL. Pass such markers through the functionName field.
 */
function ownerOf(...urls: string[]): string {
  return ownerKey(
    attributeFrames(
      urls.map((url) => (url.startsWith('(') ? { functionName: url } : { url, functionName: 'f' })),
      INDEX,
    ),
  )
}

const AGENT_LOOP = `${NPM}/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`
const FS_LOCAL = `${NPM}/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js`
const SESSION_LOG = `${NPM}/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`
const CHAT_IMPORT = `${HOME}/dsh-chat-import/lib/index.mjs`
const FZSTD = `${HOME}/node_modules/fzstd/esm/index.mjs`

describe('the harness prefix stays inside @deepseek-ai', () => {
  test('it is the @deepseek-ai directory of the running install', () => {
    // normalizePath canonicalizes a Windows drive to a leading slash, and every
    // frame URL goes through the same normalization, so the comparison is sound.
    expect(HARNESS_PREFIX).toBe(`/${NPM}/node_modules/@deepseek-ai/`)
  })

  test('an external plugin is never swallowed by it', () => {
    expect(ownerOf(CHAT_IMPORT)).toBe('plugin:dsh-chat-import')
  })

  test('this plugin attributes itself, not the harness', () => {
    expect(ownerOf(`${HOME}/dsh-perf-lens/lib/index.js`)).toBe('self')
  })

  test('a plugin dependency with no owner above it falls to the runtime leaf', () => {
    // Note the ordering: a runtime frame outranks "unattributed", so a
    // dependency-only stack is charged to runtime:node, not to a plugin.
    expect(ownerOf(FZSTD, 'node:zlib')).toBe('runtime:node')
    // With no runtime frame at all, it is genuinely unattributed.
    expect(ownerOf(FZSTD)).toBe('unattributed')
  })
})

describe('the mechanisms that put cost on the harness row', () => {
  test('A. harness doing its own work — genuinely harness', () => {
    expect(ownerOf(SESSION_LOG, 'node:internal/fs/promises', 'native')).toBe(
      'harness:@deepseek-ai/dsh-session-persistence-jsonl',
    )
  })

  test('B. harness frame ABOVE a plugin frame — plugin wins, already correct', () => {
    expect(ownerOf(CHAT_IMPORT, FS_LOCAL, 'node:fs')).toBe('plugin:dsh-chat-import')
  })

  test('C. plugin frame gone from the stack — deferred dependency work becomes harness', () => {
    // The plugin scheduled work through the harness; when it finally runs, the
    // harness callback is the only owner left on the stack. This is the one
    // mechanism that can inflate the harness row with other people's work.
    expect(ownerOf(FZSTD, AGENT_LOOP, 'node:internal/timers')).toBe('harness:@deepseek-ai/dsh-agent-loop')
  })

  test('D. harness outranks runtime even when runtime is the leaf', () => {
    // A harness helper calling into node:fs is charged to the harness, not to
    // runtime. Intentional, and it is why "runtime" is not the bigger bucket.
    expect(ownerOf('native', 'node:fs', FS_LOCAL)).toBe('harness:@deepseek-ai/dsh-fs-local')
  })

  test('E. GC with no owner on the stack stays runtime:gc', () => {
    expect(ownerOf('(garbage collector)')).toBe('runtime:gc')
  })
})

describe('the fold hides the ranking that would explain the harness row', () => {
  test('collapseOwnerCounts merges every harness package into one key', () => {
    const raw = new Map([
      ['harness:@deepseek-ai/dsh-agent-loop', 3],
      ['harness:@deepseek-ai/dsh-llm-deepseek', 2],
      ['harness:@deepseek-ai/dsh-session-persistence-jsonl', 5],
      ['plugin:dsh-chat-import', 1],
    ])
    const folded = collapseOwnerCounts(raw)
    expect([...folded.keys()].sort()).toEqual(['harness', 'plugin:dsh-chat-import'])
    expect(folded.get('harness')).toBe(10)
    // The per-package ranking exists in the raw tally and is what a diagnosis
    // needs; it is dropped before the board is built.
    expect([...raw].sort((a, b) => b[1] - a[1])[0]?.[0]).toBe('harness:@deepseek-ai/dsh-session-persistence-jsonl')
  })

  test('a realistic mix shows the harness share the fold produces', () => {
    // One sample per stack. Deliberately includes mechanism C twice, because on
    // a live host deferred work is common.
    const stacks: string[][] = [
      [AGENT_LOOP, 'native'],
      [AGENT_LOOP, 'node:internal/streams/readable'],
      [`${NPM}/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`, 'native'],
      [SESSION_LOG, 'node:fs'],
      [SESSION_LOG, 'node:fs'],
      [`${NPM}/node_modules/@deepseek-ai/dsh-tool-pwsh/lib/index.js`, 'node:child_process'],
      [CHAT_IMPORT, 'native'],
      [FZSTD, AGENT_LOOP, 'node:internal/timers'],
      [FZSTD, AGENT_LOOP, 'node:internal/timers'],
      ['(garbage collector)'],
      ['(idle)'],
    ]
    const nodes: ProfileNode[] = stacks.map((urls, i) => {
      const leaf = urls[0] ?? ''
      return {
        id: i,
        // Synthetic profiler markers arrive as a bracketed functionName, not a URL.
        callFrame: leaf.startsWith('(') ? { functionName: leaf } : { url: leaf },
        children: [],
      }
    })
    const raw = tallySamples(stacks.map((_, i) => i), nodes, INDEX)
    const folded = collapseOwnerCounts(raw)
    console.log('raw:', [...raw].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '))
    console.log('folded:', [...folded].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '))
    // Read the printed tallies: 6 of 11 samples land on harness, but only 5 of
    // those are real harness work. The 6th is mechanism C — a plugin's deferred
    // dependency work whose plugin frame had already left the stack. The GC
    // sample does NOT become harness; it stays runtime:gc.
    expect(folded.get('harness')).toBe(6)
    expect(folded.get('plugin:dsh-chat-import')).toBe(1)
    expect(folded.get('idle')).toBe(1)
    expect(folded.get('runtime:gc')).toBe(1)
    expect(folded.get('unattributed')).toBe(2)
  })
})