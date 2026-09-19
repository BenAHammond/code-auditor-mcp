/**
 * Composite schema-wrapper fixture — a bare D1 HTTP-query helper (the
 * `d1(sql)` shape from src/lib/d1-rest.ts / src/ops/repend-skipped-build-slots.ts)
 * whose SQL bypassed table rules before wrapper detection learned the name.
 */

/** Cloudflare D1 HTTP query shim — a DB wrapper, not a receiver/method name. */
async function d1<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/query`, {
    method: "POST", body: JSON.stringify({ sql, params }),
  });
  const j = (await r.json()) as { success: boolean; result: Array<{ results: T[] }>; errors: unknown[] };
  if (!j.success) throw new Error(String(j.errors));
  return j.result[0]?.results ?? [];
}

/** Re-reads a table dropped in 002 through the wrapper — stale-table-reference. */
export async function rewindSkipped(): Promise<unknown> {
  const skipped = await d1(`SELECT dedup_key FROM generation_queue WHERE state='skipped'`);
  return skipped;
}

/**
 * The FP-guard shape: an interpolated `${placeholders}` (built via
 * `.map(() => "?").join(",")`) passed to an `await d1<{...}>(...)` call with an
 * explicit type argument.  This is the exact tree-sitter shape that previously
 * broke the wrapper FP guard (`await d1<T>(...)` parses its callee as an
 * `await_expression` + `type_arguments`, not a bare identifier).  Because `d1`
 * is learned as a parameterized wrapper, `sql-injection-risk` must NOT fire —
 * even though the template carries an interpolation — while the carried
 * reference to the dropped `generation_queue` must still surface as
 * `stale-table-reference`.
 */
export async function rependSkipped(heroes: string[]): Promise<unknown> {
  const placeholders = heroes.map(() => "?").join(",");
  const rows = await d1<{ dedup_key: string }>(
    `SELECT dedup_key FROM generation_queue WHERE target_slug IN (${placeholders})`,
    heroes,
  );
  return rows;
}

