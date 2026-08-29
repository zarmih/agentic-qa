import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/artifacts/**'],
    coverage: {
      provider: 'v8',
    },
    testTimeout: 30_000,
  },
});
