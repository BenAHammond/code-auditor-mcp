/**
 * Spec 71 R7 (fail-open shape) — an index written by a *newer* code-auditor
 * (schema_version above this build's) must not crash the audit. The index layer
 * throws a `ContextualError` naming both versions; the runner must catch it,
 * continue without index-backed facts, and report the skip as a coverage
 * diagnostic — the exit code stays what it would have been, never a fatal.
 *
 * This is the hook-path guarantee in test form: `runAudit` on a `changed` scope
 * with explicit files mirrors `code-audit changed --stdin --json` (the hook's
 * command). A regression that re-raises the index failure would make this throw
 * instead of resolving with the `engine-error` diagnostic.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAudit } from '../auditRunner.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { openSqlite } from '../sqlite/driver.js';
import { resolvePersistedIndexPath } from '../dataPaths.js';
import { initializeLanguages, initParsers } from '../languages/index.js';

const scratchDirs: string[] = [];
const prevDataDir = process.env.CODE_AUDITOR_DATA_DIR;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

afterEach(async () => {
  CodeIndexDB.resetInstance();
  process.env.CODE_AUDITOR_DATA_DIR = prevDataDir;
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('higher-schema-version index fails open', () => {
  it('completes a changed-scope audit with a coverage diagnostic, not a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-higher-index-'));
    scratchDirs.push(dir);
    await mkdir(join(dir, 'src'), { recursive: true });
    const file = join(dir, 'src', 'a.ts');
    await writeFile(file, 'export const x = 1;\n', 'utf-8');

    const dataDir = await mkdtemp(join(tmpdir(), 'ca-higher-index-data-'));
    scratchDirs.push(dataDir);
    process.env.CODE_AUDITOR_DATA_DIR = dataDir;

    // Build a real index at the current version, then bump its schema_version as
    // a newer build would have left it.
    CodeIndexDB.resetInstance();
    const idx = CodeIndexDB.getInstance(undefined, dir);
    await idx.initialize();
    await idx.close();
    const raw = openSqlite(resolvePersistedIndexPath(dir), { timeoutMs: 30_000 });
    raw.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    raw.close();

    // The runner must open the bumped index fresh (not reuse the closed instance).
    CodeIndexDB.resetInstance();

    // Must NOT throw — the index failure is caught and reported, not fatal.
    const result = await runAudit({
      projectRoot: dir,
      scope: 'changed',
      explicitFiles: [file],
      showProgress: false,
      writeToLedger: false,
    });

    const diagnostics = result.metadata?.diagnostics ?? [];
    const skip = diagnostics.find(
      (d) => d.kind === 'engine-error' && d.analyzerName === 'code-index',
    );
    expect(skip).toBeTruthy();
    expect(skip!.message).toMatch(/newer than this build supports \(19\)/);
  });
});
