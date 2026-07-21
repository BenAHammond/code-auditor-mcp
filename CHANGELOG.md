# Changelog

All notable changes to the Code Auditor MCP project.

## [3.1.0] — 2026-07-20

### Spec-17: Signal Hotfix — Noise Reduction Across All Analyzers

Large-scale noise reduction targeting all 6 analyzers based on a real-corpus diagnostic report (3,871 files, 6,159 functions, 26,119 findings — ~96% noise). Every noise class in the diagnostic is addressed at the defect level.

#### R1: Documentation Analyzer

- **R1.1 — Anonymous callbacks skipped**: Arrow functions and function expressions used as arguments (`.map()`, `.forEach()`, event handlers) are no longer flagged. Uses AST parent-walking, not name whitelists.
- **R1.2 — Default scope is public API surface only**: Only exported functions and public class methods are flagged at default scope. Private/protected/`#`-prefixed/`_`-prefixed methods are skipped.
- **R1.3 — Minimum-size gate**: Functions with body length < `docsMinLines` (default 5) are skipped.
- **R1.4 — `scope: "all"`**: Restores broader coverage minus callbacks. Named internal functions are flagged but anonymous callbacks are still skipped.
- **R1.5 — File-header checks default OFF**: `fileHeaders` (default `false`) replaces `requireFileDocs`. When enabled, barrel/index/test/migration/config files are excluded by `headerSkipGlobs`.
- **R1.6 — Audience-reason messages**: Messages state *why* a function is in scope (e.g., "exported function without JSDoc").
- **Deprecation**: `requireFileDocs` is deprecated in favor of `fileHeaders`. It maps to `fileHeaders` for back-compat but the combined default is `false` (off). `checkExportedOnly` is replaced by `scope`.

#### R2: Schema Analyzer

- **R2.1 — SQL-context-only extraction**: Table references are now extracted only from SQL-tagged templates (`` sql`...` ``), DB-call patterns (`db.exec(...)`, `db.query(...)`), and `.sql`/migration files. The 11 raw-regex scan-all-strings approach that caused ~4,500 false positives (including "the", "node:child_process" imports) has been replaced with AST-based detection.
- **R2.2 — File gate**: `.tsx` and `.ts` files without DB imports or DB-call patterns are never scanned for schema violations.
- **R2.3 — Template expression handling**: Dynamic prefixes (`` `${prefix}_builds` ``) resolve to wildcards for known-table matching. Fully-dynamic table names produce no false findings.
- **R2.4 — Unknown-table findings**: Report extracted name, SQL statement kind, call-site line (from AST location), and nearest known-table suggestions (Levenshtein ≤ 2).

#### R3: DRY Analyzer

- **R3.1 — Self-reference fix**: A code block can no longer match itself. Span-overlap check ensures `fileA !== fileB || (endA < startB || endB < startA)`.
- **R3.2 — Minimum block size 5 → 15**: `minLineThreshold` increased from 5 to 15. Short repeated blocks no longer produce false findings.
- **R3.3 — Rule-id split**: `dry/duplicate` (warning) for exact token-identical blocks (SHA-256 hash). `dry/structural-similarity` (suggestion) for identical token-type sequences with differing identifiers/literals.
- **Fingerprint warning**: The rule-id split changes fingerprints for previously-reported structural matches. `tasks.from_audit` treats them as new findings.

#### R4: Data Access Analyzer

- **R4.1 — Loop-query (N+1) detection**: Database queries inside `for`/`while`/`do` loops and iterator callbacks (`.forEach`/`.map`/`.filter` with `await`) are now detected via AST ancestor traversal. Each finding cites the innermost loop span + query call line (never line 1).
- **R4.2 — Nested-loop attribution**: Deeply nested loops note nesting depth in the finding message.
- **R4.3 — `directAccess` config**: When set to `"allow"`, `direct-sql` and `hardcoded-connection` violations are skipped. Supports Cloudflare Workers/D1 and similar platforms where direct connections are the documented pattern. Default is `"flag"`.
- **Fixed**: Node type checks corrected from PascalCase (`CallExpression`, `NewExpression`) to tree-sitter snake_case (`call_expression`, `new_expression`). Previously prevented `isFunctionCall` from ever matching.
- **`sql-injection-risk` demoted from `critical` to `warning`**: SQL injection detection uses AST-level heuristics (string concatenation in query construction, dynamic SQL patterns) without type information. These are high-signal but not proof of exploitable injection — flagged at `warning` rather than `critical` to keep `--fail-on critical` reserved for user invariants. See "Severity Overrides" below for restoring `critical`.

#### R5: SOLID Analyzer

- **R5.1 — Method-level cyclomatic complexity → `solid/method-complexity`**: Replaced the heuristic `calculateClassComplexity()` (`1 + 2×methods + 5×extends + Σ(lines/10)`) with true cyclomatic complexity per method via `adapter.getComplexity()`. Standalone functions are also checked. Severity: `warning`.
- **R5.2 — Class-level aggregation → `solid/class-size`**: Separate rule id for class-level metrics (`classMethodsThreshold`, default 15; `classAggregateComplexity`, default 100). Severity: `suggestion`.
- **Metric-semantics change**: Complexity numbers are fundamentally non-comparable across this release. The old heuristic produced inflated values unrelated to actual branching. All prior threshold configs and reports are non-comparable across this release. This is a larger user-facing change than the rule renames.
- **Deprecation**: `maxClassComplexity` is deprecated. Use `maxMethodComplexity` and `classAggregateComplexity` instead.
- **Fingerprint warning**: The rule-id split (`single-responsibility` → `solid/method-complexity` + `solid/class-size`) changes fingerprints. `tasks.from_audit` treats them as new findings.

#### R7: Severity Defaults

All severity values normalized. No class at `critical` — the `--fail-on critical` hook path is reserved for user invariants.

| Rule | Severity |
|------|----------|
| documentation/* (all) | suggestion |
| schema/unknown-table | suggestion |
| dry/duplicate | warning |
| dry/structural-similarity | suggestion |
| data-access/loop-query | warning |
| data-access/direct-access | suggestion |
| sql-injection-risk | warning |
| solid/method-complexity | warning |
| solid/class-size | suggestion |

#### R8: Regression Fixtures

19 synthetic test fixtures in `src/analyzers/__tests__/fixtures/spec-17/` with corresponding test file `spec-17.test.ts`. Each fixture cites its report section and exercises a specific noise-reduction rule.

#### Severity Overrides

A `severityOverrides` map in analyzer config allows restoring or adjusting any rule's severity without modifying code. This is the user path back for rules whose default severity changed in this release:

```json
{
  "analyzerConfigs": {
    "data-access": {
      "severityOverrides": {
        "sql-injection-risk": "critical"
      }
    }
  }
}
```

Keys are rule IDs, values are `critical | warning | suggestion`. Overrides apply to all violations after the analyzer runs — individual analyzers don't need to know about them. The mechanism lives in the `UniversalAnalyzer` base class, so all Universal analyzers inherit it.

#### Spec 11 Triage Flag

`sql-injection-risk` is flagged first-in-line for Spec 11 measurement. The heuristic AST-level detection (string concatenation in query construction) produces findings that are high-signal but unverified without type information. Spec 11 will measure true-positive rate on the ExcAlDraw and Gin corpora to calibrate whether the detection heuristics should be tightened or the severity should be re-escalated.

### Changed — Spec-16 R5.3: Config generator re-verification

- **All 12 generators standardized to npx-based stdio MCP transport**: Replaced fictional `/api/*` HTTP endpoints (e.g. `/api/cursor`, `/api/copilot`, `/api/codeium`, `/api/awsq`, `/api/aider`, `/api/jetbrains`) with the single standard pattern: `npx -y code-auditor-mcp --mcp-mode`. This reflects the actual MCP implementation and the post-SKILL.md ecosystem where every tool supports native MCP.
- **ClaudeConfigGenerator**: Updated from Claude Desktop to Claude Code. Uses `.mcp.json` with npx transport. Instructions include skill install and hook wiring.
- **CursorConfigGenerator**: Rewrote from fictional `/api/cursor/*` endpoints to `.cursor/mcp.json` with stdio MCP. Notes: Cursor skills are project-only; `afterFileEdit` hook is advisory (fire-and-forget).
- **CopilotConfigGenerator**: Rewrote from fictional `/api/copilot/*` endpoints to `.vscode/mcp.json` with stdio MCP.
- **CodeiumConfigGenerator**: Rewrote from fictional `/api/codeium/*` endpoints to `.windsurf/mcp.json` with stdio MCP.
- **AWSQConfigGenerator**: Rewrote from fictional `/api/awsq` endpoint to `.amazonq/mcp.json` with stdio MCP.
- **AiderConfigGenerator**: Rewrote from fictional `/api/aider` endpoint to `.aider.mcp.json` with stdio MCP.
- **JetBrainsConfigGenerator**: Rewrote from fictional `/api/jetbrains` endpoint to `.idea/mcp.json` with stdio MCP.
- **ContinueConfigGenerator**: Removed fictional `/api/continue` endpoint. Retained MCP stdio transport, simplified to `.continue/mcp.json`.
- **VSCodeConfigGenerator**: Standardized to npx-based stdio MCP transport, standard `mcpServers` object format.
- **ClineConfigGenerator**: Standardized to npx-based stdio MCP transport.
- **CodexConfigGenerator (NEW)**: Added `.codex/mcp.json` generator. Codex has blocking PostToolUse hooks (exit 2 replaces tool result with violation feedback).
- **GeminiConfigGenerator (NEW)**: Added `.gemini/mcp.json` generator. Gemini CLI has no edit hooks but supports SKILL.md and MCP.
- **ConfigGeneratorFactory**: Updated with new Codex and Gemini entries. Total 12 generators, all matching the support matrix.

## [3.0.6] — 2026-07-19

### Fixed

- **#85 — `audit --fail-on` missing**: The `audit` command (default command) now supports `--fail-on <severity>` for severity-gated exit codes. Exit code 2 when violations at or above the specified severity exist. Mirrors the existing behavior on `code-audit changed`.
- **#86 — `generate-config` output**: The `generate-config` command now generates `.codeauditor.json` (invariant rules config) instead of MCP tool host configurations. Non-interactive mode writes a scaffold template with example rules for all five rule kinds. Interactive mode (`--interactive`) walks through building rules one at a time via inquirer prompts.

## [3.0.5] — 2026-07-19

### Fixed

- **#82 — `dep:` search operator**: Module-level dependencies (package names like `react`) are now stored in the `function_dependencies` table during indexing. The `dep:` operator correctly finds functions that depend on a given package.
- **#83 — `file:` search operator**: GLOB patterns are now wrapped with `*...*` wildcards so relative paths correctly match against absolute paths stored in the database.
- **#84 — Nested/inner functions**: Functions declared inside function bodies now coexist correctly in the index. Previously, same-named functions at different lines in the same file would collide due to a unique constraint on `(name, file_path)` only. Schema migration v1→v2 adds `line_number` to the unique constraint so nested functions are stored as distinct entries.

## [3.0.4] — 2026-07-19

### Fixed

- **#77 — Populate relational/derived data during indexing**: The index sync path (`FunctionScanner.scanFunctions`) was a stripped-down duplicate of `extractFunctionsFromFile` that computed zero relational data — no `functionCalls`, `usedImports`, `unusedImports`, or `complexity`. This caused `function_calls` and `function_dependencies` tables to stay empty, `complexity` to always be 0, and `has_unused_imports` to always be 0 — breaking 5 of 11 search operators (`calls:`, `dep:`, `complexity:>`, `unused-imports`). Fixed by extracting `extractFunctionsFromSource(content, filePath, options?)` as the single canonical implementation and routing both the audit runner and index sync paths through it. Also added `calculateComplexity()` for all function types (function declarations, arrow functions, class methods) — previously only computed for React components.

## [3.0.3] — 2026-07-19

### Fixed

- **#73 — Silence DEBUG logging flood**: Removed unguarded `console.error` debug lines from `UniversalSOLIDAnalyzer`, `UniversalDocumentationAnalyzer`, `UniversalAnalyzer`, and `mcp-tools-shared.ts`. Audit output reduced from ~28,000 lines to ~17 lines. Remaining debug lines are properly gated by `IS_DEV_MODE`.
- **#74 — Fix report JSON inconsistencies**: `summary.totalFiles` was always 0 (wrong source field) and `summary.topIssues` was always empty (never computed). Fixed in both `mcpAuditJobs.ts` (`summarizeAnalyzerResults`) and `auditRunner.ts` (`generateSummary`). SARIF reconstruction path now reads `topIssues` from stored summary instead of hardcoding `[]`.
- **#72 — Doc vs reality**: Fixed flag and command mismatches in `SKILL.md` — `--json` flag and `--fail-on` flag syntax corrected to match actual CLI behavior.

### Changed

- **#75 — Path scoping**: Added `docs`, `specs`, `backup`, `backups` to `DEFAULT_EXCLUDED_DIRS` in `fileDiscovery.ts`. These directories are now skipped by default during full audits to reduce noise. Explicitly targeted files are still audited regardless.

## [3.0.0] — 2026-07-17

Complete re-architecture. The entire Spec 01–09 arc ships as a single breaking release. The individual spec-architected version increments (2.7.0 through 4.0.1) were never published to npm — this is publish point one.

### Spec 01: Dead Architecture Removal & Canonical Language Layer

- **Removed** archived code: legacy `src/analyzers/` implementations predating the functional analyzer pattern, dead config generators, and the dual entry-point tangle.
- **Established** `LanguageAdapter` as the single seam for language support. All analysis paths consume `LanguageAdapter`; no analyzer imports a language-specific parser directly.
- **Canonical language layer**: `src/languages/` with `LanguageRegistry`, adapter interface (`types.ts`), and one adapter per language.

### Spec 02: MCP Surface Consolidation

- **Breaking**: MCP tool names and entry points consolidated. Seven tools replace the previous fragmented surface.

| v2 tool | v3 tool / action |
|---------|-----------------|
| `start_audit` | `audit.run` |
| `audit_health` | `audit.health` |
| `search_code` | `search.query` |
| `find_definition` | `search.definition` |
| `sync_index` | `index.sync` |
| `generate_ai_config` | removed (CLI `generate-config` for host configs) |
| `get_workflow_guide` | `guide.get` |
| — (new) | `code_map.get` |
| — (new) | `tasks` (create, list, get, update, delete, from_audit) |
| — (new) | `config` (get, set, list, rules_list, rules_check) |

- **Single entry point**: `mcp.ts` as the sole MCP server entry; `cli.ts` for the CLI. `tool-registry.ts` dispatches all tool calls.
- **Fingerprint utility**: stable violation fingerprints for dedup across audit runs.

### Spec 03: SQLite Data Layer

- **Replaced LokiJS** with `better-sqlite3`. The code index, audit results, task list, and config all live in a single SQLite database at `<cwd>/.code-index/index.db`.
- **Replaced FlexSearch** with SQLite FTS5 for full-text search.
- **`content_hash`** added to `EnhancedFunctionMetadata` for diff detection.
- **QueryParser** compiles to SQL via `compileToSQL()`.
- **Migration**: existing LokiJS data is migrated automatically on first run.
- **Tasks survive index reset**: clearing the analysis index does not delete the task list.

### Spec 04: Diff-Scoped Auditing & Agent Hook Integration

- **`code-audit changed`** command audits only files modified since the last index sync.
- **Scope options**: `changed` (default), `git:<ref>`, `[paths...]`, `--stdin`.
- **Hook contract**: `--json`, `--quiet`, `--fail-on <severity>` flags. Exit code 2 on critical violations.
- **Claude Code hook recipe**: `PostToolUse` hook on Edit/Write pipes changed file paths to `code-audit changed --stdin --json --fail-on critical`.
- **Scoped result isolation**: `getMostRecentAuditResults` filters by scope.

### Spec 05: Custom Invariant Rules Engine

- **`.codeauditor.json`** in the project root defines project-specific rules enforced on every audit run.
- **Four initial rule kinds**: `import-ban`, `call-constraint`, `module-boundary`, `naming`.
- **JSON Schema** (`invariant-rules.schema.json`) validates rule configs on startup — bad globs, duplicate IDs, missing fields fail the audit rather than being silently skipped.
- **`config rules_list`** and **`config rules_check`** MCP actions introspect the active ruleset.
- **Rule engine** (`ruleEngine.ts`) runs rules per-file during audits, including diff-scoped runs.

### Spec 06: SARIF Output

- **SARIF formatter** (`sarifReportGenerator.ts`) emits SARIF 2.1.0 for GitHub Code Scanning.
- **CLI**: `code-audit -f sarif -o results.sarif`.
- **CI recipe**: GitHub Actions workflow uploads SARIF to CodeQL for PR annotations.
- **Diff-scoped SARIF**: `code-audit changed --scope git:origin/main -f sarif` with `--sarif-category` for scoped uploads.
- **Stable fingerprints** per violation for dedup in GitHub's SARIF consumer.

### Spec 07: Claude Code Plugin & Skill Packaging (A2 Rework)

- **Skill-first packaging** (A2): The plugin contains manifest, hooks, hook script, and skill. The bundled MCP server was stripped — the skill teaches the CLI; the MCP server remains the standalone path for shell-less hosts.
- **`plugin/.claude-plugin/plugin.json`**: manifest with name `code-auditor`, version synced to package.
- **Repo as marketplace**: `.claude-plugin/marketplace.json` at repo root. Install: `claude plugin marketplace add BenAHammond/code-auditor-mcp` → `claude plugin install code-auditor`.
- **`PostToolUse` hook** on Edit/Write: pipes edited file paths to `code-audit changed --stdin --json --fail-on critical`. Degrades cleanly (exit 0 with notice) when package not installed or no index exists.
- **SKILL.md** rewritten CLI-first: teaches `code-audit changed` before claiming work complete, semantic search operators, `tasks from-audit` remediation queue, and reading invariants at session start.
- **CLI parity subcommands** (A2 R2): `code-audit search`, `code-audit map`, `code-audit tasks` — thin argv adapters over the same service layer as MCP handlers.
- **Rule-kind reference file** in the skill folder documents all five rule kinds including `ast-pattern` (Spec 08).

### Spec 08: tree-sitter Migration & `ast-pattern` Rule Kind

#### tree-sitter Migration

- **Replaced TypeScript compiler API** with tree-sitter behind the `LanguageAdapter` interface. All 16 direct TS consumers migrated to `adapterBridge.ts`.
- **`typescript` moved to `devDependencies`** — the production build no longer depends on the TS compiler.
- **`adapterBridge.ts`**: synchronous facade over tree-sitter parsers — `getASTForFile()`, `walkAST()`, `findNodes()`, `calculateComplexity()`.
- **Real Go adapter**: `GoAdapter.ts` rewritten with `tree-sitter-go` WASM grammar. Previously returned empty ASTs; now parses actual Go source.
- **WASM grammars** shipped at `dist/grammars/` (tree-sitter-typescript, tree-sitter-javascript, tree-sitter-go). Zero native compilation required — `web-tree-sitter` runtime is pure JS.
- **Parser initialization**: `initParsers()` called once at CLI boot / MCP server start. `adapterBridge` throws if used uninitialized — a loud programmer error, never silent.
- **Complexity definition**: Now documented cyclomatic complexity — decision-point count (if, for, while, do, switch_case, ternary, `&&`, `||`) + 1. This is the canonical definition; previous TS-API-based numbers may differ slightly.

#### `ast-pattern` Rule Kind

- **New invariant rule kind**: `ast-pattern` — match AST node patterns in source using `@ast-grep/napi`.
- **Pattern syntax**: ast-grep patterns (e.g., `new Function($$$)` matches any `new Function(...)` call).
- **Language support**: `typescript` (via `tsx` parser), `javascript`. Go is not supported by `@ast-grep/napi` — rules targeting Go will skip gracefully.
- **Configuration fields**: `pattern` (required, non-empty), `language` (optional, defaults to `typescript`), `path` (optional file glob filter).
- **Dogfood rule**: This repo's `.codeauditor.json` includes a `no-new-function` ast-pattern rule banning `new Function()`.

### Spec 09: Positioning Rewrite

- **Repositioned** from "multi-language code quality auditor" to "architectural invariants and code quality analysis, enforced inside your AI agent's edit loop."
- **README rewrite**: 9-section structure, agent-loop-first framing. Invariant rules moved to flagship section. Every example reproducible against the shipped version.
- **Metadata**: `package.json` description and keywords updated. `server.json` description and version updated. `plugin.json` version synced.
- **GitHub About**: updated to the R1 positioning line.

### Mid-series note

The internal version increments spec-architected for individual specs (2.7.0, 3.0.0–4.0.1) were never published to npm. The last published version before this release was 2.6.2. This 3.0.0 release absorbs the entire nine-spec arc into a single breaking release per Amendment A1.
