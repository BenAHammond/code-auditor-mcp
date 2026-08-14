/**
 * Mixed-language fixture — Spec 33 Item 8 (Go support wiring).
 *
 * Locks in the guarantee that a `.go` file is NOT "traversed and handed to
 * nobody": the universal analyzers (solid, dry, data-access, react,
 * documentation) dispatch through the LanguageAdapter seam with no extension
 * restriction, so every parsed tuple — Go included — reaches them. The
 * guard here is two-fold:
 *
 *   1. `filesProcessed` must include the Go file for the universal visitors.
 *   2. The data-access analyzer must actually *analyze* Go — flagging a Go
 *      `db.Query("... '" + name + "'")` as sql-injection-risk, not silently
 *      counting the file and returning nothing.
 *
 * This test makes the "file handed to nobody" class of loss unshippable: if a
 * future edit scopes a universal visitor to `extensions: ['.ts', '.tsx']`, or
 * breaks the Go grammar load, this test fails.
 *
 * Integration suite — loads tree-sitter WASM; excluded from `npm run test`,
 * run with `npm run test:integration`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { initParsers, initializeLanguages } from '../../languages/index.js';
import { runAudit } from '../../auditRunner.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

/** Go fixture with a genuine SQL-injection shape: raw string + dynamic concatenation. */
const GO_SQL = `package main

import "database/sql"

func QueryUser(db *sql.DB, name string) {
	rows, _ := db.Query("SELECT * FROM users WHERE name = '" + name + "'")
	defer rows.Close()
	_ = rows
}
`;

/** TypeScript fixture with the same SQL-injection shape, as a same-run control. */
const TS_SQL = `import { db } from './db';
export async function getUser(id: string) {
  return await db.raw(\`SELECT * FROM users WHERE id = '\${id}'\`);
}
`;

describe('Spec 33 Item 8 — mixed-language fixture (Go + TS) wiring', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-mixedlang-'));
    await writeFile(join(testDir, 'query.go'), GO_SQL, 'utf-8');
    await writeFile(join(testDir, 'query.ts'), TS_SQL, 'utf-8');
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('dispatches the .go file to the universal analyzers (filesProcessed includes Go)', async () => {
    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['solid', 'dry', 'data-access', 'react', 'documentation'],
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    for (const analyzer of ['solid', 'dry', 'data-access', 'react', 'documentation']) {
      const status = result.analyzerResults[analyzer]?.status;
      expect(status, `${analyzer} must have a status`).toBeDefined();
      expect(status.status, `${analyzer} must run`).toBe('visitor-ran');
      const fp = status.status === 'visitor-ran' ? status.filesProcessed : 0;
      expect(
        fp,
        `${analyzer} must process both .go and .ts files (got ${fp}, expected 2)`,
      ).toBe(2);
    }
  });

  it('meaningfully analyzes Go — flags Go SQL injection, not just counting the file', async () => {
    const result = await runAudit({
      projectRoot: testDir,
      enabledAnalyzers: ['data-access'],
      indexFunctions: false,
      showProgress: false,
      scope: 'all',
    });

    const violations = result.analyzerResults['data-access']?.violations ?? [];
    const goSqlInjection = violations.filter(
      (v) => v.rule === 'sql-injection-risk' && v.file.endsWith('query.go'),
    );

    expect(
      goSqlInjection.length,
      'Go db.Query("...\'" + name + "\'") must be flagged as sql-injection-risk',
    ).toBeGreaterThan(0);
  });
});
