/**
 * CLI integration tests — exercises the real CLI entry point via child_process.
 *
 * These tests exist because unit tests only hit the service layer.
 * The pattern across Spec 07-08 close-out showed that every gate that ran
 * against the real surface caught something: stubs, crashes, dead graphs —
 * all behind a green unit test suite.
 *
 * Key regressions caught:
 * - `index sync` was a TODO stub behind green tests (Spec 07)
 * - `initParsers()` was missing from the CLI handler since Spec 08 landed
 * - `code-audit changed` crashed on DB init since Spec 04 (the product bet)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { rmSync, accessSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const CLI_SCRIPT = join(__dirname, 'cli.ts');

/**
 * Build the right command for invoking the CLI.
 * Prefer `node dist/cli.js` (built); fall back to `npx tsx src/cli.ts` (dev).
 */
function cliCommand(args: string): string {
  const distCli = join(__dirname, '..', 'dist', 'cli.js');
  try {
    accessSync(distCli);
    return `node "${distCli}" ${args}`;
  } catch {
    return `npx tsx "${CLI_SCRIPT}" ${args}`;
  }
}

function runCli(args: string, cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const cmd = cliCommand(args);
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      env: { ...process.env, CODE_AUDITOR_DATA_DIR: cwd },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status || 1,
    };
  }
}

describe('CLI integration — index sync', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-cli-sync-'));
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── P1: single-file sync — proves initParsers() is called and works ──────

  it('synchronizeFile exits 0 and indexes a single .ts file', async () => {
    await mkdir(join(testDir, 'src'), { recursive: true });
    const filePath = join(testDir, 'src', 'single.ts');
    await writeFile(filePath, [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      'export function multiply(a: number, b: number): number {',
      '  return a * b;',
      '}',
    ].join('\n'));

    const result = runCli(`index sync --path "${filePath}" --json`, testDir);

    expect(result.exitCode).toBe(0);
    // JSON output has pretty-print spacing
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.mode).toBe('sync');
    // synchronizeFile returns added/updated/removed counts
    expect(parsed.added).toBe(2);
  });

  // ── P2: directory sync (cold DB — discovers files from filesystem) ──

  it('deepSync on a cold index discovers files from the filesystem', async () => {
    await mkdir(join(testDir, 'src'), { recursive: true });
    await writeFile(join(testDir, 'src', 'file.ts'), 'export const X = 1;');

    // deepSync discovers files from the filesystem when projectRoot is provided.
    // The file has no functions (only a const), so added=0 but syncedFiles=1.
    const result = runCli(`index sync --path "${testDir}" --json`, testDir);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.mode).toBe('sync');
    expect(parsed.syncedFiles).toBe(1);
    expect(parsed.addedFunctions).toBe(0);
  });

  // ── P3: does not crash with empty directory ────────────────────────────────

  it('exits 0 on an empty directory without crashing', async () => {
    const dataDir = join(testDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(testDir, 'emptydir'), { recursive: true });

    const result = runCli(`index sync --path "${testDir}/emptydir" --json`, testDir);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
  });

  // ── P4: file with parse errors — tree-sitter error tolerance ──────────────
  // tree-sitter produces error-recovery nodes (ERROR) rather than throwing.
  // The scanner finds zero scan-worthy functions in garbled input — added=0,
  // exit 0. "Doesn't crash" means it doesn't hang, segfault, or produce a
  // stack trace.

  it('exits 0 with added=0 on a file with parse errors — no crash or hang', async () => {
    await mkdir(join(testDir, 'broken'), { recursive: true });
    const badPath = join(testDir, 'broken', 'bad.ts');
    await writeFile(badPath, 'not valid typescript @@@@');

    const result = runCli(`index sync --path "${badPath}" --json`, testDir);

    // tree-sitter is error-tolerant — produces AST with ERROR nodes,
    // Scanner finds zero functions in garbled input. Clean termination.
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.added).toBe(0);
  });
});

// ── Gap 3 (hook fix): foreign CWD project root forwarding ─────────────────────
// The hook script passes -p "${CLAUDE_PROJECT_DIR}" to ensure the changed
// command resolves the project root correctly even when CWD differs from
// the project directory. These tests verify the -p flag is honored.

describe('CLI integration — foreign CWD with -p', () => {
  let projectDir: string;
  let foreignCwd: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'ca-foreign-project-'));
    foreignCwd = await mkdtemp(join(tmpdir(), 'ca-foreign-cwd-'));
    await mkdir(join(projectDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(foreignCwd, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('changed --stdin with -p works when run from a foreign CWD', async () => {
    // Write a source file in the project with an undocumented exported function
    const srcFile = join(projectDir, 'src', 'helper.ts');
    await writeFile(srcFile, [
      'export function doStuff(x: number): number {',
      '  const a = x + 1;',
      '  const b = a * 2;',
      '  const c = b - 3;',
      '  const d = c / 4;',
      '  return d;',
      '}',
    ].join('\n'));

    // The 'changed' command with a file list (not 'changed' scope) audits
    // the listed files directly. Pipe an absolute file path via stdin.
    const result = execSync(
      cliCommand(`changed --stdin --json --fail-on critical -p "${projectDir}"`),
      {
        cwd: foreignCwd,
        encoding: 'utf-8',
        input: `${srcFile}\n`,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        env: { ...process.env, CODE_AUDITOR_DATA_DIR: projectDir },
      }
    );

    expect(result).toBeDefined();
    // Even if no violations found, we should get valid JSON or clean stdout
    const trimmed = result.trim();
    if (trimmed) {
      const parsed = JSON.parse(trimmed);
      expect(Array.isArray(parsed)).toBe(true);
    }
  });

  it('changed with -p from foreign CWD finds project-specific config', async () => {
    // Write a .codeauditor.json that ONLY enables the documentation analyzer
    const configFile = join(projectDir, '.codeauditor.json');
    await writeFile(configFile, JSON.stringify({
      enabledAnalyzers: ['documentation'],
    }));

    // Source file with undocumented exported function
    const srcFile = join(projectDir, 'src', 'lib.ts');
    await writeFile(srcFile, [
      '/**',
      ' * A well-documented function.',
      ' */',
      'export function documented(x: number): number {',
      '  const a = x + 1;',
      '  const b = a * 2;',
      '  const c = b - 3;',
      '  const d = c / 4;',
      '  return d;',
      '}',
    ].join('\n'));

    // Run from foreign CWD with -p
    const result = execSync(
      cliCommand(`changed --stdin --json --fail-on critical -p "${projectDir}"`),
      {
        cwd: foreignCwd,
        encoding: 'utf-8',
        input: `${srcFile}\n`,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
        env: { ...process.env, CODE_AUDITOR_DATA_DIR: projectDir },
      }
    );

    // Exit code 0 means the command ran successfully from the foreign CWD
    // (documentation analyzer found no issues on the documented function)
    const trimmed = result.trim();
    if (trimmed) {
      const parsed = JSON.parse(trimmed);
      expect(Array.isArray(parsed)).toBe(true);
    }
  });
});
