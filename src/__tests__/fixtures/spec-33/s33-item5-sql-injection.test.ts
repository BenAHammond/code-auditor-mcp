/**
 * Spec 33 Item 5 — sql-injection FN: concat + builder
 *
 * Two fixes locked in here:
 *
 * 1. DDL keyword recognition. The SQL keyword gate (`SQL_KEYWORDS`) previously
 *    covered only DML verbs, so a schema migration built by concatenating an
 *    interpolated identifier — e.g. `db.exec(\`create TABLE if not exists
 *    ${ddl}\`)` — contained no DML keyword and passed the gate unflagged. DDL
 *    verbs (CREATE/DROP/ALTER/TRUNCATE) are now in `SQL_KEYWORDS`, so DDL
 *    injection is recognized as SQL and flagged.
 *
 * 2. `+=` augmented assignment taints a local the same way `=` reassignment
 *    does. `hasReassignment` previously only saw `assignment_expression`, so a
 *    local built up with `+=` was treated as a compile-time constant and its
 *    template substitution was suppressed. It now sees
 *    `augmented_assignment_expression`, so `let t = 'users'; t += '_archive'`
 *    correctly demotes `t` to runtime-dependent and the substitution is flagged.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages } from '../../../languages/index.js';
import { runDataAccessSlice } from '../../../phase/runner.js';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const fixtureDir = join(tmpdir(), 'spec33-item5-' + Date.now());

// ── Fixture sources ──────────────────────────────────────────────────

/** DDL via template-literal concat — the knex +1 (cli-test-utils.js:80 shape). */
const DDL_TEMPLATE_CONCAT = `
import Database from 'better-sqlite3';
const db = new Database(':memory:');

async function migrate(ddl: string) {
  await db.exec(\`create TABLE if not exists \${ddl};\`);
}
`;

/** DDL via binary `+` concat. */
const DDL_DROP_CONCAT = `
import Database from 'better-sqlite3';
const db = new Database(':memory:');

async function dropTable(name: string) {
  await db.exec('DROP TABLE ' + name);
}
`;

/** `+=` reassigned local interpolated into a template — FN before the fix. */
const AUGMENTED_ASSIGNMENT_TABLE = `
import Database from 'better-sqlite3';
const db = new Database(':memory:');

async function listArchived() {
  let table = 'users';
  table += '_archive';
  const rows = await db.raw(\`SELECT * FROM \${table}\`);
  return rows;
}
`;

/** `const` local interpolated into a template — compile-time constant, not an injection. */
const CONST_STATIC_TABLE = `
const db: D1Database = getDb();

async function listUsers() {
  const table = 'users';
  const rows = await db.raw(\`SELECT * FROM \${table}\`);
  return rows;
}
`;

/** Plain `=` reassignment (existing behavior control). */
const PLAIN_REASSIGNED_TABLE = `
import Database from 'better-sqlite3';
const db = new Database(':memory:');

async function listArchived() {
  let table = 'users';
  table = 'users_archive';
  const rows = await db.raw(\`SELECT * FROM \${table}\`);
  return rows;
}
`;

/** Inline `+` concat in a DB-provenanced call (existing behavior control). */
const INLINE_PLUS_CONCAT = `
import Database from 'better-sqlite3';
const db = new Database(':memory:');

async function search(user: string) {
  const rows = await db.raw('SELECT * FROM users WHERE name = ' + user);
  return rows;
}
`;

type TestCase = {
  name: string;
  code: string;
  expectedCount: number;
};

const TEST_CASES: TestCase[] = [
  {
    name: 'DDL template-literal concat in db.exec — flagged (DDL keyword fix)',
    code: DDL_TEMPLATE_CONCAT,
    expectedCount: 1,
  },
  {
    name: 'DDL DROP via + concat in db.exec — flagged (DDL keyword fix)',
    code: DDL_DROP_CONCAT,
    expectedCount: 1,
  },
  {
    name: '+= reassigned local interpolated into template — flagged (+= fix)',
    code: AUGMENTED_ASSIGNMENT_TABLE,
    expectedCount: 1,
  },
  {
    name: 'const local interpolated into template — NOT flagged (static)',
    code: CONST_STATIC_TABLE,
    expectedCount: 0,
  },
  {
    name: 'plain = reassigned local interpolated into template — flagged (control)',
    code: PLAIN_REASSIGNED_TABLE,
    expectedCount: 1,
  },
  {
    name: 'inline + concat in db.raw — flagged (control)',
    code: INLINE_PLUS_CONCAT,
    expectedCount: 1,
  },
];

describe('Spec-33 Item 5: SQL injection concat (+=) and DDL keyword coverage', () => {
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
