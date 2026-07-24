# Spec 11 R5 — Mechanical Recalibration

**Date:** 2026-07-20
**Corpus:** code-auditor self-audit (2,278 findings, 691 triaged)
**Method:** Per Spec 11 binding modifiers §R5:
- precision ≥ 0.95 AND judged-true ≥ 0.90 → promote one severity tier
- judged-true < 0.50 → disable by default
- Rules with < 10 judged findings (T+F) exempt from mechanical recalibration (insufficient sample)

## Methodological Amendments (Ratified 2026-07-20)

The audit identified three defects in the recalibration *method*, not in any single pipeline implementation. These amendments are binding on every future recalibration run — including Spec 15 step 21 — and are the most important methodology finding of the series.

### Amendment 1: Three-way verdicts are load-bearing

**Disable is about falsity; tier is about usefulness.**

TBU (true-but-useless) findings are precision-true: the detector correctly identified the pattern. They contribute to keeping a rule alive — what they argue for is lower tier or path-profile capping, never deletion. A rule disables only when **false-positive share** exceeds 0.50 (i.e., `false / (true + TBU + false) > 0.50`, not `false / (true + false) > 0.50`).

The judged-true formula becomes: `(true + TBU) / (true + TBU + false)`. TBU findings are excluded from the numerator only for promotion calculations, not for disable calculations.

The loop-query N+1s were real patterns that didn't matter *on local SQLite*. Context-relevance is what Spec 20 profiles encode, not what existence decisions consume.

### Amendment 2: Single-corpus guard

**No disable and no promotion into blocking from a single corpus.** Minimum two corpora. Self-audit can never be the sole basis for rules whose subject matter the tool's own source contains (meta-contamination rule — a SQL-pattern-matching tool auditing its own SQL-pattern-matching source is the one codebase on earth guaranteed to confuse those detectors).

The retained promotions (`solid/class-size`, `dependency-inversion`) stand because they're warning-tier and unaffected by the contamination mechanism. Nothing reaches **critical** under single-corpus evidence, ever.

### Amendment 3: Fixture exclusion

**Fixture and test paths are excluded from triage sampling.** The rubric's "test fixtures are false positives by definition" rule is correct for corpus triage but creates a structural perversion: better bench coverage → lower judged-true → higher chance of being disabled. Test fixtures are calibration artifacts, not production findings — exclude them from the judged-true denominator alongside TBU.

## Recalibration Table

> **⚠️ AUDITED 2026-07-20 — original recalibration superseded.**
> Full audit report: [`spec-11-recalibration-audit.md`](./spec-11-recalibration-audit.md)
>
> The original recalibration disabled 6 data-access/schema rules and promoted single-responsibility to critical based on a single corpus (code-auditor self-audit). The audit identified a pipeline defect — **"TBU Cliff + Single-Corpus Overfit"** — with three sub-defects:
>
> 1. **TBU exclusion cliff**: True-but-useless findings are excluded from the judged-true denominator. 10 real loop-query N+1 findings classified as TBU (because "N+1 doesn't matter on local SQLite") contributed zero to keeping the rule alive. On an external web-application corpus, those same patterns would be classified as true.
> 2. **Single-corpus overfit**: Self-audit is an adversarial corpus for data-access rules — the tool's source contains SQL pattern-matching logic that the detector misreads as database calls. External 27-sample triage showed loop-query at 50% judged-true (vs 0% on self-audit).
> 3. **Test-fixtures penalize coverage**: The rubric classifies bench-fixture findings as false positives. A rule with comprehensive bench coverage gets penalized — every fixture finding counts against judged-true.
>
> The corrected table below reflects multi-corpus cross-referencing, external evidence from the 27-sample Gin-like triage, and Spec 11 R5's one-tier promotion cap for heuristic rules.

### Rules Demoted (domain-impossible on CLI, but re-enablable for applicable projects)

| Rule | n | Precision | Judged-true | Current | Corrected | Rationale |
|------|---|-----------|-------------|---------|-----------|-----------|
| `missing-org-filter` | 50 | 0.00 | 0.00 | warning | **suggestion** (judgment pending) | Domain-mismatch confirmed on single corpus. Demotion to suggestion (not off) is the conservative choice — visible but non-blocking for users with multi-tenant apps. **Judgment pending two-corpus data** per Amendment 2; may return to warning with external evidence. |
| `unknown-table` | 50 | 0.00 | 0.00 | warning | **suggestion** (judgment pending) | Requires user-provided schema. Demotion to suggestion (not off) is the conservative choice. **Judgment pending two-corpus data** per Amendment 2; may return to warning with external evidence. |

### Rules Restored to Original Severity (pipeline defect — self-audit ≠ global)

| Rule | n | Precision | Judged-true | Current | Corrected | Rationale |
|------|---|-----------|-------------|---------|-----------|-----------|
| `sql-injection-risk` | 50 | 0.00 | 0.00 | suggestion | **suggestion** (unchanged) | Dogfooding artifact on self-audit. 50% judged-true (2T/2F) on external 27-sample corpus. Restored to original suggestion. |
| `loop-query` | 40 | 0.00 | 0.00 | warning | **warning** (unchanged) | Dogfooding artifact on self-audit. 50% judged-true (3T/3F) on external corpus with two confirmed production N+1s. 10 TBU findings are real N+1 — useful on non-SQLite databases. |
| `unfiltered-query` | 33 | 0.00 | 0.00 | suggestion | **suggestion** (unchanged) | Insufficient external evidence. Keep at suggestion pending validation. |
| `direct-sql` | 18 | 0.00 | 0.00 | suggestion | **suggestion** (unchanged) | All self-audit findings in fixtures. May have value on external corpora with real raw-SQL usage. |

### Rules Promoted (precision ≥ 0.95 AND judged-true ≥ 0.90 — one tier only)

| Rule | n | Precision | Judged-true | Current | Corrected | Rationale |
|------|---|-----------|-------------|---------|-----------|-----------|
| `solid/class-size` | 27 | 1.00 | 1.00 | suggestion | **warning** | All 27 findings true. One-tier promotion follows Spec 11 R5. Classes with too many methods are real design problems. |
| `dependency-inversion` | 16 | 1.00 | 1.00 | suggestion | **warning** | All 16 findings true. One-tier promotion follows Spec 11 R5. Concrete dependency imports are real design concerns. |

### Rules Promotions Withheld

| Rule | n | Precision | Judged-true | Current | Corrected | Rationale |
|------|---|-----------|-------------|---------|-----------|-----------|
| `single-responsibility` | 50 | 0.98 | 0.98 | warning | **warning** (no change) | Meets promotion bars (0.98 ≥ 0.95 precision, 0.98 ≥ 0.90 judged-true) but critical is disproportionate for a length/parameter heuristic. Two-tier promotion deferred pending: (a) external corpus validation, (b) user feedback on whether SRP should block hooks. |

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
| `dry/diverging-clone` | — | — | — | **suggestion** (entry tier) | Cannot clear warning bars: divergence detection requires ≥2 consecutive full-run similarity snapshots; a static bench corpus produces only one. Real-corpus divergence data is structurally unavailable until ledger history accumulates. **Re-evaluate when ≥10 divergence findings exist across organic full runs.** |

## Implementation (Audited 2026-07-20)

The corrected recalibration is implemented via `severityOverrides` in `src/config/defaults.ts`:

```typescript
// Spec-11 R5: Mechanical recalibration — audited 2026-07-20.
// Audit report: bench/results/spec-11-recalibration-audit.md
//
// Demoted (suggestion): domain-mismatch confirmed but users with
//   applicable domains (multi-tenant SaaS, known-schema projects)
//   need these visible and re-enablable.
// Promoted (warning): precision ≥ 0.95, judged-true ≥ 0.90,
//   one tier only per Spec 11 R5. single-responsibility promotion
//   to critical is withheld — length heuristics should not block hooks.
// Restored to defaults: sql-injection-risk, loop-query, unfiltered-query,
//   direct-sql, single-responsibility. These have external-corpus evidence
//   of utility or insufficient evidence to recalibrate.
severityOverrides: {
  'missing-org-filter': 'suggestion',
  'unknown-table': 'suggestion',
  'solid/class-size': 'warning',
  'dependency-inversion': 'warning',
}
```

## Summary of Changes (pre-audit → post-audit)

| Rule | Pre-audit | Post-audit | Δ |
|------|----------|------------|---|
| `missing-org-filter` | off | suggestion | ↑ |
| `unknown-table` | off | suggestion | ↑ |
| `sql-injection-risk` | off | suggestion (restored) | ↑ |
| `loop-query` | off | warning (restored) | ↑ |
| `unfiltered-query` | off | suggestion (restored) | ↑ |
| `direct-sql` | off | suggestion (restored) | ↑ |
| `single-responsibility` | critical | warning (restored) | ↓ |
| `solid/class-size` | warning | warning (promoted) | = |
| `dependency-inversion` | warning | warning (promoted) | = |

## Limitations

- **Three amendments ratified** (see top of this document): future recalibration runs — including Spec 15 step 21 — must apply the amended method, not the original Spec 11 R5 formula. TBU findings keep rules alive; single-corpus guard prevents disables and promotion-to-blocking; fixtures are excluded from sampling.
- **Single corpus:** The original recalibration was based on one corpus (a TypeScript CLI tool). Rules that appeared weak (especially `loop-query`, `sql-injection-risk`) showed real utility on external corpora — the 27-sample Gin-like triage measured loop-query at 50% judged-true. Multi-corpus validation is required before disabling any rule globally.
- **TBU cliff:** The original judged-true formula `true / (true + false)` excluded TBU findings from both numerator and denominator. Real findings classified as TBU contributed nothing to keeping a rule alive. The 10 real loop-query N+1 findings (TBU on local SQLite, true on PostgreSQL/MySQL) counted as zero. **Fixed by Amendment 1.**
- **Sampling error:** For rules with < 50 total findings, the sample is exhaustive but small. The 10-finding minimum guard prevents overfitting to tiny samples.
- **"Disabled" means off-by-default:** Users can re-enable any rule via `severityOverrides` in their `.codeauditor.json`.
- **No two-tier promotion:** Rules are promoted at most one severity tier (e.g., suggestion→warning, not suggestion→critical). Multi-tier jumps require multi-corpus validation. **Strengthened by Amendment 2: nothing reaches critical under single-corpus evidence.**
- **Heuristic cap:** Length/parameter/count heuristics (e.g., `single-responsibility`) should not block hooks regardless of precision — promotions are capped at warning.
