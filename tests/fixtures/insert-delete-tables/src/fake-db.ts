// Fake DB module for the insert-delete-tables fixture.
// Provides a mock D1 database interface that the test file uses.

export interface MockDB {
  prepare(sql: string): { bind(...params: unknown[]): { run(): void } };
  exec(sql: string): void;
}

export function getDB(): MockDB {
  return {
    prepare: (sql: string) => ({
      bind: (..._params: unknown[]) => ({
        run: () => { /* no-op */ },
      }),
    }),
    exec: (_sql: string) => { /* no-op */ },
  };
}
