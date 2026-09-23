/**
 * Structural guard — a scoped (changed-file) audit never reads the whole
 * `functions` table.
 *
 * The single-file `changed` hook path (`code-audit changed --stdin`) is meant to
 * be O(changed files), not O(project). The one caller that broke that contract
 * was scoped-DRY: `getAllFunctionsForDry()` loaded every function body on every
 * single-file run to power a cross-file `dry/duplicate` comparison that could
 * never match (the index stored `statement_block` while the analyzer hashed the
 * full function node — a producer/consumer mismatch). The load was deleted; this
 * test is the guard that keeps it deleted.
 *
 * The assertion is on the SQL, not the clock. We spy on the SQLite `prepare` /
 * `exec` seam, run a real scoped audit against the in-memory singleton, and
 * assert no SELECT over `functions` lacks a WHERE clause. A reintroduced
 * whole-table load fails this test deterministically, where a latency budget
 * would only wobble.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAudit } from '../auditRunner.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { initializeLanguages, initParsers } from '../languages/index.js';

const scratchDirs: string[] = [];

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

afterEach(async () => {
  CodeIndexDB.resetInstance();
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ca-scoped-no-whole-table-'));
  scratchDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf-8');
  }
  return dir;
}

/**
 * True when `sql` is a SELECT that reads the base `functions` table (not
 * `functions_fts`) with no WHERE narrowing it — i.e. a whole-table read.
 *
 * A `LIMIT 1` existence probe (`tableHasRows`) is excluded: it materialises at
 * most one row, so it is not the O(project) load this guard exists to prevent.
 */
function isWholeTableFunctionsRead(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
  if (!normalized.startsWith('SELECT')) return false;
  if (!/FROM\s+FUNCTIONS(?:\s|$)/.test(normalized)) return false;
  if (/\bLIMIT\s+1\b/.test(normalized)) return false;
  return !/\bWHERE\b/.test(normalized);
}

/** Wrap the DB's prepare/exec seam to record every SQL string it sees. */
function captureSql(db: CodeIndexDB): { sql: string[]; restore: () => void } {
  const raw = db.rawDb as unknown as {
    prepare: (sql: string) => unknown;
    exec: (sql: string) => unknown;
  };
  const sql: string[] = [];
  const origPrepare = raw.prepare.bind(raw);
  const origExec = raw.exec.bind(raw);
  raw.prepare = (s: string) => {
    sql.push(s);
    return origPrepare(s);
  };
  raw.exec = (s: string) => {
    sql.push(s);
    return origExec(s);
  };
  return { sql, restore: () => { raw.prepare = origPrepare; raw.exec = origExec; } };
}

describe('scoped audit issues no whole-table functions read', () => {
  it('changed-file audit narrows every functions read by WHERE', async () => {
    const dir = await scratch({
      'src/a.ts': 'export function alpha() {\n  const x = 1;\n  return x;\n}\n',
      'src/b.ts': 'export function beta() {\n  const y = 2;\n  return y;\n}\n',
    });

    // Open the in-memory singleton the runner will reuse: `:memory:` is the test
    // escape hatch in `getInstance` that survives a projectRoot mismatch, so the
    // runner's `getInstance(undefined, projectRoot)` returns this same instance.
    CodeIndexDB.resetInstance();
    const db = CodeIndexDB.getInstance(':memory:', dir);
    await db.initialize();

    const { sql, restore } = captureSql(db);

    // Scoped single-file audit, mirroring the hook path (`changed --stdin`).
    // `explicitFiles` avoids `detectModifiedFiles` (a legitimate O(project)
    // *discovery* read) and pins the audit to the one changed file.
    await runAudit({
      projectRoot: dir,
      scope: 'changed',
      explicitFiles: [join(dir, 'src', 'a.ts')],
      enabledAnalyzers: ['dry'],
      showProgress: false,
      writeToLedger: false,
    });

    restore();

    // Sanity — the spy actually saw the scoped path touch the functions table
    // (detectChangedFunctions reads it by file_path), so a green assertion is a
    // real observation, not an empty capture.
    expect(sql.some((s) => /FROM\s+FUNCTIONS/i.test(s))).toBe(true);

    const wholeTableReads = sql.filter(isWholeTableFunctionsRead);
    expect(wholeTableReads).toEqual([]);
  });
});
