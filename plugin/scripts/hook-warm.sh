#!/usr/bin/env bash
# code-auditor SessionStart hook — warm the npx cache before the first edit.
#
# A marketplace install has no lifecycle step, so the pinned npx fallback's cold
# fetch (~5.7s download of the package's native binaries) would otherwise land on
# the first Write/Edit after install — the kind of apparent hang people disable
# hooks over. This hook warms that cache at session start, before any edit.
#
# Deliberately non-blocking and silent:
#   - the npx fetch is backgrounded (nohup + &) and this script returns
#     immediately, so it never delays session start;
#   - every failure (offline, npx missing, unreadable manifest) is a quiet no-op —
#     a warm-the-cache nicety must never complain or fail the session.
# `--prefer-offline` makes a warm cache a pure cache hit (no registry metadata
# re-check on every launch) while still fetching on a cold cache.
set -uo pipefail

# Belt-and-suspenders: the hooks.json command already guards an unset
# CLAUDE_PLUGIN_ROOT, but keep the warm a no-op if it is somehow absent here.
[ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || exit 0

# Shared version lookup (plugin_version / semver_of).
. "${CLAUDE_PLUGIN_ROOT}/scripts/hook-common.sh"

# Nothing safe to warm if the manifest version can't be read: warming @latest
# could pin a different version than resolve_code_audit's fallback would fetch.
pv="$(plugin_version)"
[ -n "${pv}" ] || exit 0

# Background the exact pinned fetch the hook's last-resort path runs. Output to
# /dev/null (silent), stdin from /dev/null (don't hold the hook's stdin open),
# nohup so the fetch survives this hook's exit.
nohup npx --prefer-offline -y -p "code-auditor-mcp@${pv}" code-audit --version >/dev/null 2>&1 </dev/null &
exit 0
