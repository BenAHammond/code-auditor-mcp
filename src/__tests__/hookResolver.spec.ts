/**
 * Spec 59 — pinned-install fallback fix contract for `resolve_code_audit`.
 *
 *   - **positive** — in a marketplace layout (plugin/ only, no sibling `dist/`, no
 *     project-local or global `code-audit`), `resolve_code_audit` installs the
 *     pinned package to a deterministic dir and emits its `node_modules/.bin/
 *     code-audit` by absolute path — never an `npx … code-audit` command that a
 *     same-named binary earlier in PATH would shadow.
 *   - **guard**     — a bundled sibling (`CLAUDE_PLUGIN_ROOT/../dist/cli.js`) that
 *     reports the manifest version is still preferred, so npm installs keep their
 *     fast path (nothing is trusted on presence alone).
 *   - **compatible** — a global `code-audit` on PATH that reports the manifest
 *     version is still used (the fast path is preserved when it is not stale).
 *   - **stale**    — a bundled sibling OR global `code-audit` whose `--version`
 *     does not match the manifest is skipped with a one-line warn, and resolution
 *     falls through to the pinned install instead of hard-failing.
 *   - **install-failure** — when the pinned install cannot complete, resolution
 *     emits a last-ditch `npx` command (that `assert_compatible` will reject) —
 *     never an empty command.
 *   - **absence**   — an unreadable manifest still yields a well-formed command
 *     (`@latest`) that `assert_compatible` will reject, never an empty command or a
 *     `^` range.
 *
 * These shell out to the real `hook-common.sh` so the assertion is on the shipped
 * script, not a reimplementation of it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HOOK_COMMON = join(REPO_ROOT, 'plugin', 'scripts', 'hook-common.sh');

const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

interface Layout {
  /** base dir containing plugin/ and (optionally) dist/ */
  base: string;
  /** a bin dir with `node` symlinked and a fake `npm` (plus optionally a fake `code-audit`) */
  bin: string;
  /** a controlled cache root set as XDG_CACHE_HOME so pin_dir is assertable */
  cache: string;
}

/** Build a plugin layout. `manifest` is written to plugin/.claude-plugin/plugin.json
 * (unless null). `siblingVersion` adds an executable base/dist/cli.js that reports
 * that version (the bundled sibling). `globalVersion` adds a fake `code-audit` to the
 * clean bin dir that reports that version. `npmExitCode` controls the fake npm's exit
 * (default 0), so a failed install can be simulated. */
function setup(opts: {
  manifest: string | null;
  siblingVersion?: string;
  globalVersion?: string;
  npmExitCode?: number;
}): Layout {
  const base = mkdtempSync(join(tmpdir(), 'ca-hook-'));
  scratchDirs.push(base);
  const plugin = join(base, 'plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  mkdirSync(join(plugin, 'scripts'), { recursive: true });
  copyFileSync(HOOK_COMMON, join(plugin, 'scripts', 'hook-common.sh'));
  if (opts.manifest !== null) {
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: opts.manifest }));
  }
  if (opts.siblingVersion) {
    // A fake bundled CLI that `cli_is_compatible` version-checks like any other
    // candidate. Its `--version` output is a fixed string, so a stale build (a
    // locally built dist/ in a marketplace checkout) can be simulated.
    mkdirSync(join(base, 'dist'), { recursive: true });
    writeFileSync(join(base, 'dist', 'cli.js'), `#!/usr/bin/env bash\necho "${opts.siblingVersion}"\n`);
    execFileSync('chmod', ['+x', join(base, 'dist', 'cli.js')]);
  }

  const bin = mkdtempSync(join(tmpdir(), 'ca-hook-bin-'));
  scratchDirs.push(bin);
  // `plugin_version` runs `node -e`, so `node` must be on the clean PATH.
  symlinkSync(process.execPath, join(bin, 'node'));
  if (opts.globalVersion) {
    // A fake global code-audit that `command -v code-audit` will find. Its
    // `--version` output is a fixed string, so a stale version can be simulated.
    writeFileSync(join(bin, 'code-audit'), `#!/usr/bin/env bash\necho "${opts.globalVersion}"\n`);
    execFileSync('chmod', ['+x', join(bin, 'code-audit')]);
  }
  // A fake `npm` so resolve_pinned_bin can "install" without a real registry.
  // It exits with `npmExitCode` (0 by default); set it non-zero to simulate an
  // offline/failed install and exercise the last-ditch npx fallback.
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\nexit ${opts.npmExitCode ?? 0}\n`);
  execFileSync('chmod', ['+x', join(bin, 'npm')]);

  // A controlled cache root so pin_dir computes a deterministic, assertable path.
  const cache = mkdtempSync(join(tmpdir(), 'ca-hook-cache-'));
  scratchDirs.push(cache);

  return { base, bin, cache };
}

/** The absolute bin path the pinned install is expected to emit for `version`. */
function pinnedBin(layout: Layout, version: string): string {
  return join(layout.cache, 'code-auditor', 'cli', version, 'node_modules', '.bin', 'code-audit');
}

/** Run resolve_code_audit in a marketplace-like environment, returning stdout
 * (the emitted command) and stderr (any warn emitted when a stale install is
 * skipped). */
function resolveDetail(layout: Layout): { stdout: string; stderr: string } {
  const cleanPath = `${layout.bin}:/usr/bin:/bin`;
  const script = 'unset CLAUDE_PROJECT_DIR\n. "$CLAUDE_PLUGIN_ROOT/scripts/hook-common.sh"\nresolve_code_audit\n';
  const r = spawnSync('bash', ['-c', script], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: join(layout.base, 'plugin'),
      XDG_CACHE_HOME: layout.cache,
      PATH: cleanPath,
    },
    encoding: 'utf8',
  });
  return { stdout: r.stdout.trim(), stderr: r.stderr ?? '' };
}

/** Resolve and return only the emitted command. */
function resolve(layout: Layout): string {
  return resolveDetail(layout).stdout;
}

describe('resolve_code_audit — pinned-install fallback (Spec 59)', () => {
  it('positive: marketplace layout resolves to the pinned install\'s absolute bin path, not an npx command', () => {
    const layout = setup({ manifest: '9.9.9' });
    const out = resolve(layout);
    expect(out).toBe(pinnedBin(layout, '9.9.9'));
    expect(out).not.toContain('npx');
  });

  it('guard: a bundled sibling reporting the manifest version is still preferred (npm install)', () => {
    const layout = setup({ manifest: '9.9.9', siblingVersion: '9.9.9' });
    // The hook echoes `${CLAUDE_PLUGIN_ROOT}/../dist/cli.js` verbatim.
    expect(resolve(layout)).toBe(`${layout.base}/plugin/../dist/cli.js`);
  });

  it('stale sibling: a mismatched bundled dist/cli.js is skipped with a warn and falls through to the pin', () => {
    const layout = setup({ manifest: '9.9.9', siblingVersion: '9.9.8' });
    const { stdout, stderr } = resolveDetail(layout);
    expect(stdout).toBe(pinnedBin(layout, '9.9.9'));
    expect(stderr).toContain('warn');
    expect(stderr).toContain('9.9.8');
  });

  it('compatible: a global code-audit reporting the manifest version (with a banner suffix) is still used', () => {
    // The "(sqlite: …)" suffix is what the real CLI prints; semver_of must strip
    // it before comparing — the thing that let assert_compatible go quiet for
    // three releases. A bare "9.9.9" would never exercise that strip.
    const layout = setup({ manifest: '9.9.9', globalVersion: '9.9.9 (sqlite: node-sqlite)' });
    expect(resolve(layout)).toBe('code-audit');
  });

  it('stale: a mismatched global is skipped with a warn and falls through to the pinned install', () => {
    const layout = setup({ manifest: '9.9.9', globalVersion: '9.9.8' });
    const { stdout, stderr } = resolveDetail(layout);
    expect(stdout).toBe(pinnedBin(layout, '9.9.9'));
    expect(stderr).toContain('warn');
    expect(stderr).toContain('9.9.8');
  });

  it('install-failure: a failed install falls back to a last-ditch npx command, never empty', () => {
    const layout = setup({ manifest: '9.9.9', npmExitCode: 1 });
    expect(resolve(layout)).toBe('npx -y -p code-auditor-mcp@9.9.9 code-audit');
  });

  it('absence: an unreadable manifest yields a well-formed @latest command, never a range', () => {
    const layout = setup({ manifest: null });
    const out = resolve(layout);
    expect(out).toBe('npx -y -p code-auditor-mcp@latest code-audit');
    expect(out).not.toContain('^');
  });
});
