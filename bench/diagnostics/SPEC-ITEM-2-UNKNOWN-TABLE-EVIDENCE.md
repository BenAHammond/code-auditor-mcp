# Spec Item 2 — Unknown-Table False Positive Audit

**Date**: 2026-07-28 (revised 2026-07-30)
**Corpus**: recall-protocol (full audit via installed tarball)
**Version**: v3.4.8

## Summary

Full recall-protocol audit produced **51 `unknown-table` findings** across **13 table names**. All 51 are expected false positives — 43 from DO-local SQLite (Bucket B) and 8 from a legitimately dropped table (Bucket C). **One extraction gap** was found and fixed: `parseSqlTables()` captured single-character CTE names (`x`, `t`, `o`, `c`) and `extractAliasIdentifiers()` missed `WITH x AS (...)` and `FROM (SELECT ...) t` alias patterns. The gap's impact was concealed by the 10:1 fail-open ratio, which suppressed `unknown-table` in projects where short-CTE false positives dominated the ratio.

## Bucket Breakdown

### Bucket A — Extraction Gaps (1 gap, FIXED in v3.4.8)

**CTE and subquery alias false positives.** `parseSqlTables()` regex patterns matched single-character identifiers from CTE names (`WITH fresh AS (SELECT ...)` → `fresh` matched by FROM/JOIN patterns) and subquery bare aliases (`FROM (SELECT ...) t` → `t` matched). `extractAliasIdentifiers()` only handled two patterns — explicit `FROM x AS t` and bare `FROM x t` — missing both `WITH name AS (` and `FROM (...) alias`.

**Fix** (v3.4.8, commit `d0b47e3`):
1. `extractAliasIdentifiers()`: added CTE pattern (`WITH <name> AS (`) and subquery bare-alias pattern (`FROM (...) <alias>`)
2. `parseSqlTables()`: added minimum-length guard — identifiers shorter than 3 characters are skipped unless they appear in `allTables`
3. `allTables` Set threaded through `findTableReferences()` → `parseSqlTables()`

This gap was found by an Explore agent during v3.4.8 review and initially dismissed with circular reasoning ("fail-open suppresses it, Bucket A = 0"). The user called this out: fail-open suppression is the defect, not the fix; Bucket A = 0 is what the bug produces. The gap was real and is now fixed.

### Bucket B — Durable Object Local SQLite (43 findings, 12 table names)

Durable Object agents define SQLite schema via in-code DDL (`CREATE TABLE` statements in `.ts` files). These tables exist only in DO-local SQLite, never in migration files. The `discoverTablesFromWrangler()` pipeline only extracts from `wrangler.toml` → `migrations_dir` → `.sql` files, so DO-local tables are inherently unknown.

Table names: `strategies`, `positions`, `orders`, `executions`, `signals`, `risk_metrics`, `market_data`, `alerts`, `config`, `sessions`, `audit_log`, `cached_queries`

Not a bug — DO-local tables are structurally invisible to the migration-based discovery pipeline. A full DO-awareness feature would require parsing `CREATE TABLE` statements in agent source files and is out of scope.

### Bucket C — Dropped Table (8 findings, 1 table name)

`generation_queue` — created in migration 0058, dropped in migration 0198, still referenced by an API route. The sequential state machine in `processMigrationSource()` correctly removes it from the catalog (DROP wins), so references to it are correctly flagged.

Not a bug — the table was dropped. The API route reference is stale code, which `unknown-table` correctly surfaces.

## Extraction Gap Verification

The `findTableReferences()` pipeline handles all known gap classes:

| Gap Class | Handler | Status |
|-----------|---------|--------|
| Multi-statement `.sql` files | `processMigrationSource()` splits on `;` after stripping comments | Covered |
| `CREATE TABLE IF NOT EXISTS` | Regex matches `(?:IF\s+NOT\s+EXISTS\s+)?` | Covered |
| Quoted identifiers (`"table"`) | `stripIdentifier()` strips `""` delimiters | Covered |
| Backtick identifiers (`` `table` ``) | `stripIdentifier()` strips backtick delimiters | Covered |
| `CREATE VIRTUAL TABLE` (FTS) | Regex matches `(?:VIRTUAL\s+)?` variant | Covered |
| RENAME replay order | Sequential state machine: CREATE adds, DROP removes, ALTER TABLE RENAME TO updates references | Covered (Item 1) |
| CTE aliases (`WITH x AS (`) | `extractAliasIdentifiers()` CTE pattern | **Fixed v3.4.8** |
| Subquery bare aliases (`FROM (...) t`) | `extractAliasIdentifiers()` subquery pattern | **Fixed v3.4.8** |
| Minimum-length guard (`<3` chars) | `parseSqlTables()` skips short identifiers unless in `allTables` | **Fixed v3.4.8** |

## 10:1 Fail-Open Ratio

When unknown table references outnumber known tables by >10:1, the `unknown-table` rule is disabled with a `console.error` warning. This prevents runaway false positive storms in projects with few or no migration files. However, it also concealed the CTE/single-char extraction gap — when short-CTE false positives dominated the unknown count, the ratio gate triggered and silenced all unknown-table findings, including real ones. The minimum-length guard fixes the root cause so the ratio gate becomes a genuine safety net, not a gap concealer.

## Resolution

One extraction gap found and fixed (CTE/subquery aliases + minimum-length guard). No other code changes needed. The `unknown-table` rule is now working as designed:
- 51 findings on recall-protocol, all false positives from known categories (DO-local, dropped)
- Extraction gap fixed — CTE/subquery aliases no longer produce false positives
- Serious extraction gaps would still produce findings; the fail-open ratio is now a genuine safety net

### Adjudication Table

| Bucket | Count | Root Cause | Resolution | Status |
|--------|-------|-----------|------------|--------|
| A — CTE/subquery aliases | Unknown (concealed by fail-open) | `extractAliasIdentifiers()` missed `WITH`/subquery patterns; no minimum-length guard | Fixed in v3.4.8 | ✅ Fixed |
| B — DO-local SQLite | 43 | Tables exist only in DO-local SQLite, invisible to migration-based discovery | Wontfix (out of scope) | Expected |
| C — Dropped table | 8 | `generation_queue` dropped in migration 0198, still referenced | Stale code correctly flagged | Expected |
