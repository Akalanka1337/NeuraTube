import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '~': path.resolve(import.meta.dirname, 'src') },
  },
  define: {
    __NEURATUBE_VERSION__: JSON.stringify('0.0.0-test'),
    __DEV__: JSON.stringify(true),
  },
  test: {
    // happy-dom is materially faster than jsdom and implements the pieces we
    // exercise (Shadow DOM, adoptedStyleSheets, CSSStyleSheet).
    environment: 'happy-dom',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    setupFiles: ['tests/unit/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/entrypoints/**'],
    },
  },
});
