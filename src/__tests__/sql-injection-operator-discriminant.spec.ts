/**
 * Pin the `sql-injection-risk` operator discriminant (post f88db08).
 *
 * `isDynamicStringConstruction` used to classify any `binary_expression` with a
 * string-literal operand as string concatenation, ignoring the operator. A
 * nullish-coalescing bind default (`value ?? 'default'`), a logical-or
 * (`value || 'default'`), a logical-and (`value && 'default'`), or a comparison
 * (`status === 'active'`) therefore read as raw SQL interpolation, so a fully
 * parameterized `.prepare('SELECT … WHERE x = ?').get(bind)` was flagged as
 * `sql-injection-risk`. The fix narrows the `binary_expression` case to require
 * a `+` operator — the only binary operator that *concatenates* strings
 * (`??`, `||`, `&&`, and the relational operators are value/logical operators;
 * arithmetic operators never carry a string operand, and `+` beside a string is
 * exactly the concatenation this rule must flag).
 *
 * These tests run the real rule (`runDataAccessSlice` → `sql-injection-risk`) —
 * never `isDynamicStringConstruction` directly — and assert:
 *   - a parameterized call whose bind value is a non-`+` binary expression
 *     (`??`, `||`, `&&`, comparison) stays clean; and
 *   - a query whose SQL text is built with `'SELECT … ' + userValue` still
 *     fires, so the `+` branch is proven live rather than merely narrowed away.
 *
 * The `??` case is the regression pin: it fails against f88db08's parent
 * (dbbf8a3) and passes at HEAD.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages } from '../languages/index.js';
import { runDataAccessSlice } from '../phase/runner.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

async function injectionFindings(code: string, name: string): Promise<any[]> {
  const fresh = await runDataAccessSlice([{ path: `${name}.ts`, content: code }], undefined, null);
  return fresh.filter((f) => f.ruleId === 'sql-injection-risk');
}

// A provenanced better-sqlite3 handle. The `.prepare(sql).get(bind)` chain is a
// recognized data-access call; the single bind argument means it is not cleared
// by the eager-execution parameterized shape (`countArgs >= 2`), so it reaches
// `isDynamicStringConstruction` — the discriminant under test.
const PRELUDE = `import Database from 'better-sqlite3';
const db = new Database('app.db');
`;

describe('sql-injection-risk operator discriminant — non-`+` bind values are not interpolation', () => {
  it("clears a nullish-coalescing bind default (`value ?? 'default'`)", async () => {
    const code = PRELUDE + `export function lookup(value: string | undefined) {
  return db.prepare('SELECT * FROM t WHERE x = ?').get(value ?? 'default');
}
`;
    expect(await injectionFindings(code, 'nullish')).toHaveLength(0);
  });

  it("clears a logical-or bind default (`value || 'default'`)", async () => {
    const code = PRELUDE + `export function lookup(value: string | undefined) {
  return db.prepare('SELECT * FROM t WHERE x = ?').get(value || 'default');
}
`;
    expect(await injectionFindings(code, 'logical-or')).toHaveLength(0);
  });

  it("clears a logical-and bind value (`value && 'default'`)", async () => {
    const code = PRELUDE + `export function lookup(value: string | undefined) {
  return db.prepare('SELECT * FROM t WHERE x = ?').get(value && 'default');
}
`;
    expect(await injectionFindings(code, 'logical-and')).toHaveLength(0);
  });

  it("clears a comparison bind value (`status === 'active'`)", async () => {
    const code = PRELUDE + `export function lookup(status: string) {
  return db.prepare('SELECT * FROM t WHERE x = ?').get(status === 'active');
}
`;
    expect(await injectionFindings(code, 'comparison')).toHaveLength(0);
  });

  it("still flags a `+`-built SQL string (the `+` branch is live)", async () => {
    const code = `import { Pool } from 'pg';
const db = new Pool();
export function getUser(userValue: string) {
  return db.query('SELECT * FROM t WHERE id = ' + userValue);
}
`;
    expect((await injectionFindings(code, 'plus')).length).toBeGreaterThanOrEqual(1);
  });
});
