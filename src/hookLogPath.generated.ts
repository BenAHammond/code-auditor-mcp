// @generated — do not edit. Written by `scripts/write-hook-log-path.mjs`.
//
// Single source of truth for the hook-log path, shared by the TS reader
// (src/hookLog.ts) and the bash writer (plugin/scripts/hook-common.sh via
// plugin/scripts/hook-log-path.sh). Regenerate with `npm run build:hooklog`.
export const HOOK_LOG_DIR_TAIL = 'code-auditor/logs' as const;
export const HOOK_LOG_FILE = 'hook.log' as const;
