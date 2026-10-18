/**
 * Single-source the env-only tunables (env-tunable sweep follow-up).
 *
 * The sweep concluded none of the eleven machine/process-scoped tunables belong
 * in `.codeauditor.json` — env is the correct surface. But it exposed a shape we
 * had been removing all week, twice over: `loadFromEnvironment` was a whole
 * env-mapping mechanism with no caller (orphan), and four of the eleven were
 * read at two sites each with their own parse and default — the duplicated `70`
 * pattern in four places (`JOB_LEASE_TTL_MS`, `RULE_TIMING`, `SQLITE_BACKEND`,
 * `MCP_UI_PORT`).
 *
 * Each variable now has one named accessor that is the single place that reads
 * `process.env`, validates, and supplies a default; every consumer calls it.
 * This pins two things per variable:
 *   1. The accessor's parse/default behavior (functional).
 *   2. That the consumers reference the accessor, not their own copy
 *      (structural — read the source, since the consumers are spread across
 *      cli.ts / driver.ts / mcp-ui-simple.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRuleTimingEnabled } from '../analyzers/ruleTiming.js';
import { sqliteBackendOverride, isSqliteBackend } from '../sqlite/driver.js';
import { mcpUiPort, DEFAULT_MCP_UI_PORT } from '../mcp-ui-simple.js';
import { dataDirEnv } from '../dataPaths.js';
import { jobLeaseTtlMs } from '../mcpAuditJobs.js';
import { gateBudgetResolutions, DEFAULT_GATE_BUDGET_RESOLUTIONS } from '../config/defaults.js';

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf-8');

const ENV_KEYS = [
  'CODE_AUDITOR_JOB_LEASE_TTL_MS',
  'CODE_AUDITOR_RULE_TIMING',
  'CODE_AUDITOR_SQLITE_BACKEND',
  'MCP_UI_PORT',
  'CODE_AUDITOR_DATA_DIR',
  'CODE_AUDITOR_GATE_BUDGET_RESOLUTIONS',
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeEach(clearEnv);
afterEach(clearEnv);

describe('env-tunable single-source — parse/default behavior', () => {
  it('jobLeaseTtlMs: default 30s, positive override honored, non-positive rejected', () => {
    expect(jobLeaseTtlMs()).toBe(30_000);

    process.env.CODE_AUDITOR_JOB_LEASE_TTL_MS = '45000';
    expect(jobLeaseTtlMs()).toBe(45_000);

    // The write path's parse is strict: a negative/Infinity/NaN/zero value is
    // "not set", not an absurd TTL. (The old cli.ts mirror was `Number(...) || 30_000`,
    // which accepted a negative TTL — the live bug this single-sourcing removed.)
    for (const bad of ['-5', 'Infinity', 'NaN', '0', 'not-a-number']) {
      process.env.CODE_AUDITOR_JOB_LEASE_TTL_MS = bad;
      expect(jobLeaseTtlMs()).toBe(30_000);
    }
  });

  it('isRuleTimingEnabled: off by default, on only for the exact "1"', () => {
    expect(isRuleTimingEnabled()).toBe(false);

    process.env.CODE_AUDITOR_RULE_TIMING = '1';
    expect(isRuleTimingEnabled()).toBe(true);

    // The sibling spellings a human might reach for are NOT accepted — the
    // contract is `=== '1'`, matching the other boolean tunables' `'1'` gate.
    for (const off of ['0', 'true', 'yes', '']) {
      process.env.CODE_AUDITOR_RULE_TIMING = off;
      expect(isRuleTimingEnabled()).toBe(false);
    }
  });

  it('sqliteBackendOverride + isSqliteBackend: raw passthrough, whitelist lives in one guard', () => {
    expect(sqliteBackendOverride()).toBeUndefined();

    process.env.CODE_AUDITOR_SQLITE_BACKEND = 'better-sqlite3';
    expect(sqliteBackendOverride()).toBe('better-sqlite3');
    expect(isSqliteBackend(sqliteBackendOverride())).toBe(true);

    for (const v of ['node-sqlite', 'better-sqlite3']) expect(isSqliteBackend(v)).toBe(true);
    for (const v of [undefined, 'node:sqlite', 'sqlite', 'BETTER-SQLITE3']) {
      expect(isSqliteBackend(v)).toBe(false);
    }
  });

  it('mcpUiPort: single default 3001, valid override honored, invalid falls back', () => {
    expect(DEFAULT_MCP_UI_PORT).toBe(3001);
    expect(mcpUiPort()).toBe(3001);

    process.env.MCP_UI_PORT = '4321';
    expect(mcpUiPort()).toBe(4321);

    for (const bad of ['', '0', 'not-a-port']) {
      process.env.MCP_UI_PORT = bad;
      expect(mcpUiPort()).toBe(3001);
    }
  });

  it('dataDirEnv: trimmed, blank normalizes to undefined', () => {
    expect(dataDirEnv()).toBeUndefined();

    process.env.CODE_AUDITOR_DATA_DIR = '/tmp/ca-data';
    expect(dataDirEnv()).toBe('/tmp/ca-data');

    process.env.CODE_AUDITOR_DATA_DIR = '   ';
    expect(dataDirEnv()).toBeUndefined();
  });

  it('gateBudgetResolutions: default, positive override honored, 0 is the liveness knob (not unset)', () => {
    expect(gateBudgetResolutions()).toBe(DEFAULT_GATE_BUDGET_RESOLUTIONS);

    process.env.CODE_AUDITOR_GATE_BUDGET_RESOLUTIONS = '40';
    expect(gateBudgetResolutions()).toBe(40);

    // 0 is a *valid* override — it means "always fail", which the gate-liveness
    // test relies on. Unlike jobLeaseTtlMs (where 0 = "not set"), 0 is honored.
    process.env.CODE_AUDITOR_GATE_BUDGET_RESOLUTIONS = '0';
    expect(gateBudgetResolutions()).toBe(0);

    // Negative / non-numeric / empty falls back to the default rather than
    // tripping the gate on a nonsense budget.
    for (const bad of ['-5', 'Infinity', 'NaN', 'not-a-number', '']) {
      process.env.CODE_AUDITOR_GATE_BUDGET_RESOLUTIONS = bad;
      expect(gateBudgetResolutions()).toBe(DEFAULT_GATE_BUDGET_RESOLUTIONS);
    }
  });
});

describe('env-tunable single-source — consumers reference the accessor, not their own copy', () => {
  const cli = read('cli.ts');
  const driver = read('sqlite/driver.ts');
  const ui = read('mcp-ui-simple.ts');
  const jobs = read('mcpAuditJobs.ts');

  it('cli.ts has no own mirror of the four two-site variables', () => {
    // The duplicated-`70` shape: cli.ts used to carry its own
    // `CLI_JOB_LEASE_TTL_MS = Number(...) || 30_000` and its own
    // `process.env.CODE_AUDIT_RULE_TIMING === '1'` gate. Both are gone.
    expect(cli).not.toContain('CLI_JOB_LEASE_TTL_MS');
    expect(cli).not.toContain('process.env.CODE_AUDITOR_JOB_LEASE_TTL_MS');
    expect(cli).not.toContain('CODE_AUDIT_RULE_TIMING');
    expect(cli).not.toContain('process.env.CODE_AUDITOR_SQLITE_BACKEND');
    expect(cli).not.toContain('process.env.MCP_UI_PORT');
  });

  it('cli.ts reads the gate budget through the single accessor, not its own env copy', () => {
    // Directive J: the budget is single-sourced in config/defaults.ts; cli.ts imports
    // gateBudgetResolutions() and never reads the env var (or a hardcoded literal)
    // itself — the "budget 400 ms" hardcode this replaced is the exact shape this
    // test exists to prevent.
    expect(cli).toContain('gateBudgetResolutions');
    expect(cli).toContain("from './config/defaults.js'");
    expect(cli).not.toContain('process.env.CODE_AUDITOR_GATE_BUDGET_RESOLUTIONS');
    expect(cli).not.toContain('budget 400 ms');
  });

  it('cli.ts routes both reclaim sites and the timing gate through the shared accessors', () => {
    // status + jobs actions both `await import('./mcpAuditJobs.js')` and call
    // jobLeaseTtlMs(); the timing gate imports isRuleTimingEnabled.
    expect(cli).toContain("import('./mcpAuditJobs.js')");
    expect(cli).toContain('jobLeaseTtlMs');
    expect(cli).toContain("isRuleTimingEnabled");
    expect(cli).toContain("from './analyzers/ruleTiming.js'");
  });

  it('driver.ts reads the SQLITE_BACKEND override in exactly one place, consumed by both surfaces', () => {
    const reads = driver.match(/process\.env\.CODE_AUDITOR_SQLITE_BACKEND/g) ?? [];
    expect(reads).toHaveLength(1); // inside sqliteBackendOverride() only
    // Both the report surface (describeSqliteBackend) and the enforcement
    // surface (openSqlite) consume the accessor.
    expect(driver).toContain('export function sqliteBackendOverride');
    expect(driver).toContain('const override = sqliteBackendOverride()');
  });

  it('mcp-ui-simple.ts reads MCP_UI_PORT in exactly one place, consumed by both sites', () => {
    const reads = ui.match(/process\.env\.MCP_UI_PORT/g) ?? [];
    expect(reads).toHaveLength(1); // inside mcpUiPort() only
    expect(ui).toContain('export function mcpUiPort');
    expect(ui).toContain('let serverPort = mcpUiPort()');
    expect(ui).toContain("opts?.port ?? mcpUiPort()");
  });

  it('mcpAuditJobs.ts exports jobLeaseTtlMs as the single lease-TTL source', () => {
    expect(jobs).toContain('export function jobLeaseTtlMs');
    // The write path has no other reader of the variable.
    const reads = jobs.match(/process\.env\.CODE_AUDITOR_JOB_LEASE_TTL_MS/g) ?? [];
    expect(reads).toHaveLength(1);
  });
});
