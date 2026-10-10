#!/usr/bin/env bash
# Shared helpers for the code-auditor PostToolUse hooks.
#
# Sourced by hook-audit.sh, hook-self-audit.sh, hook-warm.sh, and
# hook-drift-check.sh. The plugin root is derived from where THIS file lives —
# `<plugin>/scripts/hook-common.sh`, so the root is its grand-parent — never
# from a host environment variable. `CLAUDE_PLUGIN_ROOT` is honored only as a
# validated override (see plugin_root below), so an unset or wrong value can
# never decide whether the tool runs.
#
# Two rules enforced here are the fix for "the hook died quietly" (three times:
# unset CLAUDE_PLUGIN_ROOT, a stale global binary, a removed CLI flag):
#   1. prefer a bundled CLI when it is shipped (npm installs) AND its version
#      matches the manifest — nothing is trusted on presence alone, and
#   2. a non-zero CLI exit that is NOT a finding (2) is a broken hook and must
#      fail loudly, never degrade to a silent no-op.
#
# The plugin cache does NOT ship a bundled CLI (dist/ is gitignored, so a
# marketplace install from `./plugin` has no `../dist/`), which means the
# fallback paths (project-local, global/PATH, pinned install) are the common case —
# but a checkout where a developer *did* build dist/ locally ships a `../dist/cli.js`
# that is a local, possibly stale build, not the npm-paired dist/. The two files
# differ in more than freshness: npm's bin-links chmod the packaged `dist/cli.js`
# to `-rwxr-xr-x` at install, while local `tsc` output stays `-rw-r--r--`, so a
# marketplace checkout's sibling can be both stale AND non-executable — a file the
# old presence-only check would have trusted and then failed to run. Resolution is
# version-aware: EVERY candidate — the bundled sibling included — is used only
# when its `--version` matches the manifest, otherwise it is warned about and
# skipped, so a mismatched binary falls through to the pinned install instead
# of hard-failing. `assert_compatible` remains the final loud backstop on whatever
# resolve_code_audit returns. Together they stop the third quiet failure: a stale
# binary silently driving a newer plugin.
#
# The sourcing hook runs with `set -euo pipefail`.

# plugin_root — the plugin's install root.
#
# This file ships at `<plugin>/scripts/hook-common.sh`, so the plugin root is the
# grand-parent of its own location. That fixed, known-at-build-time offset is the
# single source of truth: every path a hook needs (the manifest, the bundled CLI
# sibling) is derived from here, not read from a host variable that may be unset.
# `CLAUDE_PLUGIN_ROOT` is honored only when it actually points at a plugin — it
# must contain this same `scripts/hook-common.sh` — so a stale or wrong value
# never shadows the real location, and an absent one is a non-event.
plugin_root() {
  local here root
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  root="$(dirname "${here}")"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/hook-common.sh" ]; then
    printf '%s' "${CLAUDE_PLUGIN_ROOT}"
    return
  fi
  printf '%s' "${root}"
}

# hook_log_dir / hook_log_file / hook_log — the hook's diagnostic log.
#
# The PostToolUse hook must never write stderr: the host may block on stderr
# content, so a single warning could block the edit. Every diagnostic — info,
# warnings, and failures alike — goes to this log file instead, and the hook
# still exits 0. A broken install therefore surfaces on the next explicit audit
# (and in this log), never on the edit itself.
hook_log_dir() {
  printf '%s' "${XDG_CACHE_HOME:-$HOME/.cache}/code-auditor/logs"
}
hook_log_file() {
  printf '%s' "$(hook_log_dir)/hook.log"
}
hook_log() {
  mkdir -p "$(hook_log_dir)" 2>/dev/null || return 0
  printf '%s\n' "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$(hook_log_file)" 2>/dev/null || true
}

# resolve_code_audit — emit the CLI invocation to use.
#
# Resolution is version-aware: EVERY candidate — bundled sibling, pinned install,
# project-local, global — is used only when its `--version` matches this plugin's
# manifest version. A stale candidate is warned about and skipped, so a mismatched
# binary no longer turns the hook into a hard failure.
#
# 1. The plugin's bundled CLI (`$(plugin_root)/../dist/cli.js` ships in the
#    same npm package, so it usually matches) — but a marketplace checkout has no
#    npm-paired dist/, and a locally built one can be stale, so it is
#    version-checked like everything else.
# 2. Pinned install, exact manifest version — never a range — tried before the
#    project-local and PATH candidates so a version-matched pin wins over a stale
#    project-local/global shim (the shadowing that resolve_pinned_bin's
#    install-to-known-dir approach exists to avoid).
# 3. Project-local install (consumer project's own node_modules) — if compatible.
# 4. Global install / PATH — if compatible.
resolve_code_audit() {
  local candidate root
  root="$(plugin_root)"
  if [ -f "${root}/../dist/cli.js" ]; then
    candidate="${root}/../dist/cli.js"
    if cli_is_compatible "${candidate}"; then
      echo "${candidate}"
      return
    fi
    warn_stale "${candidate}"
  fi

  # Pin to the plugin's exact version, not a range: `@^3.0.0` could resolve a
  # cached older CLI and silently drive this plugin with the wrong analyzer code.
  local pv bin
  pv="$(plugin_version)"
  if [ -n "${pv}" ]; then
    if bin="$(resolve_pinned_bin)"; then
      echo "${bin}"
      return
    fi
  fi

  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -x "${CLAUDE_PROJECT_DIR}/node_modules/.bin/code-audit" ]; then
    candidate="${CLAUDE_PROJECT_DIR}/node_modules/.bin/code-audit"
    if cli_is_compatible "${candidate}"; then
      echo "${candidate}"
      return
    fi
    warn_stale "${candidate}"
  fi
  if command -v code-audit &>/dev/null; then
    candidate="code-audit"
    if cli_is_compatible "${candidate}"; then
      echo "${candidate}"
      return
    fi
    warn_stale "${candidate}"
  fi

  # Pinned install failed (offline, registry error, npm missing), or the manifest
  # is unreadable. Emit the npx form as a last-ditch command so the hook still has
  # something to run; assert_compatible rejects it loudly if it cannot be verified.
  if [ -n "${pv}" ]; then
    echo "npx -y -p code-auditor-mcp@${pv} code-audit"
  else
    echo "npx -y -p code-auditor-mcp@latest code-audit"
  fi
}

# pin_dir — the deterministic directory the pinned CLI is installed into. The
# version is part of the path so a plugin update installs a fresh copy instead of
# reusing (and possibly mis-matching) the previous version's install.
pin_dir() {
  printf '%s' "${XDG_CACHE_HOME:-$HOME/.cache}/code-auditor/cli/$(plugin_version)"
}

# resolve_pinned_bin — ensure the pinned package is installed to pin_dir and echo
# the absolute path to its bin. Silent: prints only the path on success, nothing
# on failure (return 1).
#
# Installing (not `npx -p <pkg>@<ver> <bin>`) is the whole point. npx's `-p` puts
# the package's bin on PATH and runs the *name*, so a same-named binary earlier in
# PATH — a global shim, or a volta shim — shadows the pin, and the "fallback"
# silently routes back to the stale global it was meant to replace. Installing to
# a known dir and invoking `node_modules/.bin/code-audit` by absolute path removes
# PATH from the equation entirely.
resolve_pinned_bin() {
  local pv dir bin
  pv="$(plugin_version)"
  [ -n "$pv" ] || return 1
  dir="$(pin_dir)"
  bin="${dir}/node_modules/.bin/code-audit"
  if [ ! -x "$bin" ]; then
    mkdir -p "$dir" || return 1
    # --ignore-scripts is safe here (the CLI uses node:sqlite, not better-sqlite3,
    # and ships prebuilt binaries) and avoids any install-script work.
    npm install --prefer-offline --prefix "$dir" "code-auditor-mcp@${pv}" \
      --no-audit --no-fund --ignore-scripts --silent >/dev/null 2>&1 || return 1
  fi
  echo "$bin"
}

# plugin_version — the version this plugin declares in its manifest, or ''.
#
# The manifest lives at .claude-plugin/plugin.json (this plugin's convention),
# but a few installs flatten it to plugin.json at the plugin root, so check both.
#
# Memoized: the value is read once per hook invocation and cached. Three call
# sites (pin_dir, cli_is_compatible, assert_compatible) each re-read the same
# manifest, and each re-read is a fresh `node` spawn (~55ms) on the per-edit hot
# path. The memo collapses those into one spawn; the manifest cannot change
# mid-hook, so the cache is exact, not a heuristic.
__CODE_AUDITOR_PLUGIN_VERSION=""
__CODE_AUDITOR_PLUGIN_VERSION_RESOLVED=0
plugin_version() {
  if [ "${__CODE_AUDITOR_PLUGIN_VERSION_RESOLVED}" = "1" ]; then
    printf '%s' "${__CODE_AUDITOR_PLUGIN_VERSION}"
    return
  fi
  __CODE_AUDITOR_PLUGIN_VERSION="$(
    node -e 'const fs=require("fs");const p=process.argv[1];for(const f of [p+"/.claude-plugin/plugin.json", p+"/plugin.json"]){try{const v=JSON.parse(fs.readFileSync(f,"utf8")).version;if(v){process.stdout.write(v);break}}catch(e){}}' "$(plugin_root)" 2>/dev/null
  )"
  __CODE_AUDITOR_PLUGIN_VERSION_RESOLVED=1
  printf '%s' "${__CODE_AUDITOR_PLUGIN_VERSION}"
}

# semver_of <version-string> — the leading X.Y.Z (with optional -prerelease) in a
# version string, or '' when none is present. The `--version` output carries a
# "(sqlite: …)" suffix, so the pin compares only the semver, not the whole line.
semver_of() {
  printf '%s' "$1" | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?' | head -n 1 || true
}

# cli_is_compatible <cmd> — silent; 0 when `<cmd> --version` reports this plugin's
# exact version, non-zero otherwise (mismatch or undetermined). Resolution uses
# this to decide fall-through; assert_compatible remains the loud backstop.
cli_is_compatible() {
  local cmd="$1" pv cv pv_sem cv_sem
  pv="$(plugin_version)"
  cv="$($cmd --version 2>/dev/null || true)"
  pv_sem="$(semver_of "${pv}")"
  cv_sem="$(semver_of "${cv}")"
  [ -n "${pv_sem}" ] && [ -n "${cv_sem}" ] && [ "${pv_sem}" = "${cv_sem}" ]
}

# warn_stale <cmd> — one log line naming a stale installed CLI, so the user
# knows why the hook is paying the pinned install and how to restore the fast path.
warn_stale() {
  local cmd="$1" cv pv
  pv="$(semver_of "$(plugin_version)")"
  cv="$(semver_of "$($cmd --version 2>/dev/null || true)")"
  hook_log "[code-auditor] warn: ${cmd} is ${cv:-unidentified} but this plugin needs ${pv:-its version} — using the pinned install instead; update the install to restore the fast path"
}

# assert_compatible <bin> — pin the plugin to a compatible CLI.
#
# Every candidate can drift — the bundled sibling in a marketplace checkout, a
# stale global, a project-local pin, or a stale pinned install — and a 3.4.0
# plugin silently driving a 3.5.0 CLI is exactly the failure this guards. No
# candidate is trusted on presence alone: `resolve_code_audit` version-checks up
# front, and this is the loud backstop that re-checks whatever actually resolves.
#
# The comparison is semver-vs-semver (the CLI's real `--version`, not its full
# banner), and it fails loudly on a mismatch OR when either version cannot be
# determined — an unidentified binary is never trusted.
assert_compatible() {
  local bin="$1" pv cv pv_sem cv_sem
  # The pinned install's version is guaranteed by its path: `pin_dir` encodes
  # `plugin_version`, and `resolve_pinned_bin` installs exactly
  # `code-auditor-mcp@<that version>` there. A `--version` round-trip on it is a
  # full CLI process spawn (~165ms) that re-proves what the path already states,
  # so it is skipped on the per-edit hot path. Non-pinned candidates (the
  # bundled sibling, a project-local install, a global on PATH) are NOT
  # path-guaranteed — the resolver's `cli_is_compatible` already version-checked
  # them, and the full check below remains the loud backstop for any of them.
  if [ "${bin}" = "$(pin_dir)/node_modules/.bin/code-audit" ]; then
    return 0
  fi
  pv="$(plugin_version)"
  cv="$($bin --version 2>/dev/null || true)"
  pv_sem="$(semver_of "${pv}")"
  cv_sem="$(semver_of "${cv}")"
  if [ -z "${pv_sem}" ] || [ -z "${cv_sem}" ]; then
    hook_log "[code-auditor] HOOK BROKEN: cannot verify CLI version (plugin='${pv}' cli='${cv}') — refusing to run an unidentified binary"
    return 1
  fi
  if [ "${pv_sem}" != "${cv_sem}" ]; then
    hook_log "[code-auditor] version mismatch: plugin ${pv_sem} vs CLI ${cv_sem} — pin the CLI to the plugin version"
    return 1
  fi
  return 0
}
