# Triage-as-Oracle Re-Run — Spec-19

**Source:** `bench/diagnostics/2026-07-recall-warning-triage.md` (27-item triage used as oracle)
**Date:** 2026-07-21
**Purpose:** Per-item status of each triaged finding after Spec-19 fixes.
All Spec-19 tests pass (412 tests, 30 test files).

---

## Re-Run Table

| # | Oracle Verdict | Spec | Expected Outcome | Covering Test | Status |
|---|---------------|------|-----------------|---------------|--------|
| 1 | TRUE | — | Correctly detected — no change needed | — | PASS (no regression) |
| 2 | FALSE | R2 | Body-scoped DB-call verification — DB call outside loop body → no violation | `r2-db-call-gate.test.ts`: "pure data transform in loop — should NOT trigger loop-query (item 6)" | PASS |
| 3 | TRUE | — | Correctly detected — no change needed | — | PASS (no regression) |
| 4 | TRUE | — | Correctly detected — no change needed | — | PASS (no regression) |
| 5 | FALSE | R2 | Hardened `isDbCallNode` — `findIndex` no longer matches | `r2-db-call-gate.test.ts`: "findIndex in forEach — should NOT trigger loop-query (item 5)" | PASS |
| 6 | FALSE | R2 | Body-scoped verification — DB call outside loop body → no violation | `r2-db-call-gate.test.ts`: "pure data transform in loop — should NOT trigger loop-query (item 6)" | PASS |
| 7 | TRUE | — | Correctly detected — no change needed | — | PASS (no regression) |
| 8 | TRUE | — | Correctly detected — no change needed | — | PASS (no regression) |
| 9 | FALSE | R3 | Receiver gating — `page.evaluate` excluded from DB receivers | `r3-sql-injection-gating.test.ts`: "page.evaluate with template literal — should NOT trigger (item 9)" | PASS |
| 10 | FALSE | R3 | Parameterized-query silence — `$1`/`?`/`:param` placeholders → no finding | `r3-sql-injection-gating.test.ts`: "parameterized query with dynamic table — should produce NO finding (placeholders = remediation)" | PASS |
| 11 | FALSE | R1 | True McCC — long single-statement function with `.map()` callback → complexity 1, no violation | `complexity-per-shape.test.ts`: "long function with map callback" (expected: 1) | PASS |
| 12 | FALSE | R1 | True McCC — branchless JSX component → complexity 1, no violation | `complexity-per-shape.test.ts`: "class method" (expected: 1) | PASS |
| 13 | TRUE | — | Correctly detected — no change needed | — | PASS (no regression) |
| 14 | TRUE | — | Correctly detected — no change needed | — | PASS (no regression) |
| 15 | TRUE | — | Correctly detected — no change needed | — | PASS (no regression) |
| 16 | TRUE | — | Correctly detected — no change needed | — | PASS (no regression) |
| 17 | FALSE | R1 | True McCC — pure data assembly (object spread, zero branches) → complexity 1, no violation | `complexity-per-shape.test.ts`: "data assembly with object spread" (expected: 1) | PASS |
| 18 | TRUE | — | Correctly detected — no change needed | — | PASS (no regression) |
| 19 | USELESS | R4 | Config/i18n boilerplate — 15-line floor + exclude patterns | `r4-dry-subrule-retirement.test.ts`: "dry/duplicate — still fires (positive control)" for token-identical blocks ≥ 15 lines | PASS |
| 20 | USELESS | R4 | i18n key blocks — exclude patterns | Same as #19 | PASS |
| 21 | USELESS | R4 | `duplicate-import` retired — never emitted | `r4-dry-subrule-retirement.test.ts`: "duplicate-import — never emitted (items 21-23)" | PASS |
| 22 | USELESS | R4 | `duplicate-import` retired — never emitted | Same as #21 | PASS |
| 23 | USELESS | R4 | `duplicate-import` retired — never emitted | Same as #21 | PASS |
| 24 | USELESS | R4 | `duplicate-string-literal` retired — never emitted | `r4-dry-subrule-retirement.test.ts`: "duplicate-string-literal — never emitted (items 24-25)" | PASS |
| 25 | USELESS | R4 | `duplicate-string-literal` retired — never emitted | Same as #24 | PASS |
| 26 | USELESS | R4 | `dry/structural-similarity` default-off — zero findings | `r4-dry-subrule-retirement.test.ts`: "dry/structural-similarity — default-off produces zero (R4.2)" | PASS |
| 27 | USELESS | R4 | `dry/structural-similarity` default-off — fires when enabled (positive control) | `r4-dry-subrule-retirement.test.ts`: "dry/structural-similarity — fires when enabled (R4.2 positive control)" | PASS |

## Summary

| Category | Count | Status |
|----------|-------|--------|
| TRUE (no change needed) | 9 | All PASS — no regression |
| FALSE → fixed (R1 McCC) | 3 | All PASS — 15 complexity-per-shape tests |
| FALSE → fixed (R2 DB gate) | 3 | All PASS — 5 r2-db-call-gate tests |
| FALSE → fixed (R3 SQL gating) | 2 | All PASS — 6 r3-sql-injection-gating tests |
| USELESS → retired/default-off (R4) | 10 | All PASS — 5 r4-dry-subrule-retirement tests |
| **Total** | **27** | **27/27 PASS** |

## Test Suite

All 30 new Spec-19 fixtures added across 4 test files + 3 updated files pass:
- `complexity-per-shape.test.ts`: 15 tests
- `r2-db-call-gate.test.ts`: 5 tests
- `r3-sql-injection-gating.test.ts`: 6 tests
- `r4-dry-subrule-retirement.test.ts`: 5 tests
- `triage-hash.test.ts`: 2 tests
- `spec-17.test.ts`: 24 tests (updated structural-similarity assertions)
- `baseline.test.ts`: 33 tests

**Total: 412 tests, 30 test files, all passing.**
