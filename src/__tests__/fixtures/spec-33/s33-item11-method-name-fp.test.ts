/**
 * Spec 33 Item 11 — FP category 5: residual method-name FP in
 * `data-access/sql-injection-risk`.
 *
 * The Directus finding at `use-alias-fields.ts:126` flags
 * `get(item, \`${aliasInfo.fieldAlias}.${...}\`)` where `get` is
 * `@directus/utils`'s lodash-style object-path accessor, not a SQL query
 * method.  The rule's bare-identifier hybrid fallback in `isDBProvenanced`
 * (Case 1) matched any `get(...)` / `query(...)` / `each(...)` / `values(...)`
 * name against `DB_CALL_METHODS`, so an unsafe-looking interpolation under a
 * lodash accessor was treated as a query.
 *
 * This regression locks in the fix: bare `get(...)` — and the other
 * FP-prone non-DB method names — must NOT be flagged, while a genuine
 * raw-SQL entry point (`db.raw(...)`) must still be flagged.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages } from '../../../languages/index.js';
import { runDataAccessSlice } from '../../../phase/runner.js';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const fixtureDir = join(tmpdir(), 'spec33-item11-' + Date.now());

/**
 * The Directus FP shape: a lodash-style object-path accessor whose interpolated
 * field name happens to contain a SQL keyword ("updated_at" ⊃ "UPDATE").
 */
const LODASH_GET_ACCESSOR = `
import { get } from '@directus/utils';
async function f(item: any, aliasInfo: any) {
  return get(item, \`\${aliasInfo.fieldAlias}.updated_at\`);
}
`;

/**
 * A non-`get` FP-prone name (`values`) used as a bare call — the iterator/Map
 * `.values()` pattern — must not be treated as a DB query either.
 */
const BARE_VALUES_CALL = `
async function f(collection: any) {
  const v = values(collection, \`\${collection.key}.updated_at\`);
  return v;
}
`;

/** Control: a genuine raw-SQL entry point must still be flagged. */
const RAW_CONTROL = `
import Database from 'better-sqlite3';
const db = new Database(':memory:');
async function f(modeArg: string) {
  await db.raw(\`SELECT * FROM t WHERE mode = '\${modeArg}'\`);
}
`;

type TestCase = { name: string; code: string; expectedCount: number };

const TEST_CASES: TestCase[] = [
  { name: 'lodash get accessor with SQL-shaped field — NOT flagged', code: LODASH_GET_ACCESSOR, expectedCount: 0 },
  { name: 'bare values() call — NOT flagged', code: BARE_VALUES_CALL, expectedCount: 0 },
  { name: 'db.raw() unsafe param — flagged (control)', code: RAW_CONTROL, expectedCount: 1 },
];

describe('Spec-33 Item 11: sql-injection-risk method-name FP', () => {
  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
    await mkdir(fixtureDir, { recursive: true });
  });

  for (const { name, code, expectedCount } of TEST_CASES) {
    it(name, async () => {
      const safeName = name.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
      const filePath = join(fixtureDir, `${safeName}.ts`);

      const violations = await runDataAccessSlice([{ path: filePath, content: code }], undefined, null);

      const sqlInjectionViolations = violations.filter(
        (v) => v.ruleId === 'sql-injection-risk'
      );

      expect(
        sqlInjectionViolations.length,
        `Expected ${expectedCount} sql-injection-risk violations for "${name}", got ${sqlInjectionViolations.length}`
      ).toBe(expectedCount);
    });
  }
});
