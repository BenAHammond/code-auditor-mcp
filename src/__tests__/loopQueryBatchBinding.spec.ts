/**
 * §13.2 — loop-query per-batch-binding discriminator.
 *
 * A DB call inside a loop whose bound parameters are a *spread of a
 * collection-derived expression* (`ids.slice(…)`, `rows.map(…)`, `chunkArray(…)`)
 * executes one statement per batch, not per row — a chunked `id IN (…)` write is
 * not an N+1 at any chunk size. Only a scalar or property read off a single loop
 * element (`run(row.id)`, `run(row.id, row.name)`) is per-row.
 *
 * The discriminator is structural, not a chunk-size test: `999` / SQLite's bind
 * limit never appears in it. It suppresses when the bound parameter is a spread
 * (or mapped array) derived from a slice/splice/map/chunk of the iterated set,
 * and keeps firing when the bound parameter is a scalar off one element — or a
 * chunked loop that re-loops over each chunk and binds per element.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
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
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-loop-batch-'));
}, 30_000);

async function loopQueryViolations(code: string, name: string): Promise<any[]> {
  const filePath = join(tmpDir, `${name}.ts`);
  await writeFile(filePath, code, 'utf-8');
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  const vs = (await (analyzer as any).analyzeAST(ast, tsAdapter, { ...DEFAULT_DATA_ACCESS_CONFIG, dialect: 'sqlite' }, sourceCode)) as any[];
  return vs.filter((v) => v.rule === 'loop-query');
}

describe('loop-query per-batch binding discriminator', () => {
  it('suppresses a chunked IN(…) delete whose .run(...chunk) spreads a slice', async () => {
    const code = `const db: D1Database = getDb();

function removeStale(ids: number[]) {
  for (let i = 0; i < ids.length; i += 999) {
    const chunk = ids.slice(i, i + 999);
    const placeholders = chunk.map(() => '?').join(', ');
    db.prepare(\`DELETE FROM t WHERE id IN (\${placeholders})\`).run(...chunk);
  }
}
`;
    expect((await loopQueryViolations(code, 'chunked-in-slice')).length).toBe(0);
  });

  it('suppresses the same chunked delete when the chunk comes from a named helper', async () => {
    const code = `const db: D1Database = getDb();

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function removeStale(ids: number[]) {
  for (const chunk of chunkArray(ids, 999)) {
    const placeholders = chunk.map(() => '?').join(', ');
    db.prepare(\`DELETE FROM t WHERE id IN (\${placeholders})\`).run(...chunk);
  }
}
`;
    expect((await loopQueryViolations(code, 'chunked-in-helper')).length).toBe(0);
  });

  it('suppresses a batch insert that binds a mapped array', async () => {
    const code = `const db: D1Database = getDb();

function insert(groups: Array<Array<{ id: number }>>) {
  for (const group of groups) {
    db.prepare('INSERT INTO t (id) VALUES (?)').run(...group.map((r) => r.id));
  }
}
`;
    expect((await loopQueryViolations(code, 'mapped-array-batch')).length).toBe(0);
  });

  it('still fires run(e.id) per element', async () => {
    const code = `const db: D1Database = getDb();

function update(rows: Array<{ id: number }>) {
  for (const e of rows) {
    db.prepare('UPDATE t SET x = 1 WHERE id = ?').run(e.id);
  }
}
`;
    expect((await loopQueryViolations(code, 'per-element-id')).length).toBeGreaterThanOrEqual(1);
  });

  it('still fires run(row.id, row.name) per element', async () => {
    const code = `const db: D1Database = getDb();

function insert(rows: Array<{ id: number; name: string }>) {
  for (const row of rows) {
    db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').run(row.id, row.name);
  }
}
`;
    expect((await loopQueryViolations(code, 'per-element-two-scalars')).length).toBeGreaterThanOrEqual(1);
  });

  it('still fires a chunked loop that re-loops over each chunk binding per element', async () => {
    const code = `const db: D1Database = getDb();

function removeStale(ids: number[]) {
  for (let i = 0; i < ids.length; i += 999) {
    const chunk = ids.slice(i, i + 999);
    for (const id of chunk) {
      db.prepare('DELETE FROM t WHERE id = ?').run(id);
    }
  }
}
`;
    expect((await loopQueryViolations(code, 'chunked-then-per-element')).length).toBeGreaterThanOrEqual(1);
  });

  it('still fires a spread of the loop element over a plain collection', async () => {
    // Spreading the element of a plain array (`…row`) is one write per row, not a
    // batch — the element is a single row's values, not a sub-collection.
    const code = `const db: D1Database = getDb();

function insert(rows: Array<[number, string]>) {
  for (const row of rows) {
    db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').run(...row);
  }
}
`;
    expect((await loopQueryViolations(code, 'spread-of-element')).length).toBeGreaterThanOrEqual(1);
  });
});
