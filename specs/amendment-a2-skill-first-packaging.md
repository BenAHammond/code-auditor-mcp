# Amendment A2 — Skill-First Packaging & Automated E2E (supersedes parts of Spec 07)

**Applies to:** Spec 07 as built. This is rework of a completed spec; it reopens `spec-07` (tag moves to the rework's completion commit).
**Supersedes:** Spec 07 R2 (bundled MCP server), R4 (skill content), R5 (verification workflow), and the manifest versioning as built.

## Context

The plugin as built bundles the MCP server, which pays the standing tool-schema token tax (~2–4k tokens per session) in exactly the host — Claude Code — that has shell access and therefore doesn't need it. Distribution is skill-first: the skill teaches the CLI; the MCP server remains the standalone side door for shell-less hosts and is not part of the plugin. Additionally, no acceptance evidence in this series may depend on a manual step by Ben; all evidence is produced by the implementor.

## R1 — Strip the bundled MCP server

1. Delete `plugin/.mcp.json`. The plugin contains: manifest, hooks, hook script, skill. Nothing else.
2. The standalone MCP server (`code-auditor-mcp` binary, `mcp.ts`, seven tools) is unchanged — it remains the documented path for shell-less hosts. The main README's MCP section stands; the plugin README states plainly that the plugin does not use MCP and why (the skill + CLI path is cheaper and equivalent where shell exists).

## R2 — CLI parity subcommands

The skill-first path requires the CLI to cover what only MCP tools exposed. Add to `cli.ts`, calling the same service layer as the MCP handlers (no logic duplication — thin argv adapters over existing services):

1. `code-audit search <query>` — full QueryParser syntax; flags: `--limit`, `--language`, `--json`. `code-audit search --definition <name>` for `find_definition`.
2. `code-audit map [--list | --section <id>]` — code map sections; `--json`.
3. `code-audit tasks <create|list|get|update|complete|delete|from-audit>` — mirroring the `tasks` tool's actions and parameters as flags; `--json` on all.
4. Human-readable default output, `--json` for machine consumption, exit codes consistent with existing CLI conventions.
5. README's CLI section documents the new subcommands.

## R3 — SKILL.md rewritten CLI-first

1. The skill teaches the CLI exclusively: `code-audit changed` before claiming work complete, `code-audit search`/`--definition` instead of grep for semantic/operator queries, `code-audit tasks from-audit` for the remediation queue, reading the project's invariants at session start (`rules_check`/rules listing via CLI), and interpreting a hook block (fix the violation; do not retry the edit or bypass the hook).
2. Reference material (rule-kind reference, search operator table) lives in companion files inside the skill folder, loaded on demand — SKILL.md itself stays lean.
3. The skill folder (`plugin/skills/code-auditor/`) must work standalone: the plugin README documents that copying the folder into any skills-capable agent's skills directory is a supported install, independent of the plugin.

## R4 — Manifest versioning

`plugin/.claude-plugin/plugin.json` version: `3.0.0`, per Amendment A1. It changes only at publish points, in the same commit that sets `package.json`.

## R5 — Automated end-to-end evidence (replaces manual transcript)

All produced by the implementor, no manual steps:

1. **Plugin load transcript:** in a scratch directory, `claude plugin marketplace add <repo path>` → `claude plugin install code-auditor` → `claude plugin list` showing the plugin loaded. Captured verbatim. This proves Claude Code actually parses and loads the manifests — the thing schema tests cannot prove.
2. **Hook contract transcript:** scratch project with a `.codeauditor.json` containing one invariant rule; pipe a fixture PostToolUse JSON payload (an Edit touching a violating file) into `plugin/scripts/hook-audit.sh`; assert blocking output containing the rule's message and exit code 2. Apply the fix; re-run; assert clean pass. Also assert the degradation path: run in a directory with no index/package → exit 0 with the one-line notice.
3. **Skill accuracy check:** every command the SKILL.md and its reference files instruct an agent to run is executed verbatim against the built package and succeeds. A skill that teaches commands that error is a failed gate.

## Unchanged from Spec 07 as built

Hooks configuration and `hook-audit.sh` (R3 as built), the marketplace structure (R1 as built), manifest schema tests, and the main-README plugin install section — except where R1–R4 above touch them.
