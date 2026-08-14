/**
 * Spec 33 Item 6 — sql-injection FP: taint tracking
 *
 * Locks in cross-function taint tracking via the adapter's `isSafeInterpolation`
 * capability.  Seven false-positive mechanisms are cleared (quote-escape
 * sanitizer, safe ternary, safe local helper call, call-site-provenanced
 * parameter, static-array `.map().join()`, guard-validated parameter), and two
 * genuinely-raw inputs stay flagged (raw parameter, member-expression access).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../../../languages/index.js';
import { parseFile } from '../../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../../languages/types.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from '../../../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const fixtureDir = join(tmpdir(), 'spec33-item6-' + Date.now());

// ── Fixture sources ──────────────────────────────────────────────────

/** Quote-escape sanitizer — `.replace(/'/g, "''")` returns an escaped literal. */
const QUOTE_ESCAPE_SANITIZER = `
import { db } from './db';
async function f(name: string) {
  await db.raw(\`SELECT * FROM users WHERE name = '\${name.replace(/'/g, "''")}'\`);
}
`;

/** Ternary whose branches are both substitution-free (static) templates. */
const SAFE_TERNARY = `
import { db } from './db';
async function f(kind: string) {
  const where = kind === 'skipped' ? \`error LIKE 'SKIP:%'\` : \`status = 'failed'\`;
  await db.raw(\`SELECT * FROM t WHERE \${where}\`);
}
`;

/** Local helper call whose body is safe under its literal call-site argument. */
const SAFE_LOCAL_HELPER = `
import { db } from './db';
function qualifiedIconRemote(alias: string): string {
  return \`(\${alias}.icon_url LIKE 'http%' OR \${alias}.icon_url LIKE '//%')\`;
}
async function f() {
  await db.raw(\`SELECT * FROM t WHERE \${qualifiedIconRemote('w')}\`);
}
`;

/** Function parameter safe because every call site passes a literal. */
const PARAM_SAFE_AT_CALL_SITES = `
import { db } from './db';
async function countRows(table: string) {
  await db.raw(\`SELECT COUNT(*) AS c FROM \${table}\`);
}
countRows('matchmaking_pool');
`;

/** Static-array `.map().join()` chain producing a compile-time column list. */
const STATIC_MAP_JOIN = `
import { db } from './db';
const EFFECT_FLAGS = ['a', 'b'];
async function f() {
  const cols = EFFECT_FLAGS.map((c) => 'a.' + c).join(', ');
  await db.raw(\`SELECT \${cols} FROM t\`);
}
`;

/** Same as above but the array is declared `as const`, and the `.map().join()`
 *  is interpolated inline (not via a local `const cols`). */
const STATIC_MAP_JOIN_AS_CONST = `
import { db } from './db';
const EFFECT_FLAGS = ['a', 'b'] as const;
async function f() {
  await db.raw(\`SELECT \${EFFECT_FLAGS.map((c) => \`a.\${c}\`).join(", ")} FROM t\`);
}
`;

/** Guard-validated parameter — `assertRegistered(table)` throws before use. */
const GUARD_VALIDATED_PARAM = `
import { db } from './db';
const PIPELINES = { matchmaking_pool: true };
function assertRegistered(table: string) {
  if (!(table in PIPELINES)) throw new Error('unregistered');
}
async function statusCounts(table: string) {
  assertRegistered(table);
  await db.raw(\`SELECT * FROM \${table}\`);
}
`;

/** Genuine raw parameter — unguarded, unescaped, no safe call sites. */
const RAW_PARAMETER = `
import { db } from './db';
async function f(modeArg: string) {
  await db.raw(\`SELECT * FROM t WHERE mode = '\${modeArg}'\`);
}
`;

/** Member-expression access — a value we cannot prove safe. */
const MEMBER_EXPRESSION = `
import { db } from './db';
async function f(req: { name: string }) {
  await db.raw(\`SELECT * FROM t WHERE name = '\${req.name}'\`);
}
`;

type TestCase = { name: string; code: string; expectedCount: number };

const TEST_CASES: TestCase[] = [
  { name: 'quote-escape sanitizer — NOT flagged', code: QUOTE_ESCAPE_SANITIZER, expectedCount: 0 },
  { name: 'safe ternary — NOT flagged', code: SAFE_TERNARY, expectedCount: 0 },
  { name: 'safe local helper call — NOT flagged', code: SAFE_LOCAL_HELPER, expectedCount: 0 },
  { name: 'param safe at all call sites — NOT flagged', code: PARAM_SAFE_AT_CALL_SITES, expectedCount: 0 },
  { name: 'static-array .map().join() — NOT flagged', code: STATIC_MAP_JOIN, expectedCount: 0 },
  { name: 'static-array .map().join() as const — NOT flagged', code: STATIC_MAP_JOIN_AS_CONST, expectedCount: 0 },
  { name: 'guard-validated param — NOT flagged', code: GUARD_VALIDATED_PARAM, expectedCount: 0 },
  { name: 'raw parameter — flagged (control)', code: RAW_PARAMETER, expectedCount: 1 },
  { name: 'member-expression access — flagged (control)', code: MEMBER_EXPRESSION, expectedCount: 1 },
];

describe('Spec-33 Item 6: sql-injection cross-function taint tracking', () => {
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

  for (const { name, code, expectedCount } of TEST_CASES) {
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
    });
  }
});
