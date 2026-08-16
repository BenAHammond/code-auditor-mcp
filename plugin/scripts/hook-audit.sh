#!/usr/bin/env bash
# code-auditor PostToolUse hook — audit changed files after Write/Edit.
#
# Reads the PostToolUse event JSON from stdin, extracts the edited file path,
# and runs `code-audit changed --stdin --json` against it.
#
# Exit codes:
#   0 — all clear or degraded (binary not found, no index, no gating findings)
#   2 — a new gating-rule finding was introduced (Claude Code feeds stdout back)
set -euo pipefail

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

# Resolve the code-audit binary: project-local → PATH → npx auto-install
resolve_code_audit() {
  # 1. Project-local install (plugin project's own node_modules)
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -x "${CLAUDE_PROJECT_DIR}/node_modules/.bin/code-audit" ]; then
    echo "${CLAUDE_PROJECT_DIR}/node_modules/.bin/code-audit"
    return
  fi

  # 2. Global install or PATH
  if command -v code-audit &>/dev/null; then
    echo "code-audit"
    return
  fi

  # 3. npx auto-install (first use downloads the package; subsequent runs use the npx cache)
  echo "npx -y -p code-auditor-mcp@^3.0.0 code-audit"
}
CODE_AUDIT_BIN="$(resolve_code_audit)"

# Run diff-scoped audit on the changed file
# stdout/stderr are fed back to the agent by Claude Code
set +e
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
	  echo "${file}" | ${CODE_AUDIT_BIN} changed --stdin --json -p "${CLAUDE_PROJECT_DIR}"
	else
	  echo "${file}" | ${CODE_AUDIT_BIN} changed --stdin --json
	fi
exit_code=$?
set -e

# Exit code 2 = binary gate triggered (a new gating-rule finding)
# Let it propagate so Claude Code feeds the finding back to the agent
if [ ${exit_code} -eq 2 ]; then
  exit 2
fi

# Non-zero exit: npx auto-install failed, network issue, unsupported platform, etc.
# Degrade gracefully — never wedge the agent loop.
if [ ${exit_code} -ne 0 ]; then
  echo "[code-auditor] code-audit could not run (exit ${exit_code}). If npx auto-install failed, check your network or install manually: npm install code-auditor-mcp" >&2
fi

exit 0
