/**
 * Spec 70 — release upgrade path.
 *
 * Two of the release's highest-consequence code paths touch user data on the
 * *upgrade* transition, which `verify:clean-install` (clean start) structurally
 * cannot exercise: (1) the LokiJS header sniff running on a pre-existing 4.x
 * SQLite index on first launch of 5.0.0, and (2) the LokiJS migration firing on
 * a genuine LokiJS-era index. Both are pinned against committed fixtures so they
 * are not untested forever.
 *
 * Fixtures under `src/__tests__/fixtures/upgrade/`:
 *   - `4.1.1-sqlite-index.db`  — a real index written by the published 4.1.1 CLI
 *     against a scratch project, then seeded with user-authored rows (a project
 *     task, an analyzer config, a whitelist entry). Its function body stores the
 *     literal JSON key `"collections":` within the first 64 KiB, exactly the
 *     substring a naive LokiJS sniff would mistake for an export.
 *   - `loki-era-index.db`      — a genuine `lokijs@1.5.12` export (`saveDatabase`)
 *     of the `projectTasks` / `analyzerConfigs` / `whitelist` collections.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, copyFile } from 'fs/promises';
import { rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { migrateFromLokiJS, isLokiJSHeader } from '../codeIndex/migrations.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { openSqlite } from '../sqlite/driver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_411 = join(__dirname, 'fixtures', 'upgrade', '4.1.1-sqlite-index.db');
const FIXTURE_LOKI = join(__dirname, 'fixtures', 'upgrade', 'loki-era-index.db');

describe('release upgrade path — LokiJS sniff vs. real 4.x index', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'code-auditor-upgrade-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies by the `{"filename":` prefix, not a `"collections":` substring', () => {
    // A genuine LokiJS export always begins with `{"filename":`.
    expect(isLokiJSHeader('{"filename":"index.db","collections":[{"name":"projectTasks","data":[]}]}')).toBe(true);

    // A real SQLite index begins with `SQLite format 3` (never `{"filename":`)
    // and may legitimately store `"collections":` inside a function body within
    // the first 64 KiB — that must never be misread as a LokiJS export.
    const sqliteHeaderWithCollections =
      'SQLite format 3' +
      'const marker = \'{"collections":[{"name":"projectTasks","data":[]}]}\';\n';
    expect(isLokiJSHeader(sqliteHeaderWithCollections)).toBe(false);

    // Whitespace / BOM-prefixed JSON is not a LokiJS export either (lokijs never
    // emits a BOM), so it falls through to the SQLite open path.
    expect(isLokiJSHeader('  {"filename":"index.db"}')).toBe(false);
    expect(isLokiJSHeader('')).toBe(false);
  });

  it('does not misclassify a real 4.1.1 SQLite index as LokiJS (sniff does not fire)', async () => {
    const dbPath = join(dir, 'index.db');
    await copyFile(FIXTURE_411, dbPath);

    // The fixture's function body contains `"collections":` within its first
    // 64 KiB, so a substring sniff would false-positive here and attempt a
    // migration. The prefix-only sniff must return "not LokiJS".
    const result = migrateFromLokiJS(dbPath);
    expect(result.migrated).toBe(false);
    expect(existsSync(dbPath + '.loki.bak')).toBe(false);

    // The index is opened as an existing SQLite index and schema-migrated in
    // place — not wiped, not LokiJS-migrated. User-authored rows survive the
    // 16 → 19 schema replay.
    const db = new CodeIndexDB(dbPath);
    await db.initialize();

    const tasks = await db.projectTasks.listProjectTasks('/test/proj');
    expect(tasks).toHaveLength(1);
    const task = tasks.find(t => t.taskId === 'task-1');
    expect(task).toBeTruthy();
    expect(task!.title).toBe('Fix login bug');
    expect(task!.labels).toEqual(['bug', 'frontend']);

    const config = await db.analyzerConfig.getAnalyzerConfig('solid', '/test/proj');
    expect(config).toEqual({ maxComplexity: 10 });

    const wl = await db.whitelist.getWhitelist();
    expect(wl.find(w => w.name === 'ignore-console')).toBeTruthy();

    expect(existsSync(dbPath + '.loki.bak')).toBe(false);
    await db.close();
  });

  it('still migrates a genuine LokiJS-era index', async () => {
    const dbPath = join(dir, 'index.db');
    await copyFile(FIXTURE_LOKI, dbPath);

    const db = new CodeIndexDB(dbPath);
    await db.initialize();

    // Migration fired: the old file was renamed aside and the data survived.
    expect(existsSync(dbPath + '.loki.bak')).toBe(true);

    const tasks = await db.projectTasks.listProjectTasks('/test/proj');
    expect(tasks).toHaveLength(2);
    expect(tasks.find(t => t.taskId === 'task-1')!.title).toBe('Fix login bug');

    const config = await db.analyzerConfig.getAnalyzerConfig('solid', '/test/proj');
    expect(config).toEqual({ maxComplexity: 10 });

    const wl = await db.whitelist.getWhitelist();
    expect(wl.find(w => w.name === 'ignore-console')).toBeTruthy();

    await db.close();
  });

  it('declines an index written by a newer build (future schema version) instead of corrupting it', async () => {
    // A future code-auditor writes schema_version above this build's. Opening it
    // here would run the DDL and re-stamp `schema_version` down, then fail later
    // with a cryptic column error — a silent downgrade of the user's index. The
    // guard must refuse it up front with a message naming both versions.
    const dbPath = join(dir, 'index.db');

    // Build a real index at the current version, then bump its stored version as
    // a newer build would have left it.
    const seed = new CodeIndexDB(dbPath);
    await seed.initialize();
    await seed.close();

    const raw = openSqlite(dbPath, { timeoutMs: 30_000 });
    raw.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    raw.close();

    const db = new CodeIndexDB(dbPath);
    await expect(db.initialize()).rejects.toThrow(
      /schema version 99 is newer than this build supports \(19\)/,
    );
  });
});
