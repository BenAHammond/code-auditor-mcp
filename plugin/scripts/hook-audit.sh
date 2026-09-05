#!/usr/bin/env bash
# code-auditor PostToolUse hook — audit changed files after Write/Edit.
#
# Reads the PostToolUse event JSON from stdin, extracts the edited file path,
# and runs `code-audit changed --stdin --json` against it.
#
# Exit codes:
#   0 — clean pass
#   2 — a gating finding was introduced (Claude Code feeds stdout back)
#   1 — the hook itself broke (binary missing, version mismatch, CLI error) —
#       reported loudly, never a silent no-op.
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

CODE_AUDIT_BIN="$(resolve_code_audit)"

# Pin the plugin to a compatible CLI version — fail loudly on mismatch.
assert_compatible "${CODE_AUDIT_BIN}" || exit 1

# Run diff-scoped audit on the changed file. stdout/stderr feed back to the agent.
set +e
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  echo "${file}" | ${CODE_AUDIT_BIN} changed --stdin --json -p "${CLAUDE_PROJECT_DIR}"
else
  echo "${file}" | ${CODE_AUDIT_BIN} changed --stdin --json
fi
exit_code=$?
set -e

# Exit 2 = a finding blocked the edit; propagate so Claude Code feeds it back.
if [ ${exit_code} -eq 2 ]; then
  exit 2
fi

# Any other non-zero exit is the hook breaking, not a clean pass. Report loudly
# and fail — a silent no-op here is exactly the failure mode this guards.
if [ ${exit_code} -ne 0 ]; then
  echo "[code-auditor] HOOK BROKEN: code-audit exited ${exit_code} (neither clean nor a finding). Fix the install — do not treat this as a clean pass." >&2
  exit 1
fi

exit 0
