# Triage Resolutions — Spec-19

**Source:** `bench/diagnostics/2026-07-recall-warning-triage.md` (verbatim original)
**Date:** 2026-07-21
**Purpose:** Maps each triaged finding to its Spec-19 resolution. Separate from the
diagnostic artifact so the triage remains byte-identical to its original form.

---

## Resolution Table

| # | Verdict | Resolution | Spec-19 Section |
|---|---------|------------|-----------------|
| 1 | TRUE | — (no change needed) | — |
| 2 | FALSE | Body-scoped DB-call verification — walk loop body AST to confirm DB call is inside | R2 |
| 3 | TRUE | — (no change needed) | — |
| 4 | TRUE | — (no change needed) | — |
| 5 | FALSE | Hardened `isDbCallNode` — `findIndex` no longer matches | R2 |
| 6 | FALSE | Body-scoped verification — DB call outside loop body → no violation | R2 |
| 7 | TRUE | — (no change needed) | — |
| 8 | TRUE | — (no change needed) | — |
| 9 | FALSE | Receiver gating — `page.evaluate`, `console.log` excluded from DB receiver set | R3 |
| 10 | FALSE | Parameterized-query demotion to suggestion (placeholders present → lower severity) | R3 |
| 11 | FALSE | True McCC replaces line-count — complexity-1 functions no longer fire | R1 |
| 12 | FALSE | True McCC — branchless JSX components no longer fire | R1 |
| 13 | TRUE | — (no change needed) | — |
| 14 | TRUE | — (no change needed) | — |
| 15 | TRUE | — (no change needed) | — |
| 16 | TRUE | — (no change needed) | — |
| 17 | FALSE | True McCC — pure data assembly no longer fires | R1 |
| 18 | TRUE | — (no change needed) | — |
| 19 | USELESS | Threshold + exclude patterns — 15-line floor, `.config.*` excludable | R4 |
| 20 | USELESS | Threshold + exclude patterns — 15-line floor, `**/i18n/**` excludable | R4 |
| 21 | USELESS | `duplicate-import` sub-rule retired | R4 |
| 22 | USELESS | `duplicate-import` sub-rule retired | R4 |
| 23 | USELESS | `duplicate-import` sub-rule retired | R4 |
| 24 | USELESS | `duplicate-string-literal` sub-rule retired | R4 |
| 25 | USELESS | `duplicate-string-literal` sub-rule retired | R4 |
| 26 | USELESS | `dry/structural-similarity` default-off, config toggle preserved per R4.2 | R4 |
| 27 | USELESS | `dry/structural-similarity` default-off, config toggle preserved per R4.2 | R4 |

## Implementation Notes

- **R1** (Method complexity): True cyclomatic complexity calculation replaces line-count metric.
- **R2** (Data access scoping): Loop body verification confirms DB call is inside the loop;
  hardened `isDbCallNode` substring matching.
- **R3** (SQL injection receiver gating): Non-DB sinks excluded; parameterized queries
  with placeholders produce no finding; all remaining sql-injection-risk → suggestion.
- **R4** (DRY sub-rule retirement): `duplicate-import` and `duplicate-string-literal`
  retired; `dry/structural-similarity` default-off with config toggle preserved.
