// Stylesheet imports resolve through the tsdown global-CSS inline channel
// (tsdown.config.ts), which turns each sheet into a self-injecting <style>
// module. This declaration exists so tsc accepts the import in index.tsx.

declare module '*.css'
