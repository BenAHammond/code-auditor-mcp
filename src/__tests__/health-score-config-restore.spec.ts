/**
 * Spec 11 sweep follow-up — `thresholds.minHealthScore` config-key restore.
 *
 * The sweep deleted the whole `thresholds` key because it had "no runtime
 * consumer" — but that grouped two different things. `maxSevere`/`maxCritical`/
 * `maxHigh` were the severity gate, which Spec 54 R3 replaced with "every finding
 * blocks" (vestigial — their removal stands). `minHealthScore` was the health
 * floor, which has a live consumer: the `audit.health` / `audit_health` MCP
 * tools' `threshold`, whose default is the literal `70` (single-sourced as
 * `DEFAULT_HEALTH_SCORE_THRESHOLD`). The key named that floor but was never wired
 * to it — the orphan pattern, not the vestigial one.
 *
 * This pins four things:
 *   1. `thresholds` is back in `PROJECT_FILE_CONFIG_KEYS`, so a project's
 *      `minHealthScore` survives `.codeauditor.json` sanitization.
 *   2. The default is referenced (not re-declared) — `getDefaultConfig().thresholds`
 *      carries `DEFAULT_HEALTH_SCORE_THRESHOLD`.
 *   3. `loadMinHealthScore` is the one place the MCP health tools read the config
 *      half of the floor, and it returns `undefined` when no config sets it.
 *   4. The severity-gate siblings are now a *visible error*, not a silent drop —
 *      a stale `maxSevere` in the restored `thresholds` object is rejected.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, loadMinHealthScore } from '../config/configLoader.js';
import { getDefaultConfig, DEFAULT_HEALTH_SCORE_THRESHOLD } from '../config/defaults.js';

const scratchDirs: string[] = [];

async function writeConfig(dir: string, body: unknown): Promise<string> {
  const configPath = join(dir, '.codeauditor.json');
  await writeFile(configPath, JSON.stringify(body));
  return configPath;
}

describe('health-score config-key restore', () => {
  it('the default thresholds object references the single constant, not a re-declared literal', () => {
    expect(getDefaultConfig().thresholds?.minHealthScore).toBe(DEFAULT_HEALTH_SCORE_THRESHOLD);
  });

  it('thresholds survives sanitization (key back in PROJECT_FILE_CONFIG_KEYS)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-health-config-'));
    scratchDirs.push(dir);
    const configPath = await writeConfig(dir, { thresholds: { minHealthScore: 82 } });

    const { config, rejected } = await loadConfig({ configPath, projectRoot: dir });

    expect(config.thresholds?.minHealthScore).toBe(82);
    expect(rejected.find((r) => r.key === 'thresholds')).toBeUndefined();
  });

  it('loadMinHealthScore reads the configured floor, or the default, or undefined with no config', async () => {
    const withConfig = await mkdtemp(join(tmpdir(), 'ca-health-set-'));
    scratchDirs.push(withConfig);
    await writeConfig(withConfig, { thresholds: { minHealthScore: 80 } });
    expect(await loadMinHealthScore(withConfig)).toBe(80);

    const noConfig = await mkdtemp(join(tmpdir(), 'ca-health-unset-'));
    scratchDirs.push(noConfig);
    expect(await loadMinHealthScore(noConfig)).toBeUndefined();

    // A config file that does not set `minHealthScore` yields the config default
    // (the loader merges `getDefaultConfig()`), which is the same constant the
    // final `resolveHealthThreshold` fallback would reach — so both paths agree.
    const absentKey = await mkdtemp(join(tmpdir(), 'ca-health-absent-'));
    scratchDirs.push(absentKey);
    await writeConfig(absentKey, { minSeverity: 'high' });
    expect(await loadMinHealthScore(absentKey)).toBe(DEFAULT_HEALTH_SCORE_THRESHOLD);
  });

  it('a stale severity-gate sibling inside thresholds is rejected, not silently ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-health-stale-'));
    scratchDirs.push(dir);
    const configPath = await writeConfig(dir, { thresholds: { maxSevere: 100, minHealthScore: 80 } });

    await expect(loadConfig({ configPath, projectRoot: dir })).rejects.toThrow(/maxSevere/);
  });

  it('an out-of-range minHealthScore is rejected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-health-range-'));
    scratchDirs.push(dir);
    const configPath = await writeConfig(dir, { thresholds: { minHealthScore: 101 } });

    await expect(loadConfig({ configPath, projectRoot: dir })).rejects.toThrow(/minHealthScore/);
  });
});
