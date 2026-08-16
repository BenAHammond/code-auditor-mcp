/**
 * Spec 37 R3 acceptance #6 — the six historical false positives, executed.
 *
 * A near-miss negative is a case that catches a rule matching on syntax rather
 * than semantics. Each of the six historical regressions is run here through
 * its real analyzer — not through the registry metadata — and the near-miss is
 * asserted to produce zero false-positive findings. If a guard is removed,
 * the corresponding test fails.
 *
 * The six, and the guard each one exercises:
 *
 *   1. `pool.length` read as a DB receiver        → receiver-name + provenance gate
 *   2. `COUNT`/`WHERE` read as receivers           → `extractCallExpressionMethod` AST walk
 *   3. `createTable` that is not the ORM's         → `module` provenance filter
 *   4. `createElement(Button)` read as raw element → `extractJSXElements` skips call_expression
 *   5. `escapeSql(x)` treated as raw interpolation → `sanitizerNames` gate
 *   6. a class defined in a CSS comment            → CSS AST comment-node filtering
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { extractTablesFromRegistry } from '../analyzers/universal/schema/discovery.js';
import type { TableSourceEntry } from '../analyzers/universal/schema/types.js';
import { scanFile } from '../componentScanner.js';
import { checkRawElements, DEFAULT_REACT_CONFIG } from '../analyzers/reactAnalyzer.js';
import { extractClassUsageFromCSSAst } from '../styles/cssAstExtractor.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tsAdapter: LanguageAdapter;
let analyzer: UniversalDataAccessAnalyzer;
let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDataAccessAnalyzer();
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-nearmiss-'));
}, 30_000);

async function analyzeDataAccess(code: string, name: string): Promise<any[]> {
  const filePath = join(tmpDir, `${name}.ts`);
  await writeFile(filePath, code, 'utf-8');
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${filePath}`);
  return (analyzer as any).analyzeAST(ast, tsAdapter, DEFAULT_DATA_ACCESS_CONFIG, sourceCode);
}

// ══════════════════════════════════════════════════════════════════
// 1. pool.length read as a DB receiver
// ══════════════════════════════════════════════════════════════════

describe('FP 1 — pool.length is not a DB receiver', () => {
  it('flags zero data-access violations for an array `.length` access', async () => {
    const code = `
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
`;
    const violations = await analyzeDataAccess(code, 'pool-length');
    expect(violations).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. COUNT / WHERE read as receivers
// ══════════════════════════════════════════════════════════════════

describe('FP 2 — COUNT/WHERE inside SQL is not a receiver', () => {
  it('still detects the one real injection and attributes it to the true method', async () => {
    // COUNT and WHERE appear inside the SQL string. A regex scan of the full
    // call text would match them as the method name; the AST walk must extract
    // `raw` from the callee instead, so the call is still recognized as a DB
    // call and the interpolation is still flagged.
    const code = `
import { db } from './db';

export async function countById(userId: string) {
  const rows = await db.raw(\`SELECT COUNT(*) FROM users WHERE id = \${userId}\`);
  return rows;
}
`;
    const violations = await analyzeDataAccess(code, 'count-where');
    const sql = violations.filter((v: { rule: string }) => v.rule === 'sql-injection-risk');
    expect(sql).toHaveLength(1);
    // The message names the true method, not a SQL keyword picked out of the string.
    expect(sql[0].message ?? '').not.toContain('COUNT');
    expect(sql[0].message ?? '').not.toContain('WHERE');
  });

  it('a parameterized COUNT/WHERE query is not flagged at all', async () => {
    const code = `
import { db } from './db';

export async function countParameterized(userId: string) {
  const rows = await db.query("SELECT COUNT(*) FROM users WHERE id = ?", [userId]);
  return rows;
}
`;
    const violations = await analyzeDataAccess(code, 'count-where-parameterized');
    const sql = violations.filter((v: { rule: string }) => v.rule === 'sql-injection-risk');
    expect(sql).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. createTable that is not the ORM's
// ══════════════════════════════════════════════════════════════════

describe('FP 3 — createTable without DB provenance is not a table', () => {
  it('does not match a bare local `createTable` when the entry requires a knex module', async () => {
    const entries: TableSourceEntry[] = [
      { kind: 'callee', name: 'createTable', arg: 0, module: 'knex' },
    ];
    const source = `function createTable(name: string) { console.log(name); }
createTable('metrics_table');`;
    const ast = await tsAdapter.parse('test.ts', source);
    const result = extractTablesFromRegistry(entries, {
      ast,
      adapter: tsAdapter,
      sourceCode: source,
      filePath: 'test.ts',
    });
    expect(result).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// 4. createElement(Button) read as a raw element
// ══════════════════════════════════════════════════════════════════

describe('FP 4 — createElement(Button) is not a raw element', () => {
  it('does not collect a call_expression as a JSX element', async () => {
    const filePath = join(tmpDir, 'create-element.tsx');
    await writeFile(
      filePath,
      `import React from 'react';

export function SaveButton() {
  React.createElement(Button, null, 'Save');
  return <button className="btn">Save</button>;
}
`,
      'utf-8',
    );
    const result = await scanFile(filePath);
    const component = result.components.find((c: any) => c.name === 'SaveButton');
    expect(component).toBeTruthy();
    // The guard: extractJSXElements only walks jsx_element / jsx_self_closing_element
    // nodes. React.createElement(...) is a call_expression and must be invisible,
    // so only the real <button> JSX tag is collected.
    expect(component!.jsxElements ?? []).toEqual(['button']);
    expect(component!.jsxElements ?? []).not.toContain('Button');
  });

  it('produces zero raw-element violations for createElement(Button) but flags real <button> JSX', async () => {
    const wrapperPath = join(tmpDir, 'wrapper-create-element.tsx');
    const consumerPath = join(tmpDir, 'consumer-create-element.tsx');
    const rawConsumerPath = join(tmpDir, 'raw-consumer-create-element.tsx');

    await writeFile(
      wrapperPath,
      `import React from 'react';
export function Button({ children }: any) {
  return <button className="btn">{children}</button>;
}
`,
      'utf-8',
    );
    await writeFile(
      consumerPath,
      `import React from 'react';
import { Button } from './wrapper-create-element';

export function SaveButton() {
  return React.createElement(Button, null, 'Save');
}
`,
      'utf-8',
    );
    await writeFile(
      rawConsumerPath,
      `import React from 'react';
import { Button } from './wrapper-create-element';

export function LegacySave() {
  return <button className="btn">Save</button>;
}
`,
      'utf-8',
    );

    const config = { ...DEFAULT_REACT_CONFIG, wrapperMinUsages: 1 };

    const wrapperScan = await scanFile(wrapperPath);
    const consumerScan = await scanFile(consumerPath);
    const rawConsumerScan = await scanFile(rawConsumerPath);

    // createElement(Button) — the near-miss — must NOT be flagged.
    const createElementViolations = checkRawElements([wrapperScan, consumerScan], config);
    expect(createElementViolations).toHaveLength(0);

    // Real <button> JSX — the true positive control — must STILL be flagged.
    const rawViolations = checkRawElements([wrapperScan, rawConsumerScan], config);
    const rawButton = rawViolations.filter((v: any) => v.rule === 'raw-element');
    expect(rawButton.length).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// 5. escapeSql(x) treated as raw interpolation
// ══════════════════════════════════════════════════════════════════

describe('FP 5 — escapeSql(x) is not raw interpolation', () => {
  it('flags zero sql-injection-risk for interpolation wrapped in a sanitizer', async () => {
    const code = `
import { db } from './db';

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

export async function safeLookup(name: string) {
  const rows = await db.query(\`SELECT * FROM users WHERE name = '\${escapeSql(name)}'\`);
  return rows;
}
`;
    const violations = await analyzeDataAccess(code, 'escape-sql');
    const sql = violations.filter((v: { rule: string }) => v.rule === 'sql-injection-risk');
    expect(sql).toHaveLength(0);
  });

  it('still flags the same interpolation without the sanitizer (control)', async () => {
    const code = `
import { db } from './db';

export async function unsafeLookup(name: string) {
  const rows = await db.query(\`SELECT * FROM users WHERE name = '\${name}'\`);
  return rows;
}
`;
    const violations = await analyzeDataAccess(code, 'escape-sql-control');
    const sql = violations.filter((v: { rule: string }) => v.rule === 'sql-injection-risk');
    expect(sql.length).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// 6. a class defined in a CSS comment
// ══════════════════════════════════════════════════════════════════

describe('FP 6 — a class defined only in a CSS comment is not a class', () => {
  it('does not extract a class name from a block comment', async () => {
    const css = '/* .comment-class { color: red; } */\n.actual-class { color: blue; }';
    const adapter = LanguageRegistry.getInstance().getAdapterForFile('test.css')!;
    const ast = await adapter.parse('test.css', css);
    const classes = extractClassUsageFromCSSAst(ast, adapter, 'test.css');
    const names = classes.map((c: { className: string }) => c.className);
    expect(names).toContain('actual-class');
    expect(names).not.toContain('comment-class');
  });
});
