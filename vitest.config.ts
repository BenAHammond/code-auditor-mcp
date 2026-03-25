import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    /** Legacy vs universal parity: brittle to TS/analyzer drift; run `pnpm run test:parity` manually. */
    exclude: ['**/node_modules/**', '**/dist/**', '**/*Parity.test.ts'],
  },
});
