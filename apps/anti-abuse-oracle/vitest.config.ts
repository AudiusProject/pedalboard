import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'hono/jsx'
  },
  test: {
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
})
