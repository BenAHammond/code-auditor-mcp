# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.2] - 2026-03-26

### Changed
- **MCP request reliability hardening** — Call handlers now honor request abort signals, compact JSON serialization is used for tool payloads, and `project_tasks` read paths de-duplicate concurrent identical reads.
- **Process resilience defaults** — Runtime `unhandledRejection` / `uncaughtException` handling is now non-fatal by default (fatal exit remains opt-in via `CODE_AUDITOR_EXIT_ON_FATAL=1|true`) to avoid tearing down the entire stdio session from one rejected request.

### Fixed
- **Concurrent initialization race** — `CodeIndexDB.initialize()` now uses single-flight guarding so overlapping first requests cannot race DB initialization.
- **`project_tasks list_tree` load behavior** — `limit` is enforced correctly and descendant statistics are computed with memoized traversal, reducing response latency and oversized payload risk under parallel calls.
- **Diagnostics I/O blocking** — `CODE_AUDITOR_LOG_FILE` appends are queued asynchronously instead of synchronous per-line writes, preventing event-loop stalls during high call volume.

## [2.6.1] - 2026-03-25

### Fixed
- **Persist cached audits immediately** — `storeAuditResults` now calls `saveDatabase()` after insert so `resultId` survives MCP server restarts and reconnects (Loki had autosave disabled; audit rows often never reached disk until another tool triggered a save).

## [2.6.0] - 2026-03-25

### Added
- **Whole-job time limit** — `start_audit` accepts `jobTimeoutMs` (default from env `CODE_AUDITOR_JOB_TIMEOUT_MS`, cap 4h). Aborts shard work via `AbortSignal`, sends cooperative `cancel-request` to workers, then tears down the pool.
- **Cooperative worker cancel** — `cancel-request` aborts in-process analysis; runner checks `abortSignal` between analyzers, on analyzer progress, and during function indexing.
- **File-chunk handoff** — Optional `maxFilesPerRun`: workers emit `worker-handoff` with `continuation` (`explicitFiles`); parent merges partial results and queues the next chunk (often on a fresh worker).
- **Per-worker soft budget** — Optional `shardSoftBudgetMs` aborts a shard via `AbortSignal` so the parent can recycle the process (does not auto-split remaining files; use `maxFilesPerRun` for that).
- **`explicitFiles` discovery** — Runner can analyze an explicit path list (used for handoff continuations).

### Changed
- **Worker IPC hygiene** — Forked workers use `stdio: ignore` for non-IPC fds (avoids MCP stdout corruption); shard timeout sends `cancel-request` before SIGTERM; pool completion uses empty queue + pending + running counts (supports dynamic handoff work).
- **Process safety** — Background `runAuditJob` failures are caught so rejected promises cannot take down the MCP parent; worker pool replenishment on unexpected child exit.

### Fixed
- **Node ESM runtime** — `export type` re-exports for `AuditConfig` and `AuditProgress` / `AuditRunnerOptions` in config loader and audit runner (avoids “does not provide an export named …” when spawning workers or running benchmarks under `tsx`).

## [2.5.0] - 2026-03-24

### Added
- **True worker-process shard execution** — Background audits now execute shard tasks in child processes using IPC (`run-audit-shard`, progress, result, error) instead of in-process deferred callbacks.
- **Worker pool resilience controls** — `start_audit` accepts `workerCount`, `maxRetries`, `shardTimeoutMs`, and `retryBackoffMs` for parallelism/fault-tolerance tuning.
- **Worker and merge coverage** — Added worker IPC tests (`auditWorker.spec.ts`) and merge/retry behavior tests in `mcpAuditJobs.spec.ts`.
- **Benchmark harness** — Added `bench:workers` script (`src/scripts/benchmarkWorkers.ts`) for baseline single-worker vs partitioned worker comparisons.

### Changed
- **Deterministic shard merge semantics** — Analyzer result merging now de-duplicates duplicate violations by stable key while preserving analyzer ordering.
- **Cross-platform process cleanup hardening** — Worker shutdown now uses safe termination with fallback kill behavior.

## [2.4.0] - 2026-03-26

### Added
- **Top-level folder sharding for background audits** — `start_audit` now supports `partitionStrategy` (`none|auto|top-level`), `maxPartitions`, and `partitionThresholdFiles`. In `auto`, large codebases with source roots like `app`/`src` are split into partitions for parallel execution.
- **Tests for new execution model** — Added partition planning tests (`mcpAuditJobs.spec.ts`) and job lifecycle state tests (`auditJobService.spec.ts`).

### Changed
- **Analyzer-aware partitioning** — Global analyzers (`dry`, `data-access`, `schema`) run once across full scope while partition-safe analyzers run concurrently per shard; results are merged deterministically.
- **Parallel execution controls** — `analyzerConcurrency` now combines with partition sharding to speed up heavy runs while preserving stable analyzer ordering in output.
- **MCP debug verbosity** — High-volume raw request/response dumps moved behind `CODE_AUDITOR_TRACE=1`; normal `CODE_AUDITOR_DEBUG=1` is quieter and suppresses repetitive `audit_status` call logs.

## [2.3.0] - 2026-03-26

### Added
- **Background audit lifecycle tools** — New MCP tools: **`start_audit`** (enqueue and return `jobId`), **`audit_status`** (queued/running/completed/failed with `resultId`), and **`audit_results`** (paged reads by `resultId`).
- **In-memory audit job service** — Tracks job timestamps, progress snapshots, terminal status, `resultId`, and errors for polling clients.
- **Analyzer concurrency control** — `AuditRunnerOptions.analyzerConcurrency` enables bounded parallel analyzer execution.

### Changed
- **`audit` tool behavior** — Now fetch-only (paged result retrieval by `resultId` / `auditId` alias). It no longer starts new audits implicitly.

## [2.2.3] - 2026-03-26

### Fixed
- **`audit` with `auditId`** — When loading a cached audit for pagination, the server no longer re-runs function indexing (`syncFileIndex` over the whole tree) or code-map generation on every page request. Violations were already read from the DB; those extra steps made “cache-only” paging slow. Responses include **`pagination.cachedPage: true`** when this fast path is used.

## [2.2.2] - 2026-03-25

### Fixed
- **`audit` tool (stdio / `mcp-index`)** — Matches standalone behavior: caches full results (when `useCache` is true), returns `pagination` with `total`, `hasMore`, `nextOffset`, and `auditId`, and supports `auditId` + `offset` + `limit` to read cached violation pages without re-running a full audit. Tool schema now documents `limit`, `offset`, `auditId`, and `useCache`.

## [2.2.1] - 2026-03-25

### Fixed
- **MCP stdio transport** — The server’s `console.log` override now forwards to stderr instead of stdout. Analyzer and adapter `console.log` output no longer corrupts the JSON-RPC stream (fixes clients reporting `Unexpected token ... is not valid JSON` during audits).

## [2.2.0] - 2026-03-25

### Added
- **Documentation (docs site)** — Task management section on the marketing site (`How It Works`), expanded **`TOOLS-DOCUMENTATION.md`** with **`project_tasks`** (actions, `projectPath` default, persistence vs `sync_index` reset), workflow example, and best-practices notes.
- **`project_tasks` default `projectPath`** — When omitted for `list` / `create`, defaults to `process.cwd()`; responses include `projectPathDefaulted` when applicable.

### Changed
- **MCP stderr logging** — High-volume debug traces (per-request dumps, audit progress, tool lifecycle) gated behind **`CODE_AUDITOR_DEBUG=1`** (`mcpDebugStderr`, `logMcpDebug`); quieter default startup line with tool count and version.
- **Contextual tool errors** — `ContextualError` / `formatMcpToolErrorPayload` for storage and audit path failures with actionable `context` (errno, hints).
- **Audit cache / pagination (standalone)** — `initialize()` before cached audit lookup; numeric `offset`/`limit`; `storeAuditResults` keeps canonical `auditId` after spread.

### Fixed
- **`applyDataDirEnv`** — Warns when `--data-dir` is missing a path (e.g. next token is another flag).

## [1.6.0] - 2024-12-21

### Added
- **Content Search** - Search within function bodies, not just metadata
  - New `searchMode` parameter: `metadata`, `content`, or `both`
  - Match context shows 2 lines before/after matches
  - Line-level match tracking with line numbers and columns
- **Enhanced Query Parsing** - Improved handling of complex queries
  - Support for nested quotes in search queries
  - Better handling of escaped characters
  - Proper parsing of queries like `"column: 'country'"`
- **Unused Imports Configuration** - Added configurable options for unused import detection
  - `checkLevel`: Choose between function-level or file-level analysis
  - `includeTypeOnlyImports`: Option to include/exclude type-only imports
  - `ignorePatterns`: Regex patterns to ignore specific imports (e.g., React)
- **DRY Analyzer Unused Import Detection** - DRY analyzer now detects and reports unused imports
  - New `checkUnusedImports` configuration option (default: true)
  - Reports unused imports as DRY violations with severity 'suggestion'
  - Properly handles namespace imports, named imports, and default imports
  - Excludes import declarations from usage detection to avoid false negatives

### Fixed
- **Unused Import Detection** - Fixed major issues causing ~40% false positive rate
  - Namespace imports (`import * as name`) now properly tracked when used
  - Property access on imported objects now correctly detected (e.g., `config.database.host`)
  - Method calls on imported objects now tracked (e.g., `logger.error()`)
  - DRY analyzer now properly reports unused imports as violations (not just metadata)
- **Search Results** - Now returns line-level matches instead of just function-level
- **File Filtering** - Improved file path filtering logic
  - Supports exact matches, glob patterns, and substring matching
  - Properly restricts results to specified file paths
- **Function Body Indexing** - Fixed missing body extraction for arrow functions and methods
- **FlexSearch Configuration** - Added body field to search index
- **SRP False Positives** - Fixed Single Responsibility Principle detection
  - No longer flags single-element responsibility groups
  - Better grouping logic for related functionality

## [1.2.0] - 2024-12-20

### Changed
- **Simplified MCP tool set** - Reduced from 16 tools to 6 core tools for better usability
  - `audit_run` → `audit` - Now handles both files and directories
  - `audit_check_health` → `audit_health` - Clearer naming
  - `search_functions` → `search_code` - Better reflects natural language search capability
  - `generate_ai_configs` → `generate_ai_config` - Consistent singular naming
  - Combined `bulk_cleanup`, `deep_sync`, `clear_index` → `sync_index` with modes
  - Removed redundant tools: `audit_analyze_file`, `register_functions`, `index_functions`, `audit_list_analyzers`, `list_ai_tools`, `get_ai_tool_info`, `validate_ai_config`

### Added
- Function indexing during audits - audit tools now index functions by default (set `indexFunctions: false` to disable)
- Avoids duplicate file parsing by collecting functions during the audit process
- New `sync_index` tool with modes: `sync` (default), `cleanup`, `reset`
- Audit tools now use `syncFileIndex` to properly handle function deletions, additions, and updates

### Fixed
- Fixed MCP standalone server trying to pass non-existent `--json` flag to CLI
- MCP tools (`audit`, `audit_health`) now work correctly via npx and Claude
- Updated mcp-standalone.ts to support all 6 simplified tools (was missing 4 tools)

## [1.1.0] - 2024-12-20

### Added
- **Enhanced Code Index with FlexSearch** - Full-text search with intelligent tokenization
  - Natural language search queries (e.g., "validate email", "user authentication")
  - CamelCase/PascalCase tokenization for better search results
  - Synonym expansion for common programming terms
  - Multi-strategy search (exact match, AND logic, OR logic)
  - Support for search operators (type:, param:, lang:)
  
- **AI Tool Configuration Generator** - Auto-generate configurations for AI coding assistants
  - Support for 10+ AI tools: Cursor, Continue, Copilot, Claude, Zed, Windsurf, Cody, Aider, Cline, PearAI
  - Automatic MCP server URL configuration
  - Validation tool for generated configurations
  
- **Index Maintenance Tools**
  - `bulk_cleanup` - Remove entries for deleted files
  - `deep_sync` - Re-scan all indexed files to update signatures
  - File synchronization support for incremental updates
  
- **Query Parser** - Advanced search query parsing
  - 30+ synonym groups for common programming terms
  - Phrase search support
  - Exclusion terms support
  - Filter operators for precise searches
  
- **Comprehensive Documentation**
  - TOOLS-DOCUMENTATION.md with detailed usage examples
  - Workflow integration guide
  - Best practices for "search before code" methodology

### Fixed
- Multi-word search queries now work correctly
- Function names with camelCase/snake_case are properly searchable
- Search index properly updates when files change

### Changed
- FlexSearch configuration updated from 'forward' to 'full' tokenization
- Search results now include relevance scores
- CodeIndexDB now uses singleton pattern for better resource management

## [1.0.1] - 2024-12-15

### Initial Release
- SOLID principles analyzer
- DRY (Don't Repeat Yourself) analyzer
- Security pattern analyzer
- Component architecture analyzer
- Data access pattern analyzer
- MCP server integration
- Multiple output formats (HTML, JSON, CSV)
- Framework-specific configurations