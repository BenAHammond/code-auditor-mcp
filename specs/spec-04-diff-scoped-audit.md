# Spec 04 — Diff-Scoped Auditing & Agent Hook Integration

**Project:** code-auditor-mcp
**Ships as:** v3.2.0
**Done means:** published to npm, all tests green, build clean.
**Depends on:** Spec 03 merged and published (content hashes, SQLite store).

## Context

This is the product bet: the audit engine becomes fast enough to sit inside an agent's edit loop. An agent edits code, the auditor re-audits only what changed, and violations land back in the agent's context before it moves on. This spec delivers the scoping engine, the CLI surface for hook wiring, and the MCP surface; Spec 07 packages the Claude Code integration.

## Requirements

### R1 — Audit scopes

Every audit invocation (MCP `audit run`/`start`, CLI `code-audit`, library API) accepts a `scope`:

1. `all` — current behavior, the default when no scope is given.
2. `files` — explicit list of file paths/globs.
3. `changed` — files whose content differs from the index: re-parse candidate files, hash functions, and select only functions whose `content_hash` differs from the stored value (plus new functions; deleted functions are removed from the index and their open violation state cleaned up).
4. `git:<ref>` — files reported by `git diff --name-only <ref>` (plus untracked files), then function-level narrowing as in `changed`. Requires a git worktree; structured error if absent.

### R2 — Analyzer scoping semantics

Scoped audits must not produce false negatives from missing context:

1. Per-function/per-file analyzers (SOLID, React, Documentation, Data Access, Schema, and the invariant analyzer once Spec 05 lands) run only over the scoped function set.
2. DRY compares scoped functions against the **full index**, not just the scope — a newly written duplicate of an existing function must be caught. Pairs entirely outside the scope are not re-checked.
3. Scoped results are marked `scope` in the result payload and are stored distinctly from full-audit results — a scoped audit never overwrites or masks the most recent full audit's stored results. `tasks.from_audit` works on scoped results.

### R3 — Incremental sync on audit

A scoped audit updates the index for the files it touched (upsert functions, refresh hashes, delete removed) as part of the run — one pass, not a separate sync step.

### R4 — CLI hook surface

1. New subcommand: `code-audit changed [paths...]`. With paths: scope = those files. Without: scope = `changed`. Flags: `--json` (machine-readable violations to stdout), `--quiet` (suppress output when zero violations), `--fail-on <severity>` (nonzero exit — exit code 2 — when violations at/above the severity exist; default `critical`).
2. `--json` output schema: array of violations with analyzer, rule, severity, message, file, line span, enclosing symbol, and the Spec 02 fingerprint. Schema documented in the README and stable (SARIF in Spec 06 builds on the same violation model).
3. Reads file paths from stdin (one per line) when invoked as `code-audit changed --stdin`, so any hook system that pipes paths can drive it.

### R5 — Performance target

A scoped audit of 1–5 edited files on this repo completes in under 1 second end-to-end (process start to output), measured with a warm index. Report the measurement. If process startup dominates, server mode via MCP `audit run` with `files` scope is the fast path and its latency is reported too — both paths must exist; the sub-second target applies to at least the MCP path.

### R6 — Hook recipe documentation

README gains an "Agent loop integration" section with a copy-pasteable Claude Code `PostToolUse` hook example invoking `code-audit changed --stdin --json --fail-on critical`, and a note that the same CLI contract works for any hook system (pre-commit, lint-staged, other agents). This is documentation only; packaged plugin ships in Spec 07.

## Acceptance evidence

1. `pnpm run build` clean; `pnpm test` green. New tests: hash-based change detection (edit one function in a two-function file → exactly one function re-audited), new/deleted function handling, DRY-against-full-index catch of a fresh duplicate, `git:<ref>` scope against a fixture repo, exit-code behavior of `--fail-on`, stdin path feeding.
2. Transcript: full audit → edit one file introducing a SOLID violation → `code-audit changed --json` reports it and nothing else → fix → `code-audit changed --quiet` exits 0 silently.
3. Timing report per R5.
4. Scoped result isolation: full audit results still retrievable unchanged after a scoped run (test).
5. `npm view code-auditor-mcp version` returns 3.2.0.

## Explicitly out of scope

- Invariant rules (Spec 05) — the invariant analyzer joins scoped runs when it lands.
- SARIF (Spec 06).
- Claude Code plugin packaging (Spec 07).
