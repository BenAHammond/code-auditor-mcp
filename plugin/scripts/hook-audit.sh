#!/usr/bin/env bash
# code-auditor PostToolUse hook — audit changed files after Write/Edit.
#
# Reads the PostToolUse event JSON from stdin, extracts the edited file path,
# and runs `code-audit changed --stdin --json --fail-on critical` against it.
#
# Exit codes:
#   0 — all clear or degraded (no audit tool, no index, non-critical findings)
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

# Degrade cleanly if code-audit is not installed
if ! command -v code-audit &>/dev/null; then
  echo "[code-auditor] code-audit not installed — skipping audit hook. Install with: npm install -g code-auditor-mcp" >&2
  exit 0
fi

# Run diff-scoped audit on the changed file
# stdout/stderr are fed back to the agent by Claude Code
set +e
echo "${file}" | code-audit changed --stdin --json --fail-on critical 2>&1
exit_code=$?
set -e

# Exit code 2 = --fail-on triggered (critical violations found)
# Let it propagate so Claude Code feeds violations back to the agent
if [ ${exit_code} -eq 2 ]; then
  exit 2
fi

# All other non-zero exits: degrade gracefully
# (no index, no violations, package error, etc.)
exit 0
