/**
 * CLI integration — the `code-audit telemetry` subcommand (Spec: rule-request
 * intake and telemetry opt-in).
 *
 * Exercises the real `telemetry status|enable|disable` subcommands against a
 * throwaway config dir (XDG_CONFIG_HOME), so the test never touches the
 * developer's real user config. This proves the subcommands are wired to the
 * same opt-in functions as the MCP tool and that enable/status/disable
 * round-trip through the on-disk opt-in file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { rmSync, accessSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { DEFAULT_TELEMETRY_ENDPOINT } from './installConfig.js';

const CLI_SCRIPT = join(__dirname, 'cli.ts');

/** Prefer the built CLI; fall back to tsx (dev) so tests run pre-build too. */
function cliCommand(args: string): string {
  const distCli = join(__dirname, '..', 'dist', 'cli.js');
  try {
    accessSync(distCli);
    return `node "${distCli}" ${args}`;
  } catch {
    return `npx tsx "${CLI_SCRIPT}" ${args}`;
  }
}

/** Run the CLI with the opt-in config scoped to a temp dir. */
function run(args: string, configHome: string): { stdout: string; stderr: string; exitCode: number } {
  const cmd = cliCommand(args);
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status || 1 };
  }
}

function jsonOf(res: { stdout: string }): any {
  return JSON.parse(res.stdout);
}

describe('code-audit telemetry subcommand', () => {
  let configHome: string;

  beforeEach(async () => {
    configHome = await mkdtemp(join(tmpdir(), 'ca-tele-cli-'));
  });

  afterEach(() => {
    try { rmSync(configHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('status is disabled by default (off, no install ID)', () => {
    const res = run('telemetry status --json', configHome);
    expect(res.exitCode).toBe(0);
    const s = jsonOf(res);
    expect(s.enabled).toBe(false);
    expect(s.installId).toBeNull();
  });

  it('enable → status enabled with default endpoint → disable → status disabled', () => {
    const en = run('telemetry enable --json', configHome);
    expect(en.exitCode).toBe(0);
    const enabled = jsonOf(en);
    expect(enabled.enabled).toBe(true);
    expect(enabled.endpoint).toBe(DEFAULT_TELEMETRY_ENDPOINT);
    expect(enabled.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const st = run('telemetry status --json', configHome);
    expect(st.exitCode).toBe(0);
    expect(jsonOf(st).enabled).toBe(true);

    const di = run('telemetry disable --json', configHome);
    expect(di.exitCode).toBe(0);
    expect(jsonOf(di).enabled).toBe(false);

    const st2 = run('telemetry status --json', configHome);
    expect(st2.exitCode).toBe(0);
    expect(jsonOf(st2).enabled).toBe(false);
  });

  it('enable --endpoint rejects a non-https URL and exits non-zero', () => {
    const res = run('telemetry enable --endpoint http://localhost:8787/ingest --json', configHome);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/https/);
  });

  it('dismiss advertises the tri-state --telemetry/--no-telemetry flag (regression: commander does not auto-negate)', () => {
    const res = run('dismiss --help', configHome);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('--telemetry');
    expect(res.stdout).toContain('--no-telemetry');
  });
});
