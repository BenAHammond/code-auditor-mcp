import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Same rationale as vitest.config.ts: these tests each run a real
    // runAudit() (WASM + tree-sitter + Go subprocess) and can exceed 5000ms
    // under parallel load, flaking the `verify:close` gate.
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 30000,
  },
});
