#!/usr/bin/env bash
# code-auditor PostToolUse hook — audit changed files after Write/Edit.
#
# Reads the PostToolUse event JSON from stdin, extracts the edited file path,
# and runs `code-audit changed --stdin --json --fail-on critical` against it.
#
# Exit codes:
#   0 — all clear or degraded (binary not found, no index, non-critical findings)
#   2 — critical violations found (Claude Code feeds stdout back to the agent)
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
echo "${file}" | ${CODE_AUDIT_BIN} changed --stdin --json --fail-on critical 2>&1
exit_code=$?
set -e

# Exit code 2 = --fail-on triggered (critical violations found)
# Let it propagate so Claude Code feeds violations back to the agent
if [ ${exit_code} -eq 2 ]; then
  exit 2
fi

# Non-zero exit: npx auto-install failed, network issue, unsupported platform, etc.
# Degrade gracefully — never wedge the agent loop.
if [ ${exit_code} -ne 0 ]; then
  echo "[code-auditor] code-audit could not run (exit ${exit_code}). If npx auto-install failed, check your network or install manually: npm install code-auditor-mcp" >&2
fi

exit 0
