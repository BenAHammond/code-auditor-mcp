# Spec 07 — Claude Code Plugin & Skill Packaging

**Project:** code-auditor-mcp
**Ships as:** v3.5.0 (npm) + plugin installable from the repo
**Done means:** published to npm, plugin installable and verified end-to-end, all tests green, build clean.
**Depends on:** Spec 06 merged and published.

## Context

The MCP server stays host-agnostic — that's settled. This spec adds a second distribution channel: a Claude Code plugin that bundles the MCP server config, hooks that make diff-scoped auditing automatic, and a skill that teaches the agent when to audit, search, and check invariants. Same engine, zero new engine behavior.

## Requirements

### R1 — Plugin structure

1. A `plugin/` directory in this repo containing a valid Claude Code plugin: `.claude-plugin/plugin.json` manifest (name `code-auditor`, version synced to package version), plus the components in R2–R4. The repo doubles as its own single-plugin marketplace (`.claude-plugin/marketplace.json` at repo root) so installation is: `claude plugin marketplace add BenAHammond/code-auditor-mcp` → `claude plugin install code-auditor`.
2. Before building, verify the current plugin/marketplace manifest format against the live Claude Code docs (docs.claude.com plugin documentation) — the format has iterated; the shipped manifests must match what the current Claude Code release actually loads. The verified doc version/date is recorded in the plugin README.

### R2 — Bundled MCP server

Plugin MCP config launches `npx code-auditor-mcp` with a project-local data dir default. Connecting is zero-config after plugin install.

### R3 — Bundled hooks

1. `PostToolUse` hook on Edit/Write tools: pipes edited file paths to `code-audit changed --stdin --json --fail-on critical` (Spec 04 contract). Critical violations block with the violation JSON fed back to the agent; warnings pass through as non-blocking output.
2. Hook degrades cleanly: if the package isn't installed or no index exists, it exits 0 with a one-line notice — a broken hook must never wedge the agent's edit loop.

### R4 — Bundled skill

`skills/code-auditor/SKILL.md` teaching the agent: when to `search`/`definition` instead of grepping (semantic and operator queries), running `audit` with the right scope before claiming work complete, checking `config rules_list` at session start so it knows the project's invariants, using `tasks from_audit` to queue remediation, and interpreting hook feedback (a blocked edit means fix the violation, not retry the edit). Written to current skill-authoring guidance; concise enough to load cheaply.

### R5 — Verification workflow

An end-to-end verification checklist executed against a real Claude Code installation, recorded as a transcript: install plugin from the repo marketplace → open a scratch project with a `.codeauditor.json` containing one invariant rule → agent connects to MCP (tool list shows the seven tools) → agent makes an edit violating the invariant → hook blocks with the rule's message → agent fixes → hook passes.

## Acceptance evidence

1. `pnpm run build` clean; `pnpm test` green. Manifest files validated in tests against their JSON structure.
2. The R5 transcript, complete.
3. Plugin README section in the main README: the two install commands, what the hook does, how to disable it.
4. `npm view code-auditor-mcp version` returns 3.5.0; plugin.json version matches.

## Explicitly out of scope

- Publishing to any external plugin marketplace beyond this repo's own.
- Packaging for other agent ecosystems (the `config generate` action already emits configs for Cursor et al.; hook recipes for other hosts remain README documentation from Spec 04).
