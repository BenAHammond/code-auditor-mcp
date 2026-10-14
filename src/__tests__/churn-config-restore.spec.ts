/**
 * Spec 13 R1 — `churn` config-key orphan restore (config-sweep follow-up).
 *
 * The sweep deleted the top-level `churn` key because it had "no runtime
 * consumer" — but that was the wrong diagnosis. The consumer exists: churn
 * extraction (`extractChurn`) runs on every index sync (`deepSync`) and in the
 * CLI `hotspots` command, and both called it with a hardcoded
 * `{ churnWindowMonths: 12 }`. The literal was the orphan; the key was meant to
 * feed it. Deleting the key made the hardcode permanent and removed the knob.
 *
 * This pins three things:
 *   1. `DEFAULT_CHURN_CONFIG` is the single source of the `12` (referenced, not
 *      re-declared, by `getDefaultConfig()` and `extractChurn`).
 *   2. `churn` survives `.codeauditor.json` sanitization again (it is back in
 *      `PROJECT_FILE_CONFIG_KEYS`), so a user's window reaches `loadConfig`.
 *   3. The window actually flows into extraction — `churn_hash` changes when the
 *      configured `churnWindowMonths` changes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { loadConfig } from '../config/configLoader.js';
import { getDefaultConfig, DEFAULT_CHURN_CONFIG } from '../config/defaults.js';
import { extractChurn } from '../churn/churnExtractor.js';
import { CodeIndexDB } from '../codeIndexDB.js';

const scratchDirs: string[] = [];

afterEach(() => {
  CodeIndexDB.resetInstance();
});

describe('churn config-key restore', () => {
  it('DEFAULT_CHURN_CONFIG is the single default, referenced (not re-declared) by getDefaultConfig', () => {
    expect(DEFAULT_CHURN_CONFIG.churnWindowMonths).toBe(12);
    // The top-level default must be the *same* object, so a consumer that reads
    // `config.churn` and falls back to DEFAULT_CHURN_CONFIG is not falling back
    // onto a divergent copy.
    expect(getDefaultConfig().churn).toBe(DEFAULT_CHURN_CONFIG);
  });

  it('churn survives .codeauditor.json sanitization (key back in PROJECT_FILE_CONFIG_KEYS)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-churn-config-'));
    scratchDirs.push(dir);
    const configPath = join(dir, '.codeauditor.json');
    await writeFile(configPath, JSON.stringify({ churn: { churnWindowMonths: 24 } }));

    const { config, rejected } = await loadConfig({ configPath, projectRoot: dir });

    expect(config.churn?.churnWindowMonths).toBe(24);
    expect(rejected.find((r) => r.key === 'churn')).toBeUndefined();
  });

  it('the configured window flows into extraction (churn_hash changes with churnWindowMonths)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-churn-repo-'));
    scratchDirs.push(dir);

    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
    await writeFile(join(dir, 'seed.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', 'seed.ts'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

    const db = CodeIndexDB.getInstance(':memory:');
    await db.initialize();

    const readHash = () =>
      (db.rawDb.prepare("SELECT value FROM meta WHERE key = 'churn_hash'").get() as
        | { value: string }
        | undefined)?.value;

    extractChurn(db.rawDb, dir, { churnWindowMonths: 6 });
    const sixMonthHash = readHash();
    expect(sixMonthHash).toMatch(/\|6$/);

    extractChurn(db.rawDb, dir, { churnWindowMonths: 24 });
    const twentyFourMonthHash = readHash();
    expect(twentyFourMonthHash).toMatch(/\|24$/);

    // The window is part of the cache key, so a different window re-extracts.
    expect(twentyFourMonthHash).not.toBe(sixMonthHash);
  });
});
