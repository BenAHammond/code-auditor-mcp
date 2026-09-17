#!/usr/bin/env bash
# code-auditor SessionStart hook — warm the pinned CLI install before the first edit.
#
# A marketplace install has no lifecycle step, so the pinned fallback's cold fetch
# (~5.7s download of the package's native binaries) would otherwise land on the
# first Write/Edit after install — the kind of apparent hang people disable hooks
# over. This hook installs the pinned CLI at session start, before any edit.
#
# Deliberately non-blocking and silent:
#   - the install is backgrounded (nohup + &) and this script returns immediately,
#     so it never delays session start;
#   - every failure (offline, npm missing, unreadable manifest) is a quiet no-op —
#     a warm-the-cache nicety must never complain or fail the session.
# `--prefer-offline` makes a warm npm cache a pure cache hit (no registry metadata
# re-check on every launch) while still fetching on a cold cache. When the CLI is
# already installed at its deterministic dir, the script exits without touching npm
# at all — a warm session must not re-check on every launch.
set -uo pipefail

# Belt-and-suspenders: the hooks.json command already guards an unset
# CLAUDE_PLUGIN_ROOT, but keep the warm a no-op if it is somehow absent here.
[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || exit 0

# Shared version lookup (plugin_version / semver_of / pin_dir).
. "${CLAUDE_PLUGIN_ROOT}/scripts/hook-common.sh"

# Nothing safe to warm if the manifest version can't be read: warming @latest
# could pin a different version than resolve_code_audit's fallback would fetch.
pv="$(plugin_version)"
[ -n "${pv}" ] || exit 0

dir="$(pin_dir)"
bin="${dir}/node_modules/.bin/code-audit"

# Already installed — nothing to warm. Re-running npm install here would re-check
# the registry on every session, which is exactly the cost this hook exists to avoid.
[ -x "${bin}" ] && exit 0

# Background the exact install the hook's last-resort path runs. Output to
# /dev/null (silent), stdin from /dev/null (don't hold the hook's stdin open),
# nohup so the install survives this hook's exit.
nohup npm install --prefer-offline --prefix "${dir}" "code-auditor-mcp@${pv}" \
  --no-audit --no-fund --ignore-scripts --silent >/dev/null 2>&1 </dev/null &
exit 0
