#!/usr/bin/env bash
# Shared helpers for the code-auditor PostToolUse hooks.
#
# Sourced by hook-audit.sh and hook-self-audit.sh. CLAUDE_PLUGIN_ROOT is
# guaranteed set before either hook runs (the hooks.json guard exits 1 when it
# is unset), so resolving the plugin's own bundled CLI is always possible here.
#
# Two rules enforced here are the fix for "the hook died quietly" (three times:
# unset CLAUDE_PLUGIN_ROOT, a stale global binary, a removed CLI flag):
#   1. always prefer the plugin's bundled CLI so a stale global/project binary
#      can never drive the hook, and
#   2. a non-zero CLI exit that is NOT a finding (2) is a broken hook and must
#      fail loudly, never degrade to a silent no-op.
#
# The sourcing hook runs with `set -euo pipefail`.

# resolve_code_audit — emit the CLI invocation to use.
#
# 1. The plugin's bundled CLI (dist/cli.js ships in the same npm package, so it
#    is always the exact version this plugin was built against).
# 2. Project-local install (consumer project's own node_modules).
# 3. Global install / PATH.
# 4. npx auto-install (only if nothing else resolves).
resolve_code_audit() {
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/../dist/cli.js" ]; then
    echo "${CLAUDE_PLUGIN_ROOT}/../dist/cli.js"
    return
  fi
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -x "${CLAUDE_PROJECT_DIR}/node_modules/.bin/code-audit" ]; then
    echo "${CLAUDE_PROJECT_DIR}/node_modules/.bin/code-audit"
    return
  fi
  if command -v code-audit &>/dev/null; then
    echo "code-audit"
    return
  fi
  echo "npx -y -p code-auditor-mcp@^3.0.0 code-audit"
}

# plugin_version — the version this plugin declares in its manifest, or ''.
plugin_version() {
  node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.CLAUDE_PLUGIN_ROOT+'/.claude-plugin/plugin.json','utf8')).version||'')}catch(e){process.stdout.write('')}" 2>/dev/null
}

# assert_compatible <bin> — pin the plugin to a compatible CLI.
#
# The bundled CLI always matches (same package), so it needs no check. Any
# fallback path can drift — a stale global, a project-local pin, or a wider npx
# range — and a 3.4.0 plugin silently driving a 3.5.0 CLI is exactly the
# failure this guards. Print a loud error and return 1 on a detected mismatch.
assert_compatible() {
  local bin="$1" pv cv
  case "${bin}" in
    "${CLAUDE_PLUGIN_ROOT}/../dist/cli.js") return 0 ;;   # pinned by construction
  esac
  pv="$(plugin_version)"
  cv="$($bin --version 2>/dev/null || true)"
  if [ -n "${pv}" ] && [ -n "${cv}" ] && [ "${pv}" != "${cv}" ]; then
    echo "[code-auditor] version mismatch: plugin ${pv} vs CLI ${cv} — pin the CLI to the plugin version" >&2
    return 1
  fi
  return 0
}
