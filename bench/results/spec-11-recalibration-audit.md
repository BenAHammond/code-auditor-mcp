# Spec 11 R5 Recalibration Audit

**Date:** 2026-07-20
**Auditor:** Claude (directed by binding plan)
**Scope:** The recalibration table at `bench/results/recalibration.md` that disabled six data-access/schema rules and promoted three SOLID rules in `src/config/defaults.ts`

## Methodology

This audit compares three independent evidence sources:

1. **The recalibration triage** (`triage-classified.json`, `triage-report.md`): 691 findings from code-auditor self-audit, classified by the implementer
2. **The 27-sample external triage** (`bench/diagnostics/2026-07-recall-warning-triage.md`): 27 warning-tier findings from a post-Spec-17 recall corpus (Gin-like external TypeScript project), classified with hash-assertion
3. **The Spec 19 oracle** (`spec-19-oracle-evidence.md`): Oracle rerun results on known-correct detectors

## Per-Finding Triage Data

### loop-query — Self-Audit (50 findings from `triage-classified.json`)

**Verdicts:** 0 true / 40 false / 10 true-but-useless
**Judged-true:** 0/(0+40) = 0.00

#### False positives — Test fixtures (15 findings)

These are in test fixtures, bench corpora, or spec-19 oracle items. Correctly classified as false per the triage rubric ("Test fixtures are false positives by definition").

| # | File | Line | Reason |
|---|------|------|--------|
| 1 | `tests/samples/test-schema-edge-cases/sql-injection-patterns.ts` | 333 | Test fixture N+1 patterns |
| 2 | `src/__tests__/fixtures/spec-19/item-18-large-service-class.ts` | 220 | Test fixture N+1 patterns |
| 3 | `src/__tests__/fixtures/spec-19/item-01-real-loop-insert.ts` | 21 | Test fixture N+1 patterns |
| 8 | `src/__tests__/fixtures/spec-19/item-18-large-service-class.ts` | 196 | Test fixture N+1 patterns |
| 10 | `src/__tests__/fixtures/spec-19/item-15-complex-query-builder.ts` | 112 | Test fixture N+1 patterns |
| 12 | `src/__tests__/fixtures/spec-19/item-03-real-n-plus-one.ts` | 18 | Test fixture N+1 patterns |
| 13 | `tests/samples/test-schema-edge-cases/sql-injection-patterns.ts` | 329 | Test fixture N+1 patterns |
| 21 | `tests/samples/test-schema-edge-cases/sql-injection-patterns.ts` | 334 | Test fixture N+1 patterns |
| 22 | `tests/samples/test-schema-edge-cases/comprehensive-validation.ts` | 334 | Test fixture N+1 patterns |
| 27 | `bench/corpus/data-access/src/n-plus-one.ts` | 14 | Test fixture N+1 patterns |
| 30 | `src/__tests__/fixtures/spec-19/item-15-complex-query-builder.ts` | 60 | Test fixture N+1 patterns |
| 35 | `src/__tests__/fixtures/spec-19/item-08-real-nested-n-plus-one.ts` | 56 | Test fixture N+1 patterns |
| 38 | `src/__tests__/fixtures/spec-19/item-08-real-nested-n-plus-one.ts` | 31 | Test fixture N+1 patterns |
| 45 | `src/analyzers/__tests__/fixtures/spec-17/nested-loops-query.ts` | 20 | Test fixture N+1 patterns |
| 46 | `src/__tests__/fixtures/spec-19/item-01-real-loop-insert.ts` | 20 | Test fixture N+1 patterns |
| 39 | `src/__tests__/fixtures/spec-19/item-03-real-n-plus-one.ts` | 19 | Test fixture N+1 patterns |
| 49 | `src/__tests__/fixtures/spec-19/item-08-real-nested-n-plus-one.ts` | 32 | Test fixture N+1 patterns |

#### False positives — Dogfooding artifacts (25 findings)

These fire on production source files because the code-auditor's own code contains SQL-pattern-matching logic. The analyzer sees string constants like `'SELECT'`, `'FROM'`, `'WHERE'` in TypeScript loops and flags them as database query loops — but they're the tool's detection patterns, not actual DB calls. These are genuine precision defects: the detector cannot distinguish "TypeScript loop that executes SQL" from "TypeScript loop that pattern-matches SQL strings."

| # | File | Line | Reason |
|---|------|------|--------|
| 4 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts` | 1155 | Misinterprets TypeScript loops as DB query loops |
| 5 | `src/analyzers/universal/UniversalDataAccessAnalyzer.ts` | 740 | Misinterprets TypeScript loops as DB query loops |
| 6 | `src/analyzers/provenance.ts` | 868 | Misinterprets TypeScript loops as DB query loops |
| 7 | `src/analyzers/analyzerUtils.ts` | 70 | Misinterprets TypeScript loops as DB query loops |
| 9 | `src/services/CodeMapGenerator.ts` | 225 | Misinterprets TypeScript loops as DB query loops |
| 14 | `src/services/CodeMapGenerator.ts` | 622 | Misinterprets TypeScript loops as DB query loops |
| 15 | `src/analyzers/provenance.ts` | 409 | Misinterprets TypeScript loops as DB query loops |
| 16 | `src/analyzers/reactAnalyzer.ts` | 469 | Misinterprets TypeScript loops as DB query loops |
| 17 | `src/languages/RuntimeManager.ts` | 568 | Misinterprets TypeScript loops as DB query loops |
| 18 | `src/services/CodeMapGenerator.ts` | 257 | Misinterprets TypeScript loops as DB query loops |
| 19 | `src/analyzers/provenance.ts` | 237 | Misinterprets TypeScript loops as DB query loops |
| 23 | `src/cli.ts` | 776 | Misinterprets TypeScript loops as DB query loops |
| 24 | `src/tool-registry.ts` | 127 | Misinterprets TypeScript loops as DB query loops |
| 29 | `src/generators/CodexConfigGenerator.ts` | 55 | Misinterprets TypeScript loops as DB query loops |
| 32 | `src/services/CodeMapGenerator.ts` | 217 | Misinterprets TypeScript loops as DB query loops |
| 33 | `src/analyzers/provenance.ts` | 197 | Misinterprets TypeScript loops as DB query loops |
| 34 | `src/installer.ts` | 137 | Misinterprets TypeScript loops as DB query loops |
| 36 | `src/services/SchemaParser.ts` | 405 | Misinterprets TypeScript loops as DB query loops |
| 40 | `src/analyzers/provenance.ts` | 235 | Misinterprets TypeScript loops as DB query loops |
| 42 | `src/analyzers/provenance.ts` | 199 | Misinterprets TypeScript loops as DB query loops |
| 44 | `src/cli.ts` | 969 | Misinterprets TypeScript loops as DB query loops |
| 47 | `src/scripts/runBench.ts` | 897 | Misinterprets TypeScript loops as DB query loops |
| 48 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts` | 316 | Misinterprets TypeScript loops as DB query loops |

#### True-but-useless — Real N+1 on local SQLite (10 findings)

These ARE real SQL calls inside loops — the detector correctly identified N+1 patterns. The triager classified them as TBU because "N+1 is irrelevant at this scale" for a local SQLite database with <10K rows. This is a corpus-dependent judgment: on a PostgreSQL-backed web application, these same patterns would be real performance bugs.

| # | File | Line | Reason |
|---|------|------|--------|
| 11 | `src/codeIndexDB.ts` | 1607 | Real SQL in loop — cleanup on local SQLite |
| 20 | `src/codeIndexDB.ts` | 1537 | Real SQL in loop — cleanup on local SQLite |
| 25 | `src/codeIndexDB.ts` | 1311 | Real SQL in loop — cleanup on local SQLite |
| 26 | `src/codeIndexDB.ts` | 1653 | Real SQL in loop — cleanup on local SQLite |
| 28 | `src/codeIndexDB.ts` | 1046 | Real SQL in loop — cleanup on local SQLite |
| 31 | `src/codeIndexDB-enhanced.ts` | 418 | Real SQL in loop — cleanup on local SQLite |
| 37 | `src/codeIndexDB.ts` | 1055 | Real SQL in loop — cleanup on local SQLite |
| 41 | `src/codeIndexDB-enhanced.ts` | 423 | Real SQL in loop — cleanup on local SQLite |
| 43 | `src/codeIndexDB-enhanced.ts` | 62 | Real SQL in loop — cleanup on local SQLite |
| 50 | `src/codeIndexDB-enhanced.ts` | 417 | Real SQL in loop — cleanup on local SQLite |

### loop-query — External Corpus (from 27-sample triage)

The 27-sample triage on a post-Spec-17 recall corpus (Gin-like external TypeScript project) found loop-query at **3 true / 3 false = 50% judged-true**:

| Item | File | Summary | Verdict |
|------|------|---------|---------|
| 1 | `src/services/report-generator.ts:42` | `INSERT` in loop calling 3rd-party API then writing results | **TRUE** |
| 2 | `src/services/ai-enrich.ts:89` | Loop body calls LLM; INSERT batch outside loop | **FALSE** |
| 3 | `src/db/sync.ts:134` | `INSERT … RETURNING` per iteration | **TRUE** |
| 5 | `src/utils/search-index.ts:203` | `.findIndex()` substring match — array, not DB | **FALSE** |
| 6 | `src/transform/reshaper.ts:67` | Loop over in-memory array; DB call outside loop body | **FALSE** |
| 8 | `src/tasks/scheduler.ts:78` | `SELECT` inside `while` with per-row child queries | **TRUE** |

### single-responsibility — Self-Audit (50 findings)

**Verdicts:** 49 true / 1 false / 0 TBU
**Precision:** 0.98, **Judged-true:** 0.98

The single false positive (#22) is `bench/corpus/react/src/bad-hook.tsx:15` — a test fixture. All 49 production findings are genuine long functions (200+ lines or 7+ parameters) in files like `mcp-tools-shared.ts`, `auditRunner.ts`, `UniversalDataAccessAnalyzer.ts`, `cli.ts`, `TreeSitterTypeScriptAdapter.ts`, etc.

These are real maintainability concerns — functions that exceed length and parameter thresholds. The question is whether "critical" severity (blocking hooks) is appropriate for a length/parameter heuristic, not whether the findings are real.

## Pipeline Defect: "TBU Cliff + Single-Corpus Overfit"

### The mechanical recalibration math is correct

Given the triage data, Spec 11 R5 rules produce:
- `loop-query`: judged-true = 0/(0+40) = 0.00 < 0.50 → **disable** ✓ (mechanically correct)
- `single-responsibility`: judged-true = 49/(49+1) = 0.98 ≥ 0.90, precision = 0.98 ≥ 0.95 → **promote** ✓ (mechanically correct)

The math is not wrong. The pipeline defect is upstream of the math.

### Defect 1: TBU exclusion creates a cliff that masks detector utility

The Spec 11 judged-true formula is `true / (true + false)`. TBU findings are excluded from both numerator and denominator. This means:

- If a detector finds 10 real issues and 0 false positives, but all 10 are classified as TBU → judged-true = 0/0 = undefined → treated as 0.00 → **disabled**
- If those same 10 findings were classified as true instead → judged-true = 10/10 = 1.00 → promoted

The 10 loop-query TBU findings ARE real N+1 patterns. The triager's classification as TBU rests on "N+1 is irrelevant at this scale" — a judgment that is true for local SQLite but false for PostgreSQL/MySQL. On an external web-application corpus, those same patterns would be classified as true, and judged-true would be non-zero.

The TBU cliff means a single judgment call ("is this worth fixing here?") cascades into "should this rule exist at all?" — and the answer changes depending on which corpus the triager is looking at.

### Defect 2: Single-corpus recalibration applied as global defaults

The recalibration was run on the code-auditor self-audit — a corpus where:
- The codebase contains SQL pattern-matching logic (the tool detects SQL patterns, so its source IS SQL patterns)
- The database is local SQLite (<10K rows) where N+1 doesn't matter
- There is no org/tenant model (it's a CLI tool, not a SaaS app)
- External SQL files are processed without a schema

Six data-access rules were disabled based on THIS corpus alone, when external evidence existed showing loop-query at 50% judged-true on a Gin-like external project.

The triage report's own "Blind Spots" section (line 132) admits: "The data-access analyzer's precision is domain-dependent — it may perform much better on a SaaS web application." Despite this, the rules were disabled unconditionally in `defaults.ts`.

### Defect 3: Test fixtures count against the detector

The rubric classifies test fixtures and bench corpus files as "false positives by definition." This means:
- The `loop-query` bench fixture (`bench/corpus/data-access/src/n-plus-one.ts`) — designed to prove the detector works — counts as a false positive in triage
- The spec-19 oracle items (e.g., `item-01-real-loop-insert.ts`, `item-03-real-n-plus-one.ts`) — designed to be ground truth for the detector — count as false positives

A rule with comprehensive bench coverage gets penalized in recalibration because every fixture finding is "false." This creates a perverse incentive: better test coverage → lower judged-true → higher chance of being disabled.

## Reconcile Contradictions

### "Zero-across-six" vs external evidence

| Rule | Self-audit judged-true | External evidence | Contradiction |
|------|----------------------|-------------------|---------------|
| `loop-query` | 0.00 | 50% (3T/3F, 27-sample triage) | Self-audit undercounts due to dogfooding false positives + TBU cliff. External corpus shows real detector utility. |
| `sql-injection-risk` | 0.00 | 50% (2T/2F, 27-sample triage) | Same: dogfooding on pattern-matching code inflates false positives. |
| `missing-org-filter` | 0.00 | N/A (domain-specific) | Domain mismatch confirmed — genuinely useless on non-SaaS. Disable is correct for CLI/non-tenant apps but wrong as unconditional default. |
| `unknown-table` | 0.00 | N/A | Requires user-provided schema. Disable is correct for repos without schema but should be config-reactivatable. |
| `unfiltered-query` | 0.00 | No external data | Internal tool patterns. External validation needed before disabling. |
| `direct-sql` | 0.00 | No external data | All findings in test fixtures. May have value on external corpora with real raw-SQL usage. |

### "single-responsibility at critical" vs the entry rule

The promotion from warning → critical is mechanically correct (0.98 ≥ 0.95 precision AND 0.98 ≥ 0.90 judged-true). But:

1. **Critical means blocking hooks**: Every `code-audit changed --fail-on critical` invocation now fails if any function is too long or has too many parameters. This is a hard gate on every edit.
2. **The rule is a heuristic**: "Too many lines" and "too many parameters" are proxies for maintainability, not correctness or security defects. Blocking hooks on a proxy is disproportionate.
3. **Spec 11 R5 says "promote one tier"**: Warning → critical is one tier. The promotion follows the letter of the law. The issue is whether the law's one-tier promotion should be capped at warning for heuristic rules.

### "Test fixtures as false" vs bench coverage

The rubric's "test fixtures are false positives by definition" rule is correct for corpus triage (we don't want bench fixtures inflating precision). But it creates a structural problem: a rule that has 15 bench-fixture findings (proving it works across edge cases) and 10 real production findings (proving utility) gets judged-true = 10/25 = 0.40 → disabled. A rule with 0 bench coverage and 10 real findings gets judged-true = 10/10 = 1.00 → promoted.

The solution is not to reclassify fixtures as true, but to exclude them from the judged-true denominator entirely (alongside TBU). The judged-true formula should be: `true / (true + production_false)` — test fixtures are neither true nor false, they're calibration artifacts.

## Corrected Recalibration

### Rules that should remain at original severity (revert the disable)

| Rule | Original | Reason |
|------|----------|--------|
| `loop-query` | warning | 50% judged-true on external corpus. Dogfooding artifact on self-audit. TBU findings are real N+1. |
| `sql-injection-risk` | suggestion | 50% judged-true on external corpus. Dogfooding artifact on self-audit. |
| `unfiltered-query` | suggestion | Insufficient external evidence. Keep at suggestion pending validation. |
| `direct-sql` | suggestion | All self-audit findings in fixtures. May have external corpus value. |

### Rules that should be disabled (domain-impossible, not corpus-dependent)

| Rule | Original | Proposed | Reason |
|------|----------|----------|--------|
| `missing-org-filter` | warning | **suggestion** (not off) | Domain-mismatch confirmed. But "off" hides it from users who DO have multi-tenant apps. Demote to suggestion so it's visible but non-blocking. |
| `unknown-table` | warning | **suggestion** (not off) | Requires user-provided schema. Demote to suggestion; document config option. |

### Rules that should be promoted

| Rule | Original | Proposed | Reason |
|------|----------|----------|--------|
| `single-responsibility` | warning | **warning** (no change) | Meets promotion bars but critical is disproportionate for a length heuristic. Two-tier promotion (warning→critical) deferred pending: (a) external corpus validation, (b) user feedback on whether SRP should block hooks. |
| `solid/class-size` | suggestion | **warning** | 1.00/1.00 on 27 findings. One-tier promotion follows Spec 11 R5. |
| `dependency-inversion` | suggestion | **warning** | 1.00/1.00 on 16 findings. One-tier promotion follows Spec 11 R5. |

### Summary table

| Rule | Current (recalibrated) | Proposed | Δ |
|------|----------------------|----------|---|
| `missing-org-filter` | off | suggestion | ↑ |
| `unknown-table` | off | suggestion | ↑ |
| `sql-injection-risk` | off | suggestion (original) | ↑ |
| `loop-query` | off | warning (original) | ↑ |
| `unfiltered-query` | off | suggestion (original) | ↑ |
| `direct-sql` | off | suggestion (original) | ↑ |
| `single-responsibility` | critical | warning (original) | ↓ |
| `solid/class-size` | warning | warning | = |
| `dependency-inversion` | warning | warning | = |

Net effect: 6 rules restored from disabled, 1 rule (SRP) returned to its original tier, 2 promotions retained, 2 rules demoted to suggestion instead of disabled.

## Recommendations

1. **Apply the corrected recalibration** to `src/config/defaults.ts` (already reverted — re-apply with corrected values)
2. **Amend Spec 11 R5** to exclude test-fixture findings from the judged-true denominator (treat them like TBU)
3. **Require multi-corpus validation** before disabling any rule — a rule disabled on one corpus stays at suggestion, not off
4. **Cap heuristic-rule promotion at warning** — length/parameter/count heuristics should not block hooks regardless of precision
5. **Re-run recalibration** when ≥10 external-corpus findings exist for each data-access rule (Gin + Excalidraw triage)
6. **Update `recalibration.md`** to document the corrected table and the TBU-cliff limitation
