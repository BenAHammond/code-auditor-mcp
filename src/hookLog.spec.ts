/**
 * Hook-log reader (Spec 70 Amendment — the read half of the hook's diagnostic
 * log).
 *
 * Until `hookLog.ts` existed, the PostToolUse/SessionStart hooks (and the
 * bootstrap guard in `plugin/hooks/hooks.json`) wrote status records to
 * `${XDG_CACHE_HOME:-$HOME/.cache}/code-auditor/logs/hook.log` and nothing read
 * them — a hook that stopped enqueueing was invisible to the explicit audit,
 * the exact silent-disable the 4.1.0 guard was removed to escape. This spec
 * pins the reader's contract:
 *
 *   1. A live condition (newest HOOK NOT RUNNING newer than the newest HOOK RAN,
 *      or no HOOK RAN at all) surfaces as a notice.
 *   2. A successful run since the condition resolves it (no notice).
 *   3. Fail-open: absent / unreadable / malformed logs yield no notice and never
 *      throw.
 *   4. The CLI and MCP audit entry points share the same reader (no duplicate).
 *   5. The path literal `code-auditor/logs` appears exactly once in `src/`.
 *
 * Written red-first: before `hookLog.ts` shipped, importing `readHookNotice`
 * failed and every test errored.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  readdirSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  statSync,
  existsSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveHookLogPath, readHookNotice } from './hookLog.js';

/** A fixed-format record, matching the bash writer's `date -u +%Y-%m-%dT%H:%M:%SZ`. */
function record(ts: string, message: string): string {
  return `[${ts}] ${message}`;
}

// The real markers must match hook-common.sh / hooks.json exactly.
const NOT_RUNNING =
  '[code-auditor] HOOK NOT RUNNING: CLAUDE_PLUGIN_ROOT is unset — could not locate the plugin; the audit is not running.';
const RAN = '[code-auditor] HOOK RAN';

let originalXdg: string | undefined;
let tempDir: string;

beforeEach(() => {
  originalXdg = process.env.XDG_CACHE_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'hooklog-'));
  process.env.XDG_CACHE_HOME = tempDir;
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdg;
  rmSync(tempDir, { recursive: true, force: true });
});

/** Write records to the resolved hook log, creating parent dirs. Returns the path. */
function writeLog(lines: string[]): string {
  const p = resolveHookLogPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return p;
}

describe('readHookNotice', () => {
  it('reports a live condition record with no later successful run (RED: the reader must exist)', () => {
    writeLog([record('2026-10-11T10:00:00Z', NOT_RUNNING)]);
    const notice = readHookNotice();
    expect(notice).not.toBeNull();
    expect(notice!.condition).toBe(NOT_RUNNING);
    expect(notice!.message).toContain('Cached findings may be stale');
  });

  it('clears the condition when a successful run is newer', () => {
    writeLog([
      record('2026-10-11T10:00:00Z', NOT_RUNNING),
      record('2026-10-11T10:00:01Z', RAN),
    ]);
    expect(readHookNotice()).toBeNull();
  });

  it('keeps the condition live when the successful run is older', () => {
    writeLog([
      record('2026-10-11T10:00:01Z', NOT_RUNNING),
      record('2026-10-11T10:00:00Z', RAN),
    ]);
    expect(readHookNotice()?.condition).toBe(NOT_RUNNING);
  });

  it('returns no notice when the log is absent', () => {
    expect(readHookNotice()).toBeNull();
  });

  it('returns no notice and does not throw when the log is unreadable (mode 000)', () => {
    const p = writeLog([record('2026-10-11T10:00:00Z', NOT_RUNNING)]);
    chmodSync(p, 0o000);
    try {
      expect(() => readHookNotice()).not.toThrow();
      expect(readHookNotice()).toBeNull();
    } finally {
      chmodSync(p, 0o600); // restore so afterEach can rm the temp dir
    }
  });

  it('returns no notice and does not throw when the log is malformed', () => {
    writeLog(['not a record at all', '[not-a-timestamp] HOOK NOT RUNNING', '']);
    expect(() => readHookNotice()).not.toThrow();
    expect(readHookNotice()).toBeNull();
  });
});

describe('single shared reader + residue', () => {
  it('CLI and MCP both read the hook log through the same reader (no duplicate)', () => {
    const cli = readFileSync(resolve(__dirname, 'cli.ts'), 'utf8');
    const mcp = readFileSync(resolve(__dirname, 'mcp.ts'), 'utf8');
    expect(cli).toContain('readHookNotice');
    expect(mcp).toContain('readHookNotice');
    // Both import the same module — the reader lives in one place.
    expect(cli).toMatch(/from '\.\/hookLog\.js'/);
    expect(mcp).toMatch(/from '\.\/hookLog\.js'/);
  });

  it('derives the log path from a single shared literal (appears exactly once in src/)', () => {
    const srcRoot = resolve(__dirname, '..');
    const tsFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts') &&
          !entry.name.endsWith('.test.ts')
        ) {
          tsFiles.push(full);
        }
      }
    };
    walk(srcRoot);

    let count = 0;
    for (const f of tsFiles) {
      const text = readFileSync(f, 'utf8');
      count += (text.match(/code-auditor\/logs/g) ?? []).length;
    }
    expect(count).toBe(1);
  });
});

describe('end-to-end channel + single source', () => {
  const pluginScripts = resolve(__dirname, '..', 'plugin', 'scripts');
  const hookCommon = join(pluginScripts, 'hook-common.sh');

  /** Run the REAL writer — hook-common.sh's hook_log — in a sandboxed
   *  XDG_CACHE_HOME with CLAUDE_PLUGIN_ROOT unset, the exact broken state the
   *  condition describes. No path passes in either direction: the writer
   *  computes its own, and the reader must independently resolve the same file. */
  function runRealWriter(message: string): void {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CLAUDE_PLUGIN_ROOT;
    execFileSync('bash', ['-c', `set -euo pipefail; . "${hookCommon}"; hook_log "$HOOK_LOG_MSG"`], {
      env: { ...env, HOOK_LOG_MSG: message },
      stdio: 'pipe',
    });
  }

  it('the reader resolves the exact file the real writer created and reads its condition', () => {
    runRealWriter(NOT_RUNNING);
    // No fixture log and no path handed to the reader: resolveHookLogPath() must
    // land on the file hook_log just wrote, and readHookNotice() must surface the
    // condition that went into it.
    const p = resolveHookLogPath();
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toContain(NOT_RUNNING);
    expect(readHookNotice()?.condition).toBe(NOT_RUNNING);
  });

  it('the reader derives the tail from one generated source, not its own literal', () => {
    // RED before the fix: src/hookLog.ts hardcodes `code-auditor/logs` itself.
    expect(readFileSync(resolve(__dirname, 'hookLogPath.generated.ts'), 'utf8')).toContain('code-auditor/logs');
    expect(readFileSync(resolve(__dirname, 'hookLog.ts'), 'utf8')).not.toContain('code-auditor/logs');
  });

  it('the bash writer sources the same generated tail, not its own literal', () => {
    // RED before the fix: hook-common.sh hardcodes `code-auditor/logs` itself.
    expect(readFileSync(join(pluginScripts, 'hook-log-path.sh'), 'utf8')).toContain('code-auditor/logs');
    expect(readFileSync(hookCommon, 'utf8')).not.toContain('code-auditor/logs');
  });
});
