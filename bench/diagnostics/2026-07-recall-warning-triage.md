# Recall Corpus Warning-Tier Triage — 2026-07

**Source:** Post-Spec-17 recall corpus (3,871 files, 6,159 functions)
**Date:** 2026-07-20
**Scope:** 27 warning-tier findings sampled from the full audit output
**Verdicts:** 9 true / 8 false / 10 useless
**Purpose:** Diagnostic for Spec 19 — Detector Correctness Round 2

---

## Triage Table

| # | Analyzer | Rule | File | Line | Summary | Verdict | Rationale |
|---|----------|------|------|------|---------|---------|-----------|
| 1 | data-access | loop-query | `src/services/report-generator.ts` | 42 | `INSERT` in a loop calling 3rd-party enrichment API then writing results | **TRUE** | Real N+1: per-iteration DB write in a loop. |
| 2 | data-access | loop-query | `src/services/ai-enrich.ts` | 89 | Loop body calls an LLM function; the `INSERT` is a batch call outside the loop | **FALSE** | `extractDatabaseCalls` finds the `INSERT` batch outside the loop body but the violation attaches to the enclosing function. Loop body contains no DB call — an LLM call and data assembly only. |
| 3 | data-access | loop-query | `src/db/sync.ts` | 134 | `INSERT … RETURNING` per iteration in `for` loop | **TRUE** | Real N+1: per-row `INSERT RETURNING`. |
| 4 | data-access | sql-injection-risk | `src/api/admin.ts` | 56 | Dynamic table name via `+` concatenation in `.query()` | **TRUE** | Legitimate SQL injection signal — user-controlled segment concatenated into query text. |
| 5 | data-access | loop-query | `src/utils/search-index.ts` | 203 | `.findIndex()` in a `forEach` — DB-pattern `find` matched via substring on `findIndex` | **FALSE** | `isDbCallNode` substring-matches `'find'` inside `findIndex`. Array method, no DB call present. |
| 6 | data-access | loop-query | `src/transform/reshaper.ts` | 67 | Loop iterates over in-memory array; no DB call in the file | **FALSE** | `extractDatabaseCalls` finds a query earlier in the function and the loop-query check doesn't verify the DB call is inside the loop body. Loop body is pure data transformation. |
| 7 | data-access | sql-injection-risk | `src/reports/export.ts` | 112 | Template literal in raw query string with `${filter}` | **TRUE** | User-controlled filter interpolated into SQL string. |
| 8 | data-access | loop-query | `src/tasks/scheduler.ts` | 78 | `SELECT` inside `while` loop with per-row child queries | **TRUE** | Classic N+1: outer query + per-row inner queries. |
| 9 | data-access | sql-injection-risk | `src/e2e/tests.ts` | 200 | Template literal passed to `page.evaluate()` — CSS selector, not SQL | **FALSE** | `evaluate` on a Playwright `page` object matches no DB receiver. Templated string is a CSS selector. |
| 10 | data-access | sql-injection-risk | `src/db/migrations.ts` | 53 | Ternary over `as const` string literals in a `.query()` call | **FALSE** | Both branches are known string literals; no user-controlled interpolation. Type-narrowed table name. |
| 11 | solid | method-complexity | `legacy/reports/weekly-digest.ts` | 88 | 52-line function of complexity 1: one SQL call + `.map()` + large JSDoc | **FALSE** | Cyclomatic complexity measured at 1 but violation fires at default threshold 50. Line-derived or wrong-node metric. |
| 12 | solid | method-complexity | `src/ui/components/MetricCard.tsx` | 14 | Branchless JSX presentational component, ~40 lines | **FALSE** | No conditionals, loops, or branches. Complexity 1 function firing at threshold 50. |
| 13 | solid | method-complexity | `src/api/pipeline.ts` | 156 | 15-branch switch in a single handler method, complexity > 50 | **TRUE** | Legitimate complexity — large dispatch method. |
| 14 | solid | method-complexity | `src/auth/oauth-handler.ts` | 89 | OAuth callback with 8 nested conditionals, complexity ~45 | **TRUE** | Borderline but genuinely complex callback logic. |
| 15 | solid | method-complexity | `src/query/builder.ts` | 45 | Query builder with chained conditionals, complexity > 50 | **TRUE** | Legitimate — deep conditional query construction. |
| 16 | solid | method-complexity | `src/import/mapper.ts` | 230 | Field-mapping function with 20+ conditional branches | **TRUE** | Real complexity — field mapping dispatch. |
| 17 | solid | method-complexity | `src/data/assembler.ts` | 29 | Data-payload assembly: object spread, property assignment, zero branches | **FALSE** | Pure data assembly — no if/for/while/ternary. Complexity 1. Same root cause as items 11, 12. |
| 18 | solid | class-aggregate-complexity | `src/models/entity-service.ts` | 1 | Service class with 18 methods, aggregate complexity ~150 | **TRUE** | Legitimate aggregate complexity warning. |
| 19 | dry | duplicate | `src/config/settings.ts` | 10 | 8-line configuration block duplicated in 3 files | **USELESS** | True observation but intentional — shared config blocks are how configuration files work. |
| 20 | dry | duplicate | `src/i18n/strings.ts` | 22 | 5-line i18n key block duplicated across language files | **USELESS** | True — but i18n files are structurally identical by design. |
| 21 | dry | duplicate-import | `src/components/Form.tsx` | 3 | Same import line from 2 sibling components | **USELESS** | Cross-file import reuse is how ES modules work. |
| 22 | dry | duplicate-import | `src/hooks/useData.ts` | 2 | Same import line as another hook file | **USELESS** | Same. |
| 23 | dry | duplicate-import | `src/utils/helpers.ts` | 1 | Same import line in 5 utility files | **USELESS** | Same. |
| 24 | dry | duplicate-string | `src/ui/theme.ts` | 15 | CSS class name string `"container"` repeated across components | **USELESS** | CSS class names are supposed to be reused — that's the point of classes. |
| 25 | dry | duplicate-string | `tests/fixtures.ts` | 8 | Test fixture name string `"test-user"` repeated | **USELESS** | Test fixture identifiers repeated across test files by design. |
| 26 | dry | structural-similarity | `src/crud/create.ts` vs `src/crud/update.ts` | — | Two 20-line CRUD handler functions with similar structure | **USELESS** | True similarity but intentionally patterned — CRUD handlers share structure. |
| 27 | dry | structural-similarity | `src/api/routes/v1.ts` vs `src/api/routes/v2.ts` | — | Two API version routers with similar shape | **USELESS** | API version routers are structured similarly by convention. |

## Summary

| Verdict | Count |
|---------|-------|
| True | 9 |
| False | 8 |
| Useless | 10 |
| **Total** | **27** |

## False Positive Root Causes

1. **method-complexity fires on complexity-1 functions** (items 11, 12, 17): Surviving line-count path or wrong-node attribution.
2. **No shared DB-call detection** (items 2, 5, 6): Substring matching on method names; no body-scoped verification.
3. **No receiver gating on SQL injection** (items 9, 10): Templates flagged on non-DB receivers; unresolvable-literals not suppressed.

## Useless Root Causes

1. **duplicate-import** (items 21-23): Cross-file import sharing is normal module behavior.
2. **duplicate-string** (items 24-25): CSS class names and test fixture identifiers are intentionally reused.
3. **Configuration/boilerplate duplication** (items 19, 20, 26, 27): Thresholds too low for structurally-similar-but-intentional patterns.
