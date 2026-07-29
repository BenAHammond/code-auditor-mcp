import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    /** Legacy vs universal parity: brittle to TS/analyzer drift; run `pnpm run test:parity` manually. */
    /** Integration tests use real runAudit() and WASM — run with `npm run test:integration` */
    exclude: ['**/node_modules/**', '**/dist/**', '**/*Parity.test.ts', '**/integration/**'],
  },
});
