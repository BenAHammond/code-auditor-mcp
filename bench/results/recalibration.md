# Spec 11 R5 — Mechanical Recalibration

**Date:** 2026-07-20
**Corpus:** code-auditor self-audit (2,278 findings, 691 triaged)
**Method:** Per Spec 11 binding modifiers §R5:
- precision ≥ 0.95 AND judged-true ≥ 0.90 → promote one severity tier
- judged-true < 0.50 → disable by default
- Rules with < 10 judged findings (T+F) exempt from mechanical recalibration (insufficient sample)

## Recalibration Table

### Rules Disabled (judged-true < 0.50)

| Rule | n | Precision | Judged-true | Current | Proposed | Rationale |
|------|---|-----------|-------------|---------|----------|-----------|
| `missing-org-filter` | 50 | 0.00 | 0.00 | warning | **disabled** | Domain-specific (org/tenant isolation); code-auditor is a CLI tool, not a SaaS app. Every finding is false. |
| `unknown-table` | 50 | 0.00 | 0.00 | warning | **disabled** | Processes external SQL files where table names are unknown by design. Requires user-provided schema to be useful. |
| `sql-injection-risk` | 50 | 0.00 | 0.00 | suggestion | **disabled** | Dogfooding artifact: analyzer misinterprets TypeScript pattern-matching code as SQL. `better-sqlite3` with `.prepare()` is parameterized. |
| `loop-query` | 40 | 0.00 | 0.00 | warning | **disabled** | False positives dominate: TypeScript loops containing string operations that match SQL patterns. Marginal TBU findings are cleanup passes on local SQLite. |
| `unfiltered-query` | 33 | 0.00 | 0.00 | suggestion | **disabled** | False on production code (internal DB reads of small tables are intentional). TBU on test fixtures. |
| `direct-sql` | 18 | 0.00 | 0.00 | suggestion | **disabled** | All findings in test/bench fixtures. No production false positives because the rule fires at file level (line 1) on files that happen to import a DB library. |

### Rules Promoted (precision ≥ 0.95 AND judged-true ≥ 0.90)

| Rule | n | Precision | Judged-true | Current | Proposed | Rationale |
|------|---|-----------|-------------|---------|----------|-----------|
| `single-responsibility` | 50 | 0.98 | 0.98 | warning | **critical** | Functions exceeding length/parameter thresholds are real maintainability problems. 49/50 findings are actionable. Single false positive is in a test fixture. |
| `solid/class-size` | 27 | 1.00 | 1.00 | suggestion | **warning** | Classes with too many methods are real design problems. All 27 findings are true. Promoted one tier (suggestion→warning); two-tier jump to critical deferred pending external corpus validation. |
| `dependency-inversion` | 16 | 1.00 | 1.00 | suggestion | **warning** | Concrete dependency imports are real design concerns. All 16 findings are true. Promoted one tier. |

### Rules Unchanged

| Rule | n | Precision | Judged-true | Severity | Reason |
|------|---|-----------|-------------|----------|--------|
| `solid/method-complexity` | 16 | 0.94 | 0.94 | warning | Just below 0.95 threshold; single false positive is in test fixture. Real production precision is 1.00. Keep warning pending larger sample. |
| `open-closed` | 0 judged | 0.00 | — | suggestion | All 17 findings are TBU (time-correlated signal, not deterministic). Already suggestion. |
| All documentation rules | 0 judged | 0.00 | — | suggestion | All 250 findings are TBU. JSDoc on every unit is noise in well-typed codebases. Already suggestion. |
| `dry/duplicate` | 6 | 0.33 | 0.33 | warning | Exempt (n<10). 4/6 false in test fixtures; 2/6 real in production. Keep current. |
| `sql-injection` | 6 | 0.00 | 0.00 | warning | Exempt (n<10). All in test fixtures. Keep current pending corpus with real SQL. |
| `complex-query` | 4 | 0.00 | 0.00 | warning | Exempt (n<10). All in test fixtures. |
| `interface-segregation` | 4 | 1.00 | 1.00 | warning | Exempt (n<10). All 4 true but sample too small to promote. |

## Implementation

The recalibration is implemented via `severityOverrides` in `DEFAULT_ANALYZER_CONFIGS`. This allows per-rule severity changes without modifying analyzer source code:

```typescript
severityOverrides: {
  // Disabled (jt < 0.50)
  'missing-org-filter': 'off',
  'unknown-table': 'off',
  'sql-injection-risk': 'off',
  'loop-query': 'off',
  'unfiltered-query': 'off',
  'direct-sql': 'off',

  // Promoted (prec ≥ 0.95, jt ≥ 0.90)
  'single-responsibility': 'critical',
  'solid/class-size': 'warning',
  'dependency-inversion': 'warning',
}
```

## Limitations

- **Single corpus:** This recalibration is based on one corpus (a TypeScript CLI tool). Rules disabled here (especially `missing-org-filter`, `loop-query`) may be valuable on web application corpora. External validation on Gin and Excalidraw is warranted before declaring a rule permanently disabled.
- **Sampling error:** For rules with < 50 total findings, the sample is exhaustive but small. The 10-finding minimum guard prevents overfitting to tiny samples.
- **"Disabled" means off-by-default:** Users can re-enable any rule via `severityOverrides` in their `.codeauditor.json`. Disabling only changes the default.
- **No two-tier promotion:** Rules are promoted at most one severity tier (e.g., suggestion→warning, not suggestion→critical). Multi-tier jumps require multi-corpus validation.
