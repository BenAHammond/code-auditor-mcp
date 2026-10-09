#!/usr/bin/env bash
# code-auditor PostToolUse hook — audit changed files after Write/Edit.
#
# Reads the PostToolUse event JSON from stdin, extracts the edited file path,
# and runs `code-audit changed --stdin --json` against it.
#
# Exit codes:
#   0 — clean pass, no fresh result yet (the daemon is seeding/indexing, or
#       this edit hasn't been re-audited — feedback arrives one edit later), or
#       a broken tool (the failure is written to the log file, not stderr)
#   2 — a gating finding was read from the daemon's cache (Claude Code feeds
#       stdout back)
#   The hook never exits 1 and never writes stderr: a hook that can fail the
#   edit is worse than one that reports nothing (Spec 68 §hook-contract). A
#   broken tool is written to the log file, not stderr, and still exits 0 — a
#   failure surfaces on the next explicit audit, never on the edit.
set -euo pipefail

# Shared resolver + compatibility pinning (see hook-common.sh).
. "${CLAUDE_PLUGIN_ROOT}/scripts/hook-common.sh"

# Read event JSON from stdin
event="$(cat)"

# Extract the file path from the tool input (Write and Edit both use file_path)
file="$(node -e "
try {
  var d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  process.stdout.write(d.tool_input?.file_path || d.tool_input?.path || '');
} catch(e) { process.stdout.write(''); }
" <<< "${event}")"

# No file path in the event — nothing to audit
if [ -z "${file}" ]; then
  exit 0
fi

# Out-of-repo edit no-op (Spec 35 item 9): an edit outside the audited project
# must not error the hook. Resolve both paths to absolute form and exit 0 when
# the edited file is not inside CLAUDE_PROJECT_DIR.
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -n "${file}" ]; then
  # Normalize the project dir (strip any trailing slash).
  project_abs="$(cd "${CLAUDE_PROJECT_DIR}" 2>/dev/null && pwd)" || project_abs="${CLAUDE_PROJECT_DIR%/}"
  # Normalize the edited file: absolute paths pass through; relative paths
  # resolve against the current working directory.
  case "${file}" in
    /*) file_abs="${file}" ;;
    *)  file_abs="$(cd "$(dirname "${file}")" 2>/dev/null && pwd)/$(basename "${file}")" ;;
  esac
  case "${file_abs}" in
    "${project_abs}"/*) : ;;   # inside the project — continue to audit
    *) exit 0 ;;                # outside — nothing to audit
  esac
fi

# Source-file extension scope (Spec 35 item 10). Skip the CLI entirely for an
# edit to a non-source file (`.md`, `.txt`, `.yml`, …) so a prose edit never pays
# the discovery + index-sync spin-up. The CLI already exits 0 quietly on a
# no-auditable-files scope, so this is a fast no-op guard, not a correctness fix —
# a mismatch in either direction is harmless (an extension listed here that the
# CLI declines still audits to zero; one missing here just pays one wasted call).
# The extension set mirrors `getSourceExtensions()` (the language-registry union
# plus the raw and style-markup extensions the pipeline reads directly); a test in
# `src/plugin-manifest.spec.ts` pins this list to that function so a newly
# registered parser surfaces here instead of silently skipping its files.
case "${file}" in
  *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs|*.go|*.json|*.css|*.scss|*.sql|*.toml|*.prisma|*.astro|*.vue|*.svelte|*.html) : ;;
  *) exit 0 ;;
esac

CODE_AUDIT_BIN="$(resolve_code_audit)"

# Pin the plugin to a compatible CLI version. On mismatch the message goes to
# the hook log (a real failure) but the hook still exits 0 — it must never block the edit.
assert_compatible "${CODE_AUDIT_BIN}" || exit 0

# Run the diff-scoped gate in hook mode. CODE_AUDITOR_HOOK=1 tells the CLI:
# enqueue (start the daemon if absent), read a fresh result from the daemon's
# cache when it has one, and never run an in-process audit — so a successful
# edit produces zero bytes on stderr and returns in tens of milliseconds. Any
# stderr the CLI still emits is routed to the hook log, never to the host.
mkdir -p "$(hook_log_dir)" 2>/dev/null || true
set +e
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  echo "${file}" | CODE_AUDITOR_HOOK=1 ${CODE_AUDIT_BIN} changed --stdin --json -p "${CLAUDE_PROJECT_DIR}" 2>>"$(hook_log_file)"
else
  echo "${file}" | CODE_AUDITOR_HOOK=1 ${CODE_AUDIT_BIN} changed --stdin --json 2>>"$(hook_log_file)"
fi
exit_code=$?
set -e

# Exit 2 = a finding read from the daemon cache; propagate so Claude Code feeds
# stdout back.
if [ ${exit_code} -eq 2 ]; then
  exit 2
fi

# Any other non-zero exit is a broken tool, not a clean pass. Report it to the
# log file (a real failure) but exit 0 — failing the edit is worse than silence.
if [ ${exit_code} -ne 0 ]; then
  hook_log "[code-auditor] HOOK BROKEN: code-audit exited ${exit_code} (neither clean nor a finding). Fix the install — do not treat this as a clean pass."
  exit 0
fi

exit 0
