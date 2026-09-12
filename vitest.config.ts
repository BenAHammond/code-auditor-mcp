import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    /** Legacy vs universal parity: brittle to TS/analyzer drift; run `pnpm run test:parity` manually. */
    /** Integration tests use real runAudit() and WASM — run with `npm run test:integration` */
    exclude: ['**/node_modules/**', '**/dist/**', '**/*Parity.test.ts', '**/integration/**'],
    // The subprocess-spawning tests (Go analyzer, CLI, WASM pipeline) exceed
    // vitest's 5000ms default timeout under the default 10-core parallelism and
    // flake nondeterministically in `npm run verify:close` (a different test
    // each run, all passing in isolation). Cap workers to reduce load contention
    // and raise the timeout so a legitimately slow test under load does not
    // trip — the default invocation is the one that must pass. (Spec 55 release.)
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 15000,
  },
});
