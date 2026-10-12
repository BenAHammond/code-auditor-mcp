#!/usr/bin/env node
/**
 * Stamp the hook-log path constants into BOTH the TS reader and the bash writer
 * from one source, so the read half and the write half of the hook's diagnostic
 * log can never drift apart.
 *
 * The hook-log channel spans two languages: `src/hookLog.ts` reads the log the
 * bash hooks write via `plugin/scripts/hook-common.sh`. The directory tail
 * (`code-auditor/logs`) and the file name (`hook.log`) used to be hardcoded in
 * both — one literal in the reader, another in the writer — so a path change in
 * one language silently left the other pointing at nothing. That drift is
 * invisible to a fail-open reader: an absent log reads as "no notice", so every
 * test stayed green while the channel was dead.
 *
 * This writes the two constants to:
 *   - `src/hookLogPath.generated.ts` (imported by `src/hookLog.ts`), and
 *   - `plugin/scripts/hook-log-path.sh` (sourced by `plugin/scripts/hook-common.sh`),
 * mirroring the `version.generated.ts` pattern: the value is embedded at build
 * time, so neither language can drift from the other at runtime. The two files
 * are committed (like `version.generated.ts`) so dev runs without a build still
 * work, and regenerated on every build.
 *
 * The end-to-end test in `src/hookLog.spec.ts` runs the real `hook-common.sh`
 * writer and asserts the reader resolves the exact file it created.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single source of truth for the hook-log path. The directory tail is the
// historical `${XDG_CACHE_HOME:-$HOME/.cache}/code-auditor/logs` tail; the file
// is the historical `hook.log`.
const HOOK_LOG_DIR_TAIL = 'code-auditor/logs';
const HOOK_LOG_FILE = 'hook.log';

// Reject anything surprising so a bad edit can't silently ship a path that
// diverges from the convention the hooks have always written.
if (!/^[a-z0-9-]+(\/[a-z0-9-]+)+$/.test(HOOK_LOG_DIR_TAIL)) {
  console.error(`write-hook-log-path: refusing to stamp invalid tail "${HOOK_LOG_DIR_TAIL}"`);
  process.exit(1);
}
if (!/^[a-z0-9.-]+$/.test(HOOK_LOG_FILE)) {
  console.error(`write-hook-log-path: refusing to stamp invalid file "${HOOK_LOG_FILE}"`);
  process.exit(1);
}

const tsOut = path.join(__dirname, '..', 'src', 'hookLogPath.generated.ts');
const tsBody =
  '// @generated — do not edit. Written by `scripts/write-hook-log-path.mjs`.\n' +
  '//\n' +
  '// Single source of truth for the hook-log path, shared by the TS reader\n' +
  '// (src/hookLog.ts) and the bash writer (plugin/scripts/hook-common.sh via\n' +
  '// plugin/scripts/hook-log-path.sh). Regenerate with `npm run build:hooklog`.\n' +
  `export const HOOK_LOG_DIR_TAIL = '${HOOK_LOG_DIR_TAIL}' as const;\n` +
  `export const HOOK_LOG_FILE = '${HOOK_LOG_FILE}' as const;\n`;

const shOut = path.join(__dirname, '..', 'plugin', 'scripts', 'hook-log-path.sh');
const shBody =
  '# @generated — do not edit. Written by `scripts/write-hook-log-path.mjs`.\n' +
  '#\n' +
  '# Single source of truth for the hook-log path, shared by the TS reader\n' +
  '# (src/hookLog.ts) and the bash writer (plugin/scripts/hook-common.sh).\n' +
  '# Regenerate with `npm run build:hooklog`.\n' +
  `HOOK_LOG_DIR_TAIL='${HOOK_LOG_DIR_TAIL}'\n` +
  `HOOK_LOG_FILE='${HOOK_LOG_FILE}'\n`;

writeFileSync(tsOut, tsBody);
writeFileSync(shOut, shBody);
process.stdout.write(`build:hooklog → tail=${HOOK_LOG_DIR_TAIL} file=${HOOK_LOG_FILE}\n`);
