/**
 * Characterisation of `isSafeDynamicPart` — the single discriminant that decides
 * `sql-injection-risk` on both the eager and non-eager paths.
 *
 * `isSafeDynamicPart` (UniversalDataAccessAnalyzer.ts) delegates to the adapter's
 * `isSafeInterpolation` (TreeSitterTypeScriptAdapter.ts, the `TsSafetyAnalysis`
 * slice), which recursively classifies an interpolated expression as *provably
 * structural* (safe) or *value-bearing / unclassifiable* (keeps the finding).
 * Nothing had ever asserted what it accepts and rejects, so these tests pin both
 * directions end-to-end through `runDataAccessSlice` — the same harness the real
 * rule runs in — never by calling the helper directly.
 *
 * Each snippet declares a real handle (`mysql2/promise` connection, the same shape
 * the Spec 70 scope-clause suite's positive control uses) so the site resolves as
 * a DB handle and `sql-injection-risk` is *in play* — a clean result is therefore
 * the interpolation being cleared, not the handle failing to resolve.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runDataAccessSlice } from '../phase/runner.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** A resolved handle + dynamic SQL prefix. The interpolation under test is the
 *  only variable: every snippet keeps the same handle and a SQL-keyword-bearing
 *  template so a 0-result is attributable to the interpolation, not to the site
 *  failing to resolve or the template lacking SQL keywords. */
const HANDLE = `import mysql from 'mysql2/promise';
const connection = await mysql.createConnection({ host: 'localhost', user: 'u', password: 'p', database: 'd' });
`;

/** Run the data-access slice over one snippet and count sql-injection-risk. */
async function inj(code: string): Promise<number> {
  const findings = await runDataAccessSlice([{ path: 'f.ts', content: code }], undefined, null);
  return findings.filter((f) => f.ruleId === 'sql-injection-risk').length;
}

describe('isSafeDynamicPart — value-bearing forms must be flagged', () => {
  it('a bare identifier holding a request value', async () => {
    const code = `${HANDLE}export function search(id: string) {
  return connection.execute(\`SELECT * FROM t WHERE id = \${id}\`);
}
`;
    expect(await inj(code)).toBeGreaterThanOrEqual(1);
  });

  it('a property access on a request object', async () => {
    const code = `${HANDLE}export function search(req: { body: { id: string } }) {
  return connection.execute(\`SELECT * FROM t WHERE id = \${req.body.id}\`);
}
`;
    expect(await inj(code)).toBeGreaterThanOrEqual(1);
  });

  it("a function call whose return value isn't provably literal", async () => {
    const code = `${HANDLE}function getInput(): string { return String(Date.now()); }
export function search() {
  return connection.execute(\`SELECT * FROM t WHERE id = \${getInput()}\`);
}
`;
    expect(await inj(code)).toBeGreaterThanOrEqual(1);
  });

  it('a ternary where one branch is value-bearing', async () => {
    const code = `${HANDLE}export function search(id: string, constrained: boolean) {
  return connection.execute(\`SELECT * FROM t WHERE x = \${constrained ? 'const' : id}\`);
}
`;
    expect(await inj(code)).toBeGreaterThanOrEqual(1);
  });

  it('a nested template literal carrying a value', async () => {
    const code = `${HANDLE}export function search(id: string) {
  return connection.execute(\`SELECT * FROM t WHERE x = \${'prefix-' + id}\`);
}
`;
    expect(await inj(code)).toBeGreaterThanOrEqual(1);
  });

  it('string concatenation mixing a literal and a variable', async () => {
    const code = `${HANDLE}export function search(id: string) {
  return connection.execute('SELECT * FROM t WHERE x = ' + id + ' LIMIT 1');
}
`;
    expect(await inj(code)).toBeGreaterThanOrEqual(1);
  });

  it('an array .join over a non-literal array', async () => {
    const code = `${HANDLE}export function search(ids: string[]) {
  return connection.execute(\`SELECT * FROM t WHERE id IN (\${ids.join(', ')})\`);
}
`;
    expect(await inj(code)).toBeGreaterThanOrEqual(1);
  });
});

describe('isSafeDynamicPart — structural forms must stay clean', () => {
  it("a `.map(() => '?')` placeholder list", async () => {
    const code = `${HANDLE}export function search(ids: string[]) {
  return connection.execute(\`SELECT * FROM t WHERE id IN (\${ids.map(() => '?').join(', ')})\`, ids);
}
`;
    expect(await inj(code)).toBe(0);
  });

  it('a `.join` over an in-code literal array', async () => {
    const code = `${HANDLE}export function search() {
  return connection.execute(\`SELECT * FROM t WHERE \${['x = ?', 'y = ?'].join(' AND ')}\`);
}
`;
    expect(await inj(code)).toBe(0);
  });

  it('a module-level const holding a literal clause', async () => {
    const code = `${HANDLE}const WHERE_CLAUSE = 'WHERE x = ?';
export function search() {
  return connection.execute(\`SELECT * FROM t \${WHERE_CLAUSE}\`);
}
`;
    expect(await inj(code)).toBe(0);
  });

  it('a function whose body returns only literals and `?`', async () => {
    const code = `${HANDLE}function colClause(col: string) { return col + ' = ?'; }
export function search() {
  return connection.execute(\`SELECT * FROM t WHERE \${colClause('x')}\`);
}
`;
    expect(await inj(code)).toBe(0);
  });

  it('a `.join` over a locally-built array of `col = $N` placeholder counters', async () => {
    // The clause-template idiom: column names and bind-parameter indices are
    // hardcoded/derived from a local `paramIndex++` counter, while the *values*
    // flow out-of-band through the bind array. `${paramIndex++}` is numeric
    // (ToNumeric), so the interpolated text is only `col = $2, col = $3, …` —
    // structural, never value-bearing. Red before the `update_expression` arm.
    const code = `${HANDLE}export function save(progress: { startedAt?: string }) {
  const setClause: string[] = [];
  const values: unknown[] = ['jobId'];
  let paramIndex = 2;
  if (progress.startedAt !== undefined) {
    setClause.push(\`started_at = \${paramIndex++}\`);
    values.push(progress.startedAt);
  }
  if (setClause.length > 0) {
    setClause.push('updated_at = NOW()');
    return connection.execute(\`UPDATE t SET \${setClause.join(', ')} WHERE id = $1\`, values);
  }
}
`;
    expect(await inj(code)).toBe(0);
  });
});

describe('isSafeDynamicPart — the deleted substring short-circuit must not clear value-bearing interpolations', () => {
  // Each query's *text* contains one of the removed `parameterizedQueries`
  // magic strings, but the `${…}` interpolation is value-bearing. The deleted
  // `checkQuerySecurity` shortcut (`text.includes(p)`) used to return
  // `parameterized: true` before isSafeDynamicPart ran — a false negative. These
  // are red until the short-circuit is gone: each must now flag.

  it('a query whose text contains the word "prepared"', async () => {
    // `prepared_at` is a column name, not a parameterization mechanism.
    const code = `${HANDLE}export function search(id: string) {
  return connection.execute(\`SELECT * FROM orders WHERE prepared_at >= \${id}\`);
}
`;
    expect(await inj(code)).toBeGreaterThanOrEqual(1);
  });

  it('a query whose text contains the word "parameterized"', async () => {
    const code = `${HANDLE}export function search(id: string) {
  return connection.execute(\`SELECT * FROM orders WHERE parameterized_at >= \${id}\`);
}
`;
    expect(await inj(code)).toBeGreaterThanOrEqual(1);
  });

  it("a query whose text contains '$1' inside a literal like '$100'", async () => {
    const code = `${HANDLE}export function search(id: string) {
  return connection.execute(\`SELECT * FROM orders WHERE price > $100 AND id = \${id}\`);
}
`;
    expect(await inj(code)).toBeGreaterThanOrEqual(1);
  });

  it("a query whose text contains ':param' as a literal", async () => {
    const code = `${HANDLE}export function search(id: string) {
  return connection.execute(\`SELECT * FROM orders WHERE note = ':param' AND id = \${id}\`);
}
`;
    expect(await inj(code)).toBeGreaterThanOrEqual(1);
  });
});
