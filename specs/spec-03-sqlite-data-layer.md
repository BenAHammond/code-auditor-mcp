# Spec 03 — SQLite Data Layer

**Project:** code-auditor-mcp
**Ships as:** v3.1.0 (storage format changes; user-authored data migrates automatically, so non-breaking)
**Done means:** published to npm, all tests green, build clean.
**Depends on:** Spec 02 merged and published.

## Context

LokiJS is effectively unmaintained and sits at the core of the data layer; FlexSearch rides on top of it for full-text search. This spec replaces both with `better-sqlite3` + FTS5: one durable, transactional store that also lays the foundation Spec 04 needs (per-function content hashes for incremental re-audit).

## Requirements

### R1 — Storage engine

1. `better-sqlite3` replaces LokiJS. `lokijs` and `flexsearch` are removed from `package.json`.
2. Database file: `<data-dir>/index.db` (SQLite format), same path resolution rules as today (`CODE_AUDITOR_DATA_DIR` / `--data-dir` / cwd default). WAL mode on.
3. All access goes through `codeIndexDB.ts`, which keeps its role as the single data-layer module. `codeIndexService.ts`'s public interface is preserved — callers above the service layer do not change.

### R2 — Schema

Tables replacing the current Loki collections, with explicit columns for everything currently queried (not JSON blobs for queryable fields):

1. `functions` — one row per indexed function/component: name, file path, language, entity kind, signature, line span, exported flag, JSDoc presence/content, complexity, component/hook metadata, unused-import data, body content, and **`content_hash`** (SHA-256 of the normalized function body + signature). Foreign-keyed tables `function_calls (caller_id, callee_name)` and `function_dependencies` replace embedded arrays so `calls:` / `dep:` operators become indexed joins.
2. `functions_fts` — FTS5 virtual table over name, signature, JSDoc, and body, kept in sync via triggers.
3. `whitelist`, `audit_results`, `analyzer_configs`, `code_maps`, `schema_definitions`, `schema_usage`, `tasks` — mirroring current collections. `tasks` gains the `fingerprint` column from Spec 02 if not already persisted there.
4. `meta` — schema version row. `codeIndexDB.ts` owns forward migrations keyed on it.

### R3 — Query parity

1. `search/QueryParser.ts` compiles to SQL: FTS5 `MATCH` for free text, indexed `WHERE`/joins for every operator (`entity:`, `component:`, `hook:`, `dep:`, `calls:`, `lang:`, `complexity:>N`, `exported:`, `jsdoc:`, `file:`, `unused-imports`, `name:`). Every operator documented in the README's search table works identically.
2. Result ranking: FTS5 `bm25()` for free-text relevance; operator-only queries keep current ordering behavior.

### R4 — Migration of user-authored data

The function index is rebuildable and is NOT migrated — it is rebuilt by a sync. Tasks, analyzer configs, and whitelist entries are user-authored and MUST survive.

1. On startup, if `index.db` exists and is a LokiJS JSON file (detect by content, not extension), import `tasks`, `analyzer_configs`, and `whitelist` into the new SQLite database, rename the old file to `index.db.loki.bak`, and log a one-line notice including imported row counts.
2. After migration the server triggers a fresh index sync automatically so search works immediately.
3. Migration is idempotent: a `.loki.bak` alongside a valid SQLite `index.db` is left alone.

### R5 — Performance

Indexing and search on this repo (~100 files, ~26k LOC) must be at least as fast as v3.0.0. Report timings for: full sync, a free-text query, and a `calls:` query, before and after.

## Acceptance evidence

1. `pnpm run build` clean; `pnpm test` green. New tests: schema creation, every QueryParser operator against seeded fixtures, FTS trigger sync, Loki migration (fixture Loki file → tasks/configs/whitelist preserved, counts asserted), migration idempotency.
2. `grep -rn "lokijs\|flexsearch" src/ package.json` — zero matches.
3. `content_hash` populated for every row in `functions` after a sync (test asserts no NULLs).
4. Migration transcript: run v3.0.0 against a temp dir, create 2 tasks + 1 analyzer config + 1 whitelist entry, upgrade to this build, show all survive and `index.db.loki.bak` exists.
5. Performance table from R5.
6. `npm view code-auditor-mcp version` returns 3.1.0.

## Explicitly out of scope

- Diff-scoped auditing itself (Spec 04) — this spec only stores the hashes.
- Any change to what gets indexed or how analyzers behave.
- vitest upgrade.
