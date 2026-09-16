/**
 * Spec 59 — pinned-npx fallback fix contract for `resolve_code_audit`.
 *
 *   - **positive** — in a marketplace layout (plugin/ only, no sibling `dist/`, no
 *     project-local or global `code-audit`), `resolve_code_audit` emits
 *     `npx -y -p code-auditor-mcp@<manifest-version> code-audit` — the exact
 *     manifest version, never a `^` range.
 *   - **guard**     — the bundled sibling (`CLAUDE_PLUGIN_ROOT/../dist/cli.js`) is
 *     still preferred when present, so npm installs keep their zero-cost path.
 *   - **near-miss** — a global `code-audit` on PATH is still preferred over the
 *     npx fallback (the hook only reaches npx after `command -v code-audit` fails).
 *   - **absence**   — an unreadable manifest still yields a well-formed command
 *     (`@latest`) that `assert_compatible` will reject, never an empty command or a
 *     `^` range.
 *
 * These shell out to the real `hook-common.sh` so the assertion is on the shipped
 * script, not a reimplementation of it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
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
  /** a bin dir with `node` symlinked but (optionally) a fake `code-audit` */
  bin: string;
}

/** Build a plugin layout. `manifest` is written to plugin/.claude-plugin/plugin.json
 * (unless null). `withSiblingDist` adds base/dist/cli.js. `withGlobalCodeAudit` adds
 * a fake `code-audit` to the clean bin dir. */
function setup(opts: {
  manifest: string | null;
  withSiblingDist?: boolean;
  withGlobalCodeAudit?: boolean;
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
  if (opts.withSiblingDist) {
    mkdirSync(join(base, 'dist'), { recursive: true });
    writeFileSync(join(base, 'dist', 'cli.js'), '');
  }

  const bin = mkdtempSync(join(tmpdir(), 'ca-hook-bin-'));
  scratchDirs.push(bin);
  // `plugin_version` runs `node -e`, so `node` must be on the clean PATH.
  symlinkSync(process.execPath, join(bin, 'node'));
  if (opts.withGlobalCodeAudit) {
    // A fake global code-audit that `command -v code-audit` will find.
    writeFileSync(join(bin, 'code-audit'), '#!/usr/bin/env bash\necho "9.9.9"\n');
    execFileSync('chmod', ['+x', join(bin, 'code-audit')]);
  }
  return { base, bin };
}

/** Run resolve_code_audit in a marketplace-like environment and return its output. */
function resolve(layout: Layout): string {
  const cleanPath = `${layout.bin}:/usr/bin:/bin`;
  const script = 'unset CLAUDE_PROJECT_DIR\n. "$CLAUDE_PLUGIN_ROOT/scripts/hook-common.sh"\nresolve_code_audit\n';
  const out = execFileSync('bash', ['-c', script], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: join(layout.base, 'plugin'),
      PATH: cleanPath,
    },
    encoding: 'utf8',
  });
  return out.trim();
}

describe('resolve_code_audit — pinned-npx fallback (Spec 59)', () => {
  it('positive: marketplace layout emits an exact-version npx pin, not a range', () => {
    const layout = setup({ manifest: '9.9.9' });
    expect(resolve(layout)).toBe('npx -y -p code-auditor-mcp@9.9.9 code-audit');
  });

  it('guard: bundled sibling is still preferred when present (npm install)', () => {
    const layout = setup({ manifest: '9.9.9', withSiblingDist: true });
    // The hook echoes `${CLAUDE_PLUGIN_ROOT}/../dist/cli.js` verbatim.
    expect(resolve(layout)).toBe(`${layout.base}/plugin/../dist/cli.js`);
  });

  it('near-miss: a global code-audit on PATH is preferred over the npx fallback', () => {
    const layout = setup({ manifest: '9.9.9', withGlobalCodeAudit: true });
    expect(resolve(layout)).toBe('code-audit');
  });

  it('absence: an unreadable manifest yields a well-formed @latest command, never a range', () => {
    const layout = setup({ manifest: null });
    const out = resolve(layout);
    expect(out).toBe('npx -y -p code-auditor-mcp@latest code-audit');
    expect(out).not.toContain('^');
  });
});
