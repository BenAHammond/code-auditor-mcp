/**
 * non-db-receiver — NEAR-MISS NEGATIVE for data-access rules.
 *
 * `pool` is an array, NOT a database connection pool. The receiver
 * detection must NOT flag `pool.length` as a DB operation.
 * This guards against the regression where variable-named 'pool'
 * was incorrectly matched by the receiver-name pattern.
 *
 * Zero data-access violations expected from this file.
 */

const pool: number[] = [1, 2, 3];

export function getPoolSize(): number {
  return pool.length;
}

export function addToPool(item: number): void {
  pool.push(item);
}

export function clearPool(): void {
  pool.length = 0;
}
