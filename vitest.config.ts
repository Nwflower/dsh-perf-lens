import { defineConfig } from 'vitest/config'

// Two lanes mirroring dsh-context: host/shared specs run in plain node, client
// specs in jsdom (React 18). Specs import src/ directly, never the built lib/,
// so the suite runs with no build step.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'host',
          environment: 'node',
          include: ['test/*.test.ts'],
        },
      },
      {
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['test/client/**/*.test.tsx'],
        },
      },
    ],
  },
})
