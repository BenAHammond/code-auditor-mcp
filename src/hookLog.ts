/**
 * Hook-log reader — the read half of the hook's write-only diagnostic log.
 *
 * The PostToolUse/SessionStart hooks (`plugin/scripts/hook-*.sh`) and the
 * bootstrap guard in `plugin/hooks/hooks.json` write status records to the hook
 * log that `hook_log_dir()`/`hook_log_file()` in hook-common.sh compute. Until
 * this module existed, nothing read that log — a hook that stopped enqueueing
 * (e.g. `CLAUDE_PLUGIN_ROOT` unset) was invisible to the explicit audit, the
 * exact silent-disable the 4.1.0 guard was removed to escape. This module is
 * the single shared reader both the CLI and MCP audit entry points call, so a
 * live "hook not running" condition surfaces as a top-level notice rather than
 * vanishing into a write-only log.
 *
 * The path here is deliberately NOT `getFallbackCacheRoot()`: that resolves to
 * `~/Library/Caches/code-auditor` on macOS, while the bash hooks always use the
 * Linux-style `${XDG_CACHE_HOME:-$HOME/.cache}` convention regardless of
 * platform. The writer and reader must agree, so the tail and file name are
 * single-sourced: `HOOK_LOG_DIR_TAIL`/`HOOK_LOG_FILE` are imported from
 * `hookLogPath.generated.ts`, which `scripts/write-hook-log-path.mjs` generates
 * from the same source as `plugin/scripts/hook-log-path.sh` (the file the bash
 * writer sources) — the two languages can never drift.
 *
 * Contract (fail-open): an absent, unreadable, or malformed log yields no
 * notice and never throws — the reader must not change the audit exit code.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { HOOK_LOG_DIR_TAIL, HOOK_LOG_FILE } from './hookLogPath.generated.js';

/**
 * One record's leading timestamp: `[YYYY-MM-DDTHH:MM:SSZ]`, written by the bash
 * hooks via `date -u +%Y-%m-%dT%H:%M:%SZ`. Equal-width fields make the strings
 * lexicographically comparable, so "newer" is a plain string `>`.
 */
const RECORD_RE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\]\s*(.*)$/;

/** The bootstrap guard writes this when the hook cannot run (`CLAUDE_PLUGIN_ROOT`
 *  unset) — the condition the reader reports. */
const CONDITION_MARKER = 'HOOK NOT RUNNING';
/** hook-audit.sh writes this after a completed run (exit 0 or 2) — the positive
 *  "the hook is alive and enqueueing" signal that resolves a condition. */
const SUCCESS_MARKER = 'HOOK RAN';

/** The hook-log directory, mirroring hook-common.sh's `hook_log_dir()`. */
export function resolveHookLogDir(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || path.join(homedir(), '.cache');
  return path.join(base, HOOK_LOG_DIR_TAIL);
}

/** The hook-log file path, mirroring hook-common.sh's `hook_log_file()`. */
export function resolveHookLogPath(): string {
  return path.join(resolveHookLogDir(), HOOK_LOG_FILE);
}

/** A live "hook not running" condition, when one is unresolved. */
export interface HookNotice {
  /** The newest unresolved condition record's message, verbatim. */
  condition: string;
  /** The full user-facing notice: the condition plus the stale-findings
   *  consequence, so the CLI and MCP share one wording. */
  message: string;
}

const STALE_SUFFIX =
  'Cached findings may be stale because the hook is not enqueueing changes for audit.';

/**
 * Read the hook log and report a live "hook not running" condition, if any.
 *
 * "Live" is decided by record order, not a time window: a condition is live
 * when the newest `HOOK NOT RUNNING` record is newer than the newest `HOOK RAN`
 * record — or no `HOOK RAN` record exists at all. A successful hook run since
 * the condition resolves it.
 *
 * Fail-open: an absent, unreadable, or malformed log yields `null` (no notice)
 * and never throws.
 */
export function readHookNotice(): HookNotice | null {
  let text: string;
  try {
    text = readFileSync(resolveHookLogPath(), 'utf8');
  } catch {
    return null; // absent or unreadable — fail open
  }

  let newestCondition: { ts: string; message: string } | null = null;
  let newestSuccess: { ts: string; message: string } | null = null;

  for (const line of text.split('\n')) {
    const m = RECORD_RE.exec(line);
    if (!m) continue; // malformed line — skip, never throw
    const ts = m[1];
    const message = m[2];
    if (message.includes(CONDITION_MARKER)) {
      if (!newestCondition || ts > newestCondition.ts) newestCondition = { ts, message };
    } else if (message.includes(SUCCESS_MARKER)) {
      if (!newestSuccess || ts > newestSuccess.ts) newestSuccess = { ts, message };
    }
  }

  if (!newestCondition) return null;
  // Resolved when a successful run is at least as new as the newest condition —
  // "live" means strictly newer, so equal timestamps resolve.
  if (newestSuccess && newestSuccess.ts >= newestCondition.ts) return null;

  return {
    condition: newestCondition.message,
    message: `${newestCondition.message} ${STALE_SUFFIX}`,
  };
}
