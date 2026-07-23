/**
 * Spec-19 R3 — SQL injection context gating and demotion to suggestion
 *
 * Verifies:
 * - Item 9: Receiver gating — template literals passed to non-DB functions
 *   (page.evaluate, console.log) are NOT flagged as sql-injection-risk.
 * - Item 10: Parameterized queries with placeholders ($1 / ? / :param) produce
 *   NO finding — they are the remediation, not the problem.
 * - R3.3: All surviving sql-injection-risk findings are blanket-demoted to
 *   suggestion because the heuristics operate without type information.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../../../languages/index.js';
import { parseFile } from '../../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../../languages/types.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from '../../../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const fixtureDir = join(tmpdir(), 'spec19-r3-' + Date.now());

// ── Fixture sources ──────────────────────────────────────────────────

/**
 * Item 9: Template literal with querySelectorAll (looks like SQL keywords:
 * 'SELECT' appears in 'querySelectorAll') passed to page.evaluate().
 * Should NOT trigger sql-injection-risk — the receiver is a Playwright API.
 */
const PLAYWRIGHT_EVALUATE = `
import { Page } from 'playwright';

async function checkElementVisible(page: Page, selector: string): Promise<boolean> {
  const visible = await page.evaluate(
    (sel) => document.querySelector(sel) !== null,
    selector
  );

  const count = await page.evaluate(
    \`document.querySelectorAll('\${selector}').length\`
  );

  return visible && count > 0;
}

export { checkElementVisible };
`;

/**
 * Item 9 positive control: Template literal with SQL passed to a DB function
 * (db.query). Should still trigger sql-injection-risk.
 */
const DB_QUERY_TEMPLATE = `
import { query } from './db';

async function searchUsers(name: string) {
  const rows = await query(\`SELECT * FROM users WHERE name = '\${name}'\`);
  return rows;
}
`;

/**
 * Item 10: Template literal in query() call with parameterized placeholder
 * ($1) and dynamic table name. Should produce NO sql-injection-risk finding
 * because the $1 placeholder is the remediation, not the problem.
 */
const PARAMETERIZED_WITH_DYNAMIC_TABLE = `
import { query } from './db';

const TableName = {
  PROD: 'analytics_prod',
  STAGING: 'analytics_staging',
} as const;

type Env = 'production' | 'staging';

async function getAnalytics(env: Env) {
  const table = env === 'production' ? TableName.PROD : TableName.STAGING;

  const rows = await query(\`SELECT * FROM \${table} WHERE date > $1\`, [new Date()]);
  return rows;
}

export { getAnalytics };
`;

/**
 * Item 10 negative control: Template literal WITHOUT parameterized
 * placeholders. Should get sql-injection-risk at SUGGESTION severity
 * (blanket demotion, R3.3).
 */
const NON_PARAMETERIZED_INJECTION = `
import { query } from './db';

async function searchUsers(keyword: string) {
  const rows = await query(\`SELECT * FROM users WHERE name LIKE '%\${keyword}%'\`);
  return rows;
}
`;

/**
 * Template literal assigned to a variable, then used in a DB call —
 * we can't track the data flow, so should STILL flag (conservative).
 */
const VARIABLE_ASSIGNMENT_TEMPLATE = `
import { query } from './db';

async function buildAndRun(filter: string) {
  const sql = \`SELECT * FROM orders WHERE status = '\${filter}'\`;
  const rows = await query(sql);
  return rows;
}
`;

/**
 * Template literal passed directly to console.log — non-DB sink.
 * Should NOT trigger sql-injection-risk because console.log is not a DB function.
 */
const CONSOLE_LOG_TEMPLATE = `
function debugQuery(filter: string) {
  console.log(
    \`SELECT * FROM users WHERE name = '\${filter}'\`
  );
}
`;

type TestCase = {
  name: string;
  code: string;
  /** Expected number of sql-injection-risk violations */
  expectedCount: number;
  /** Expected severity of the first sql-injection-risk violation (if any) */
  expectedSeverity?: 'warning' | 'suggestion';
};

const TEST_CASES: TestCase[] = [
  {
    name: 'page.evaluate with template literal — should NOT trigger (item 9)',
    code: PLAYWRIGHT_EVALUATE,
    expectedCount: 0,
  },
  {
    name: 'db.query with template literal — should trigger sql-injection-risk (positive control)',
    code: DB_QUERY_TEMPLATE,
    expectedCount: 1,
    expectedSeverity: 'suggestion',
  },
  {
    name: 'parameterized query with dynamic table — should produce NO finding (placeholders = remediation)',
    code: PARAMETERIZED_WITH_DYNAMIC_TABLE,
    expectedCount: 0,
  },
  {
    name: 'non-parameterized injection — should be suggestion (blanket demotion, R3.3)',
    code: NON_PARAMETERIZED_INJECTION,
    expectedCount: 1,
    expectedSeverity: 'suggestion',
  },
  {
    name: 'template literal assigned to variable then passed to query — should be suggestion',
    code: VARIABLE_ASSIGNMENT_TEMPLATE,
    expectedCount: 1,
    expectedSeverity: 'suggestion',
  },
  {
    name: 'console.log with SQL template — should NOT trigger (non-DB sink)',
    code: CONSOLE_LOG_TEMPLATE,
    expectedCount: 0,
  },
];

describe('Spec-19 R3: SQL injection context gating', () => {
  let analyzer: UniversalDataAccessAnalyzer;
  let tsAdapter: LanguageAdapter;

  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
    await mkdir(fixtureDir, { recursive: true });
    tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
    if (!tsAdapter) throw new Error('TypeScript adapter not found');
    analyzer = new UniversalDataAccessAnalyzer();
  });

  for (const { name, code, expectedCount, expectedSeverity } of TEST_CASES) {
    it(name, async () => {
      const safeName = name.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
      const filePath = join(fixtureDir, `${safeName}.ts`);
      await writeFile(filePath, code, 'utf-8');

      const sourceCode = await readFile(filePath, 'utf-8');
      const ast = parseFile(filePath, sourceCode)!;
      if (!ast) throw new Error(`Failed to parse ${filePath}`);

      const violations = await (analyzer as any).analyzeAST(
        ast,
        tsAdapter,
        DEFAULT_DATA_ACCESS_CONFIG,
        sourceCode
      );

      const sqlInjectionViolations = violations.filter(
        (v: { rule: string }) => v.rule === 'sql-injection-risk'
      );

      expect(
        sqlInjectionViolations.length,
        `Expected ${expectedCount} sql-injection-risk violations for "${name}", got ${sqlInjectionViolations.length}`
      ).toBe(expectedCount);

      if (expectedCount > 0 && expectedSeverity) {
        expect(
          sqlInjectionViolations[0].severity,
          `Expected severity "${expectedSeverity}" for "${name}", got "${sqlInjectionViolations[0].severity}"`
        ).toBe(expectedSeverity);
      }
    });
  }
});
