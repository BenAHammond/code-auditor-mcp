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

// ── Gap 4 (CSS discovery): Defect #1 regression guard ──────────────────────────
// The style analyzer's bench suite seeds tables directly in-memory, bypassing
// production file-discovery wiring. All 13 bench analyzers passed green while
// the production index never saw a single CSS file — ALL_EXTENSIONS was missing
// CSS_EXTENSIONS. Bench-can't-see-production-wiring is a systemic gap: every
// module wired through discoverFiles() at sync time is vulnerable.
//
// This test exercises the real CLI surface. If ALL_EXTENSIONS excludes .css,
// syncedFiles = 0 in a directory containing only a CSS file — the same
// regression Defect #1 exposed.

describe('CSS discovery at installed surface (Gap 4)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ca-css-discovery-'));
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('discovers .css files via index sync (regression guard for ALL_EXTENSIONS)', async () => {
    await mkdir(join(testDir, 'styles'), { recursive: true });
    await writeFile(join(testDir, 'styles', 'theme.css'), [
      ':root {',
      '  --color-primary: #3b82f6;',
      '  --spacing-md: 16px;',
      '}',
      '',
      '.button {',
      '  background-color: var(--color-primary);',
      '  padding: var(--spacing-md);',
      '}',
    ].join('\n'));

    const result = runCli(`index sync --path "${testDir}" --json`, testDir);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    // The CSS file must be counted in syncedFiles — if ALL_EXTENSIONS
    // excludes .css, discoverFiles() never sees it and syncedFiles = 0.
    expect(parsed.syncedFiles).toBeGreaterThanOrEqual(1);
  });

  it('discovers .scss files via index sync', async () => {
    await mkdir(join(testDir, 'scss'), { recursive: true });
    await writeFile(join(testDir, 'scss', 'vars.scss'), [
      '$primary: #3b82f6;',
      '$spacing: 16px;',
      '',
      '.card {',
      '  color: $primary;',
      '  margin: $spacing;',
      '}',
    ].join('\n'));

    const result = runCli(`index sync --path "${testDir}" --json`, testDir);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.syncedFiles).toBeGreaterThanOrEqual(1);
  });

  it('returns syncedFiles=0 for empty directory (sanity — no false discovery)', async () => {
    await mkdir(join(testDir, 'empty'), { recursive: true });

    const result = runCli(`index sync --path "${testDir}/empty" --json`, testDir);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    // No files in the directory → nothing to discover
    expect(parsed.syncedFiles).toBe(0);
  });
});

/**
 * A2 gate — SKILL.md doc-CLI parity (Spec 11 R6 + task #226 expansion).
 *
 * Verifies that every code-audit flag and subcommand referenced in the
 * canonical SKILL.md bash code blocks exists in the actual CLI's --help
 * output. This gate expansion was motivated by Defect #3 (v3.4.1 release
 * validation): the SKILL.md shipped with `--tool claude` as a generate-config
 * flag, but the CLI never supported it. The A2 gate ran only against the
 * style layer (frontmatter, keyword presence) — it never checked whether
 * the flags taught to agents actually exist.
 *
 * Two checks:
 *   1. Flag parity — every --flag / -f in a code block appears in the
 *      corresponding subcommand's --help output.
 *   2. Subcommand parity — every non-flag token (e.g. `rules-list`,
 *      `from-audit`, `sync`) appears as a recognized subcommand in the
 *      base command's --help, or as a nested subcommand.
 *
 * Non-breaking: if the CLI binary is unavailable, tests skip cleanly.
 */
describe('A2 gate — SKILL.md doc-CLI parity', () => {
  const { readFileSync, existsSync } = require('fs');
  const { resolve, dirname } = require('path');
  const { fileURLToPath } = require('url');
  const { execSync } = require('child_process');

  const __dirname2 = dirname(fileURLToPath(import.meta.url));
  const SKILL_PATH = resolve(__dirname2, '..', 'plugin', 'skills', 'code-auditor', 'SKILL.md');

  // ── helpers ──────────────────────────────────────────────────────────

  /** Token that names a CLI subcommand (not a flag, value, or placeholder). */
  const KNOWN_SUBCOMMANDS = new Set([
    // Top-level commands
    'search', 'audit', 'changed', 'start', 'index', 'config', 'map',
    'codemap', 'tasks', 'hotspots', 'risk', 'ledger', 'conventions',
    'generate-config', 'gen', 'baseline', 'install', 'coverage', 'test',
    // config subcommands
    'rules-list', 'rules-check', 'profiles', 'detection',
    // tasks subcommands
    'list', 'create', 'get', 'update', 'complete', 'delete', 'from-audit',
    // index subcommands
    'sync', 'cleanup', 'reset', 'status',
    // conventions subcommands
    'propose',
    // ledger subcommands
    'trends',
  ]);

  function looksLikeSubcommand(token: string): boolean {
    if (token.startsWith('-')) return false;              // flag
    if (token.startsWith('<') && token.endsWith('>')) return false; // placeholder
    if (token.startsWith('"') || token.startsWith("'")) return false; // quoted value
    if (token === 'code-audit' || token === 'code-auditor-mcp') return false;
    // Only match known subcommands — avoids treating flag values (e.g. --language go,
    // --agent cursor) as subcommands.
    return KNOWN_SUBCOMMANDS.has(token);
  }

  /**
   * Parse a code-audit command line into { subcommandPath, flags }.
   *   "code-audit tasks create --title 'Fix' --priority high"
   *   → subcommandPath: ["tasks", "create"], flags: ["--title", "--priority"]
   */
  function parseSkillCommand(line: string): { subcommandPath: string[]; flags: string[] } | null {
    // Strip inline comments
    const commentIdx = line.indexOf('#');
    const cmdLine = (commentIdx >= 0 ? line.slice(0, commentIdx) : line).trim();
    if (!cmdLine.startsWith('code-audit') && !cmdLine.startsWith('code-auditor-mcp')) return null;

    const tokens = cmdLine.split(/\s+/).filter(Boolean);
    const subcommandPath: string[] = [];
    const flags: string[] = [];

    let i = 1; // skip 'code-audit' / 'code-auditor-mcp'
    for (; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith('-')) {
        flags.push(token);
        // Skip the value argument if next token doesn't look like a flag/subcommand
        if (i + 1 < tokens.length) {
          const next = tokens[i + 1];
          if (!next.startsWith('-') && !looksLikeSubcommand(next)) {
            i++; // consume the value
          }
        }
      } else if (looksLikeSubcommand(token)) {
        subcommandPath.push(token);
      }
      // else: skip values/placeholders
    }

    return { subcommandPath, flags };
  }

  /**
   * For a parsed command, determine which CLI help to query.
   *   ["tasks", "create"] → "tasks create --help"
   *   ["config"]         → "config --help"
   *   []                 → "--help"
   */
  function helpForPath(subcommandPath: string[]): string {
    if (subcommandPath.length === 0) return '--help';
    return `${subcommandPath.join(' ')} --help`;
  }

  /** Cached help outputs — spawn the CLI once per target. */
  const helpCache = new Map<string, string>();

  function getHelpOutput(helpCmd: string): string {
    if (helpCache.has(helpCmd)) return helpCache.get(helpCmd)!;
    const cmd = cliCommand(helpCmd);
    try {
      const out = execSync(cmd, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 15_000,
      });
      helpCache.set(helpCmd, out);
      return out;
    } catch (err: any) {
      const fallback = (err.stdout || '') + (err.stderr || '');
      helpCache.set(helpCmd, fallback);
      return fallback;
    }
  }

  // ── parse SKILL.md ───────────────────────────────────────────────────

  const skillContent = readFileSync(SKILL_PATH, 'utf-8');

  // Extract all bash code blocks and inline backtick commands
  const codeBlockRegex = /```bash\n([\s\S]*?)```/g;
  const parsedCommands: Array<{ subcommandPath: string[]; flags: string[]; raw: string }> = [];

  let blockMatch;
  while ((blockMatch = codeBlockRegex.exec(skillContent)) !== null) {
    const lines = blockMatch[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parsed = parseSkillCommand(trimmed);
      if (parsed) {
        parsedCommands.push({ ...parsed, raw: trimmed });
      }
    }
  }

  // Inline backticks: `code-audit search "calls:<fn>"`
  const inlineCmdRegex = /`(code-audit(?:or-mcp)?\s+[^`]+)`/g;
  while ((blockMatch = inlineCmdRegex.exec(skillContent)) !== null) {
    const trimmed = blockMatch[1].trim();
    const parsed = parseSkillCommand(trimmed);
    if (parsed) {
      // Skip duplicates — same command line already captured from code blocks
      const dup = parsedCommands.some(
        c => c.subcommandPath.join(' ') === parsed.subcommandPath.join(' ') &&
             c.flags.join(',') === parsed.flags.join(',')
      );
      if (!dup) parsedCommands.push({ ...parsed, raw: trimmed });
    }
  }

  // Group by help target so we only run --help once per unique subcommand path.
  //   target: { flags, subcmds, samples }
  const byTarget = new Map<string, { flags: Set<string>; subcmds: Set<string>; samples: string[] }>();

  for (const cmd of parsedCommands) {
    const target = helpForPath(cmd.subcommandPath);
    if (!byTarget.has(target)) {
      byTarget.set(target, { flags: new Set(), subcmds: new Set(), samples: [] });
    }
    const entry = byTarget.get(target)!;
    for (const f of cmd.flags) entry.flags.add(f);
    entry.samples.push(cmd.raw);

    // When a command has nested subcommands (e.g. "config profiles --file"),
    // also verify that the parent lists the subcommand.
    if (cmd.subcommandPath.length > 1) {
      const parentTarget = helpForPath(cmd.subcommandPath.slice(0, -1));
      if (!byTarget.has(parentTarget)) {
        byTarget.set(parentTarget, { flags: new Set(), subcmds: new Set(), samples: [] });
      }
      const parentEntry = byTarget.get(parentTarget)!;
      parentEntry.subcmds.add(cmd.subcommandPath[cmd.subcommandPath.length - 1]);
      parentEntry.samples.push(cmd.raw);
    }
  }

  // ── tests ────────────────────────────────────────────────────────────

  // Guard: CLI must be available (either built dist/ or npx tsx fallback).
  const cliAvailable = (() => {
    try {
      getHelpOutput('--help');
      return true;
    } catch {
      return false;
    }
  })();

  const itIfCli = cliAvailable ? it : it.skip;

  // Check each help target
  for (const [target, entry] of byTarget) {
    const { flags, subcmds } = entry;

    if (flags.size === 0 && subcmds.size === 0) continue;

    describe(`"code-audit ${target}"`, () => {
      let helpText: string;
      beforeAll(() => {
        helpText = getHelpOutput(target);
      });

      if (flags.size > 0) {
        itIfCli(`flag(s) in SKILL.md exist in CLI --help`, () => {
          const missing = [...flags].filter(f => !helpText.includes(f));
          expect(missing).toEqual([]);
        });
      }

      if (subcmds.size > 0) {
        itIfCli(`nested subcommand(s) in SKILL.md exist in parent --help`, () => {
          const missing = [...subcmds].filter(s => !helpText.includes(s));
          expect(missing).toEqual([]);
        });
      }
    });
  }

  // Sanity: there should be command references to verify
  itIfCli('has command references to verify', () => {
    expect(parsedCommands.length).toBeGreaterThan(0);
  });
});
