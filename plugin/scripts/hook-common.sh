#!/usr/bin/env bash
# Shared helpers for the code-auditor PostToolUse hooks.
#
# Sourced by hook-audit.sh and hook-self-audit.sh. CLAUDE_PLUGIN_ROOT is
# guaranteed set before either hook runs (the hooks.json guard exits 1 when it
# is unset).
#
# Two rules enforced here are the fix for "the hook died quietly" (three times:
# unset CLAUDE_PLUGIN_ROOT, a stale global binary, a removed CLI flag):
#   1. prefer the plugin's bundled CLI when it is shipped (npm installs) so a
#      stale global/project binary can never drive the hook, and
#   2. a non-zero CLI exit that is NOT a finding (2) is a broken hook and must
#      fail loudly, never degrade to a silent no-op.
#
# The plugin cache does NOT ship a bundled CLI (dist/ is gitignored, so a
# marketplace install from `./plugin` has no `../dist/`), which means the
# fallback paths (project-local, global/PATH, npx) are the common case. For those,
# `assert_compatible` pins the resolved binary's REAL version against the plugin
# manifest and fails loudly on mismatch — see below. This pin is what stopped the
# third quiet failure: a 3.9.6 global silently driving a 3.9.9 plugin.
#
# The sourcing hook runs with `set -euo pipefail`.

# resolve_code_audit — emit the CLI invocation to use.
#
# 1. The plugin's bundled CLI (dist/cli.js ships in the same npm package, so it
#    is always the exact version this plugin was built against) — present only
#    when installed from npm, not from the marketplace.
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
#
# The manifest lives at .claude-plugin/plugin.json (this plugin's convention),
# but a few installs flatten it to plugin.json at the plugin root, so check both.
plugin_version() {
  node -e "const fs=require('fs');const p=process.env.CLAUDE_PLUGIN_ROOT;for(const f of [p+'/.claude-plugin/plugin.json', p+'/plugin.json']){try{const v=JSON.parse(fs.readFileSync(f,'utf8')).version;if(v){process.stdout.write(v);break}}catch(e){}}" 2>/dev/null
}

# semver_of <version-string> — the leading X.Y.Z (with optional -prerelease) in a
# version string, or '' when none is present. The `--version` output carries a
# "(sqlite: …)" suffix, so the pin compares only the semver, not the whole line.
semver_of() {
  printf '%s' "$1" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?' | head -n 1 || true
}

# assert_compatible <bin> — pin the plugin to a compatible CLI.
#
# The bundled CLI always matches (same package), so it needs no check. Any
# fallback path can drift — a stale global, a project-local pin, or a wider npx
# range — and a 3.4.0 plugin silently driving a 3.5.0 CLI is exactly the
# failure this guards.
#
# The comparison is semver-vs-semver (the CLI's real `--version`, not its full
# banner), and it fails loudly on a mismatch OR when either version cannot be
# determined — an unidentified binary is never trusted.
assert_compatible() {
  local bin="$1" pv cv pv_sem cv_sem
  case "${bin}" in
    "${CLAUDE_PLUGIN_ROOT}/../dist/cli.js") return 0 ;;   # pinned by construction
  esac
  pv="$(plugin_version)"
  cv="$($bin --version 2>/dev/null || true)"
  pv_sem="$(semver_of "${pv}")"
  cv_sem="$(semver_of "${cv}")"
  if [ -z "${pv_sem}" ] || [ -z "${cv_sem}" ]; then
    echo "[code-auditor] HOOK BROKEN: cannot verify CLI version (plugin='${pv}' cli='${cv}') — refusing to run an unidentified binary" >&2
    return 1
  fi
  if [ "${pv_sem}" != "${cv_sem}" ]; then
    echo "[code-auditor] version mismatch: plugin ${pv_sem} vs CLI ${cv_sem} — pin the CLI to the plugin version" >&2
    return 1
  fi
  return 0
}
