/**
 * Spec 50 R2 — project lint config as the authoritative size-threshold source.
 *
 * Fix contract for `readProjectLintThresholds` + its merge path:
 *
 *   - **positive**  — a project ESLint config declaring `max-params` / `complexity`
 *     maps to the code-auditor threshold, and the mapped value is authoritative
 *     over the default.
 *   - **near-miss** — a config with only unrelated rules leaves every threshold
 *     at its default (source `default`).
 *   - **guard**     — `.codeauditor.json` `analyzerConfigs` wins over the lint
 *     config (source `project-config`).
 *   - **absence**   — no config file at all is not an error; defaults.
 *
 * The unit block exercises the reader in isolation (flat + legacy, value
 * shapes, unmapped rules, fail-open). The integration block runs the real
 * `runAudit` entry point and asserts `metadata.thresholdSources` names the
 * source of each size threshold, and that a signature just over the lint
 * threshold fires while one at/under it does not.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectLintThresholds, thresholdsToAnalyzerConfig } from './lintConfigReader.js';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { runAudit } from '../auditRunner.js';

/** A TS function with exactly `count` number parameters. */
function paramsSource(count: number): string {
  const ps = Array.from({ length: count }, (_, i) => `p${i}: number`).join(', ');
  const voids = Array.from({ length: count }, (_, i) => `void p${i};`).join(' ');
  return `export function f(${ps}): void { ${voids} }\n`;
}

/** Collect every `parameter-count` violation across the run's analyzer results. */
function parameterCountViolations(result: any): any[] {
  const all = Object.values(result.analyzerResults ?? {}).flatMap(
    (r: any) => r.violations ?? [],
  );
  return all.filter((v: any) => v.rule === 'parameter-count');
}

// ---------------------------------------------------------------------------
// Unit — the reader in isolation
// ---------------------------------------------------------------------------

describe('readProjectLintThresholds (unit)', () => {
  let dirs: string[] = [];
  const scratch = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-lint-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content, 'utf-8');
    }
    return dir;
  };

  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs = [];
  });

  it('absence — returns null when no lint config file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-lint-none-'));
    dirs.push(dir);
    expect(await readProjectLintThresholds(dir)).toBeNull();
  });

  it('positive (flat) — eslint.config.mjs max-params maps to solid.maxParametersPerMethod', async () => {
    const dir = await scratch({
      'eslint.config.mjs': `export default [{ rules: { 'max-params': 6 } }];\n`,
    });
    const result = await readProjectLintThresholds(dir);
    expect(result?.configKind).toBe('flat');
    expect(result?.configPath).toBe(join(dir, 'eslint.config.mjs'));
    expect(result?.thresholds).toEqual({ 'solid.maxParametersPerMethod': 6 });
  });

  it('positive (legacy) — .eslintrc.json complexity maps to solid.maxMethodComplexity', async () => {
    const dir = await scratch({
      '.eslintrc.json': JSON.stringify({ rules: { complexity: 20 } }),
    });
    const result = await readProjectLintThresholds(dir);
    expect(result?.configKind).toBe('legacy');
    expect(result?.thresholds).toEqual({ 'solid.maxMethodComplexity': 20 });
  });

  it('value shapes — ["error", N], ["warn", {max:N}], and {max:N} all parse to a number', async () => {
    const dir = await scratch({
      '.eslintrc.json': JSON.stringify({
        rules: {
          'max-params': ['error', 4],
          'max-lines-per-function': ['warn', { max: 80 }],
          complexity: { max: 12 },
        },
      }),
    });
    const result = await readProjectLintThresholds(dir);
    expect(result?.thresholds).toEqual({
      'solid.maxParametersPerMethod': 4,
      'solid.maxLinesPerMethod': 80,
      'solid.maxMethodComplexity': 12,
    });
  });

  it('value shapes — "off" string disables a mapped rule (treated as absent)', async () => {
    const dir = await scratch({
      '.eslintrc.json': JSON.stringify({ rules: { 'max-params': 'off' } }),
    });
    const result = await readProjectLintThresholds(dir);
    expect(result?.thresholds).toEqual({});
  });

  it('near-miss — unrelated rules leave every threshold empty', async () => {
    const dir = await scratch({
      '.eslintrc.json': JSON.stringify({ rules: { 'no-unused-vars': ['error'] } }),
    });
    const result = await readProjectLintThresholds(dir);
    expect(result?.thresholds).toEqual({});
    expect(result?.recognizedUnmapped).toEqual([]);
  });

  it('recognized-but-unmapped — max-depth / max-statements surface for transparency', async () => {
    const dir = await scratch({
      '.eslintrc.json': JSON.stringify({
        rules: { 'max-depth': ['error', 4], 'max-statements': 10 },
      }),
    });
    const result = await readProjectLintThresholds(dir);
    expect(result?.thresholds).toEqual({});
    expect(result?.recognizedUnmapped).toEqual([
      { rule: 'max-depth', value: ['error', 4] },
      { rule: 'max-statements', value: 10 },
    ]);
  });

  it('thresholdsToAnalyzerConfig groups dot-notation keys by namespace', () => {
    expect(
      thresholdsToAnalyzerConfig({
        'solid.maxLinesPerMethod': 200,
        'solid.maxParametersPerMethod': 6,
      }),
    ).toEqual({
      solid: { maxLinesPerMethod: 200, maxParametersPerMethod: 6 },
    });
  });
});

// ---------------------------------------------------------------------------
// Integration — through runAudit, asserting thresholdSources + effective value
// ---------------------------------------------------------------------------

describe('lint config as threshold authority (integration)', () => {
  let dirs: string[] = [];

  beforeAll(async () => {
    initializeLanguages();
    await initParsers();
  }, 30_000);

  const scratch = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-lint-it-'));
    dirs.push(dir);
    await mkdir(join(dir, 'src'), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content, 'utf-8');
    }
    return dir;
  };

  afterEach(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    dirs = [];
  });

  it('positive — lint max-params: 3 beats the default 6; a 4-param fn fires, a 3-param does not', async () => {
    const dir = await scratch({
      '.eslintrc.json': JSON.stringify({ rules: { 'max-params': 3 } }),
      'src/f.ts': paramsSource(4),
    });

    const result = await runAudit({
      projectRoot: dir,
      enabledAnalyzers: ['solid'],
      showProgress: false,
    });

    const source = (result.metadata.thresholdSources ?? []).find(
      (t: any) => t.key === 'solid.maxParametersPerMethod',
    );
    expect(source).toBeDefined();
    expect(source.source).toBe('project-lint-config');
    expect(source.value).toBe(3);
    expect(source.defaultValue).toBe(6);

    // 4 params > 3 → fires, proving the lint value (not the default 6) is live.
    expect(parameterCountViolations(result).length).toBeGreaterThanOrEqual(1);
  });

  it('near-miss — unrelated rules leave the threshold at default (source `default`)', async () => {
    const dir = await scratch({
      '.eslintrc.json': JSON.stringify({ rules: { 'no-unused-vars': ['error'] } }),
      'src/f.ts': paramsSource(4),
    });

    const result = await runAudit({
      projectRoot: dir,
      enabledAnalyzers: ['solid'],
      showProgress: false,
    });

    const source = (result.metadata.thresholdSources ?? []).find(
      (t: any) => t.key === 'solid.maxParametersPerMethod',
    );
    expect(source?.source).toBe('default');
    expect(source?.value).toBe(6);
    // 4 params ≤ 6 → does not fire under the default.
    expect(parameterCountViolations(result)).toHaveLength(0);
  });

  it('guard — .codeauditor.json wins over lint; source `project-config`, lint value ignored', async () => {
    const dir = await scratch({
      '.eslintrc.json': JSON.stringify({ rules: { 'max-params': 3 } }),
      '.codeauditor.json': JSON.stringify({
        analyzerConfigs: { solid: { maxParametersPerMethod: 10 } },
        rationales: { 'solid.maxParametersPerMethod': 'Project opts for options objects above 10.' },
      }),
      'src/f.ts': paramsSource(4),
    });

    const result = await runAudit({
      projectRoot: dir,
      enabledAnalyzers: ['solid'],
      showProgress: false,
    });

    const source = (result.metadata.thresholdSources ?? []).find(
      (t: any) => t.key === 'solid.maxParametersPerMethod',
    );
    expect(source?.source).toBe('project-config');
    expect(source?.value).toBe(10);
    // 4 params ≤ 10 → does not fire, proving the project config (not lint's 3) won.
    expect(parameterCountViolations(result)).toHaveLength(0);
  });

  it('absence — no lint config and no .codeauditor.json → defaults, no error', async () => {
    const dir = await scratch({
      'src/f.ts': paramsSource(4),
    });

    const result = await runAudit({
      projectRoot: dir,
      enabledAnalyzers: ['solid'],
      showProgress: false,
    });

    const source = (result.metadata.thresholdSources ?? []).find(
      (t: any) => t.key === 'solid.maxParametersPerMethod',
    );
    expect(source?.source).toBe('default');
    expect(source?.value).toBe(6);
    expect(parameterCountViolations(result)).toHaveLength(0);
  });
});
