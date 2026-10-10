#!/usr/bin/env bash
# code-auditor PostToolUse self-audit hook — enforce the self-audit scope
# (analyzers/ + languages/) at edit time, not just at release (Spec 33 Item 15).
#
# Reads the PostToolUse event JSON from stdin, extracts the edited file path,
# and — only when that file is production source in the self-audit scope — runs
# `code-audit self-audit` against it. Exit code 2 blocks the edit and feeds the
# finding JSON back to the agent.
#
# This hook is a no-op for every edit outside the self-audit scope (consumer
# projects, tests, fixtures, and the declarative ruleRegistry table), so it adds
# no latency to ordinary edits. It runs *in addition to* hook-audit.sh, whose
# diff-gate enforces invariant rules on every edit.
#
# Exit codes:
#   0 — clean pass, out of scope, or a broken tool (the failure is written to
#       the log file, not stderr)
#   2 — a blocking self-audit finding (Claude Code feeds stdout back)
#   The hook never exits 1 and never writes stderr: a broken tool is written to
#   the log file, not stderr, and still exits 0 (Spec 68 §hook-contract).
set -euo pipefail

# Shared resolver + compatibility pinning (see hook-common.sh). Source it from
# this script's own directory — the plugin's scripts/ — never from a host
# environment variable.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
. "${SCRIPT_DIR}/hook-common.sh"

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

# Normalize the edited file to an absolute path (absolute paths pass through;
# relative paths resolve against the current working directory).
case "${file}" in
  /*) file_abs="${file}" ;;
  *)  file_abs="$(cd "$(dirname "${file}")" 2>/dev/null && pwd)/$(basename "${file}")" ;;
esac

# Out-of-repo edit no-op (Spec 35 item 9): an edit outside the audited project
# must not error the hook.
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  project_abs="$(cd "${CLAUDE_PROJECT_DIR}" 2>/dev/null && pwd)" || project_abs="${CLAUDE_PROJECT_DIR%/}"
  case "${file_abs}" in
    "${project_abs}"/*) : ;;   # inside the project — continue
    *) exit 0 ;;                # outside — nothing to self-audit
  esac
fi

# Self-audit scope gate: only production files under src/analyzers/ or
# src/languages/ are self-audit targets. Everything else — every file in a
# consumer repo, plus this repo's tests, specs, fixtures, and the declarative
# ruleRegistry.ts data table — is a no-op. The `self-audit` command re-checks
# this scope on the reported finding paths, so this is only a cheap pre-filter
# to keep the hook off the hot path for ordinary edits.
case "${file_abs}" in
  *"/src/analyzers/"*|*"/src/languages/"*) : ;;
  *) exit 0 ;;
esac
case "${file_abs}" in
  *"__tests__"*|*".test."*|*".spec."*|*"fixtures"*|*"ruleRegistry.ts"*) exit 0 ;;
esac

CODE_AUDIT_BIN="$(resolve_code_audit)"

# Pin the plugin to a compatible CLI version. On mismatch the message goes to
# stderr (a real failure) but the hook still exits 0 — it must never block the edit.
assert_compatible "${CODE_AUDIT_BIN}" || exit 0

# Run the self-audit on the edited file. CODE_AUDITOR_HOOK=1 silences info/debug
# on stderr (they go to the log file), so a successful self-audit is quiet. Any
# stderr the CLI still emits is routed to the hook log, never to the host.
mkdir -p "$(hook_log_dir)" 2>/dev/null || true
set +e
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  echo "${file_abs}" | CODE_AUDITOR_HOOK=1 ${CODE_AUDIT_BIN} self-audit --stdin --json -p "${CLAUDE_PROJECT_DIR}" 2>>"$(hook_log_file)"
else
  echo "${file_abs}" | CODE_AUDITOR_HOOK=1 ${CODE_AUDIT_BIN} self-audit --stdin --json 2>>"$(hook_log_file)"
fi
exit_code=$?
set -e

# Exit 2 = a blocking self-audit finding; propagate so Claude Code feeds it back.
if [ ${exit_code} -eq 2 ]; then
  exit 2
fi

# Any other non-zero exit is a broken tool, not a clean pass. Report it to the
# log file (a real failure) but exit 0 — failing the edit is worse than silence.
if [ ${exit_code} -ne 0 ]; then
  hook_log "[code-auditor] HOOK BROKEN: self-audit exited ${exit_code} (neither clean nor a finding). Fix the install — do not treat this as a clean pass."
  exit 0
fi

exit 0
