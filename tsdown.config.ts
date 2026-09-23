import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'

// Read the manifest from cwd: the config file's own URL is not guaranteed to sit
// at the package root under every loader, and the build scripts run here.
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

// Mirrors packages/client/web/src/platform.ts in deepseek-harness: the shell seeds
// these specifiers into the frozen browser module table, so a client bundle leaves
// them to the injected `require` instead of inlining them. A require() the module
// table cannot answer is a guaranteed runtime throw, so this list is a hard ceiling.
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

// Mirrors the purity-gate allowances in packages/client/tsdown.client.ts: wire/type
// layers with no shared runtime identity may inline; every other @deepseek-ai/*
// value import is a build error (cross-plugin collaboration goes through cordis
// services, and type-only imports are erased before this gate sees them).
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|file-reference|session|llm|tools|brand|util-workspace-path)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

const requested = new Set([...PLATFORM_MODULES, ...(pkg.dsh?.client?.external ?? [])])
const isRequested = (specifier: string): boolean => requested.has(specifier)

// Host half: a production dependency is on disk in a real install and stays an
// import; everything else inlines. Both halves are stated so moving a dependency
// between npm sections never silently re-bundles it.
const productionDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])
const escapeSpecifier = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const productionPatterns = [...productionDeps].map(name => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
const isProductionDependency = (specifier: string): boolean =>
  productionPatterns.some(pattern => pattern.test(specifier))

const NODE_ENV = process.env.NODE_ENV ?? 'production'

// Global-CSS inline channel, mirrored (minus the minifier) from dsh-context's
// tsdown.config.ts and packages/client/tsdown.client.ts: a client bundle ships
// as ONE js file, so a stylesheet import becomes a self-injecting <style> tag
// instead of an emitted asset. The virtual id must NOT end in '.css' —
// tsdown's own css-pipeline guard matches on that suffix; the flat pl-*
// class namespace is the anti-collision rule.
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function styleInjectionModule(id: string, fileId: string, css: string): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
    'export {};',
  ].join('\n')
}

// The panel ships a single small sheet, so the raw source is embedded
// unminified — a minifier dependency is weight this package refuses for a
// few KB of CSS (docs/design.md: no CSS toolchain for one panel).
const globalCssChannel = (id: string) => ({
  name: 'dsh-css-global-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
    return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  async load(this: { addWatchFile(file: string): void }, virtualId: string) {
    if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    // The virtual id otherwise hides the physical stylesheet from the watch graph.
    this.addWatchFile(fileId)
    const css = await readFile(fileId, 'utf8')
    return styleInjectionModule(id, fileId, css)
  },
})

export default defineConfig([
  {
    name: pkg.name,
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    // The host half's metric-contract types are the integration surface other
    // tooling compiles against; ship them next to the JS.
    dts: true,
    clean: true,
    deps: {
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
  },
  {
    name: `${pkg.name}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // dts would wrap the banner/footer into a .d.cts and break parsing.
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    // Browser bundles inline node-idiom deps that read process.env.NODE_ENV or
    // probe import.meta.env; without these substitutions the factory throws at boot.
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
    },
    plugins: [{
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null
        if (VENDORED_LIBRARY.test(source)) return null
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not in the default client externals or ${pkg.name}'s dsh.client.external, an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)',
        )
      },
    }, globalCssChannel(pkg.name)],
    outputOptions: {
      entryFileNames: 'client.js',
      // The closure-factory handoff every `dsh.client` package's ./client export must
      // use; mirrors tsdown.client.ts banner/intro/footer.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
