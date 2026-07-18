# Spec 02 — MCP Surface Consolidation

**Project:** code-auditor-mcp
**Ships as:** v3.0.0 (breaking: MCP tool names and entry points change)
**Done means:** published to npm, all tests green, build clean.
**Depends on:** Spec 01 merged and published.

## Context

The server currently exposes 16 tools across three partially overlapping MCP entry points (`mcp.ts`, `mcp-index.ts`, `mcp-standalone.ts`). Sixteen tool definitions are a real context-budget tax on every MCP host that connects. This spec consolidates to one entry point and seven tools using action parameters, and adds the audit→tasks bridge that turns the task manager into the remediation half of the audit loop.

## Requirements

### R1 — Single MCP entry point

1. One MCP server module: `mcp.ts`. Delete `mcp-index.ts` and `mcp-standalone.ts`; whatever unique behavior they carry (the `--data-dir` bootstrap, standalone-mode wiring) moves into `mcp.ts`.
2. The published binary `code-auditor-mcp` starts this server. `--stdio`, `--data-dir`, and `CODE_AUDITOR_DATA_DIR` behave exactly as currently documented in the README.
3. `package.json` `bin` entries, `server.json`, and the README's Cursor/Claude config examples all point at the single entry point.

### R2 — Seven tools, action-parameterized

The 16 existing tools collapse into exactly these seven. Every existing capability maps to an action below; nothing is dropped.

| Tool | Actions | Absorbs |
|---|---|---|
| `audit` | `run` (synchronous), `start` (background job), `status`, `results`, `health` | start_audit, audit_status, audit_results, audit, audit_health |
| `search` | `query`, `definition` | search_code, find_definition |
| `index` | `sync`, `cleanup`, `reset`, `status` | sync_index |
| `config` | `get`, `set`, `reset`, `generate` (AI tool config generators) | get_analyzer_config, set_analyzer_config, reset_analyzer_config, generate_ai_config |
| `code_map` | `get`, `list` | get_code_map_section, list_code_map_sections |
| `tasks` | `create`, `list`, `get`, `update`, `complete`, `delete`, `from_audit` | project_tasks (full CRUD) + new bridge (R3) |
| `guide` | single action | get_workflow_guide |

1. Each tool takes an `action` parameter (enum, validated) plus action-specific parameters. Invalid action or missing required params returns a structured error naming the valid actions/params — the error message is the documentation an agent sees, so it must be complete.
2. Each tool's MCP description documents all its actions and their parameters concisely; total token footprint of the seven tool definitions must come in under the current 16-tool footprint. Report both numbers.
3. Existing behavior of each absorbed tool is preserved under its new action (same inputs, same outputs, modulo the action envelope).

### R3 — Audit→tasks bridge (`tasks.from_audit`)

1. New action `from_audit` on the `tasks` tool. Input: audit job id, or omitted to use the most recent completed audit. Optional filters: `severities` (default: critical + warning), `analyzers`, `paths` (globs).
2. Creates one task per violation: title from the violation summary, body carrying analyzer, rule, file, line, and the violation detail; severity maps to priority (critical→high, warning→medium, suggestion→low); related files/symbols populated from the violation location.
3. Dedupe: each violation gets a stable fingerprint (analyzer + rule + file + enclosing symbol; line numbers excluded so edits above a violation don't change identity). `from_audit` skips violations whose fingerprint matches an existing open task, and reports created/skipped counts. The fingerprint is stored on the task.
4. The fingerprint scheme is implemented as a shared utility — Spec 04 (diff-scoped auditing) and Spec 06 (SARIF partial fingerprints) reuse it. It lives in one module with its own tests.

### R4 — CLI unaffected

The `code-audit` CLI surface does not change in this spec. `cli.ts` and `index.ts` (library exports) keep their current interfaces.

## Acceptance evidence

1. `pnpm run build` clean; `pnpm test` green. New tests cover: action dispatch for all seven tools, structured errors for invalid actions, `from_audit` creation + dedupe, fingerprint stability under line-shift edits.
2. `ls src/mcp-index.ts src/mcp-standalone.ts` — do not exist.
3. Tool-count proof: server startup log or a test asserting exactly 7 registered tools.
4. Token footprint: report serialized tool-definition sizes before (16 tools, from the v2.7.0 tag) and after.
5. End-to-end transcript against the built server over stdio: `audit run` on this repo → `tasks from_audit` → `tasks list` shows created tasks → re-run `from_audit` → 0 created, all skipped.
6. `npm view code-auditor-mcp version` returns 3.0.0. CHANGELOG documents the v2→v3 tool-name migration mapping (the table in R2).

## Explicitly out of scope

- Data layer changes (Spec 03) — LokiJS remains under everything here.
- Any new audit scoping (Spec 04) or rule kinds (Spec 05).
- README repositioning beyond mechanically updating tool names and config examples (Spec 09 owns the rewrite).
