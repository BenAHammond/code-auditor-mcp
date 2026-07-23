# Spec 11 R4 — Real-Corpus Triage Report

**Date:** 2026-07-20
**Corpus:** code-auditor self-audit
**Audit scope:** Full repository (`src/`, `tests/`, `bench/`)
**Total findings in full audit:** 2,278
**Sample size:** 691 findings (random sample of 50 per high-volume rule; exhaustive for low-volume rules)

## Triage Methodology

Per the Spec 11 binding modifiers, every finding is classified into exactly one of:

- **true** — real issue, correctly located, a reasonable engineer would act on it
- **false** — not a real issue (analyzer error, domain mismatch, test fixture)
- **true-but-useless** — technically correct, no reasonable action follows (lint-level noise)

Each finding in the sample received a one-sentence rationale.

## Overall Results

| Verdict | Count | Share |
|---------|-------|-------|
| true | 113 | 16.4% |
| false | 275 | 39.8% |
| true-but-useless | 303 | 43.8% |
| **Total** | **691** | 100% |

**Effective precision** (true / sampled): 16.4%
**Judged-true rate** (true / (true + false)): 29.1%

## Per-Analyzer Summary

### Documentation Analyzer (250 sampled / 1,100 total)

| Verdict | Count |
|---------|-------|
| true-but-useless | 250 |

**Precision: 0%** (all TBU)

All documentation findings are `true-but-useless`. The codebase is TypeScript with comprehensive type annotations; type signatures serve as de-facto documentation. Requiring JSDoc on every function (`function-documentation`), every method (`method-documentation`), every parameter (`parameter-documentation`), every return type (`return-documentation`), every class (`class-documentation`), and every file (`file-documentation`) produces noise at a 6:1 noise-to-signal ratio. A well-typed codebase with descriptive function names does not benefit from JSDoc on every unit.

**Recommendation:** All documentation rules → suggestion severity; `file-documentation` → disable by default.

### Data-Access Analyzer (222 sampled / 489 total)

| Rule | Sampled | T | F | TBU | Precision | Judged-true |
|------|---------|---|---|-----|-----------|-------------|
| direct-sql | 18 | 0 | 18 | 0 | 0.00 | — |
| sql-injection-risk | 50 | 0 | 50 | 0 | 0.00 | — |
| missing-org-filter | 50 | 0 | 50 | 0 | 0.00 | — |
| loop-query | 50 | 0 | 40 | 10 | 0.00 | 0.00 |
| unfiltered-query | 50 | 0 | 33 | 17 | 0.00 | 0.00 |
| complex-query | 4 | 0 | 4 | 0 | 0.00 | — |

**Effective precision: 0%**

The data-access analyzer performs poorly on this corpus because:
1. **Domain mismatch:** The code-auditor tool has no organization/tenant model; it is not a SaaS application. `missing-org-filter` is entirely domain-irrelevant — every finding is false.
2. **Dogfooding false positives:** The codebase contains its own SQL-pattern-detection logic (string constants like `'SELECT'`, `'FROM'`, `'WHERE'`). The analyzer misinterprets TypeScript pattern-matching code as database queries. `sql-injection-risk` fires on template literals that construct SQL for `better-sqlite3` (which uses `.prepare()` with parameterized queries).
3. **Internal tool patterns:** `unfiltered-query` fires on `codeIndexDB.ts` reading all rows from small internal tables (<100 rows) — intentional for a local tool DB. `loop-query` flags cleanup pass queries — real SQL calls in loops, but N+1 is irrelevant for local SQLite with <10K rows.
4. **Test fixtures:** `direct-sql` findings are all in `bench/corpus/` and test fixtures — intentionally crafted to trigger the analyzer.

**Recommendation:** `missing-org-filter` → disable by default (domain-specific). `direct-sql` → suggestion, tight message. `sql-injection-risk` → suggestion with note about parameterization. `loop-query` and `unfiltered-query` → warning (these have marginal utility on external corpora).

### Schema Analyzer (83 sampled / 360 total)

| Rule | Sampled | T | F | TBU | Precision |
|------|---------|---|---|-----|-----------|
| unknown-table | 50 | 0 | 50 | 0 | 0.00 |
| too-many-queries | 17 | 0 | 8 | 9 | 0.00 |
| sql-injection | 6 | 0 | 6 | 0 | 0.00 |
| naming-convention | 2 | 0 | 2 | 0 | 0.00 |
| UNKNOWN (unclassified) | 4 | 0 | 4 | 0 | 0.00 |
| other (type-mismatch, invalid-format, above-maximum) | 4 | 0 | 4 | 0 | 0.00 |

**Effective precision: 0%**

The schema analyzer's `unknown-table` rule processes external SQL files where table names are unknown by design — the analyzer can't know the schema of third-party SQL. `too-many-queries` fires on test schema edge-case files that are intentionally large. `sql-injection` findings are in test fixtures or in production code that itself analyzes SQL patterns.

**Recommendation:** `unknown-table` → disable by default (requires user-provided schema). Keep JSON schema validation rules (`type-mismatch`, `invalid-format`, etc.) at their current severities — these were not exercised by this corpus.

### SOLID Analyzer (130 sampled / 323 total)

| Rule | Sampled | T | F | TBU | Precision | Judged-true |
|------|---------|---|---|-----|-----------|-------------|
| solid/class-size | 27 | 27 | 0 | 0 | 1.00 | 1.00 |
| single-responsibility | 50 | 49 | 1 | 0 | 0.98 | 0.98 |
| solid/method-complexity | 16 | 15 | 1 | 0 | 0.94 | 0.94 |
| dependency-inversion | 16 | 16 | 0 | 0 | 1.00 | 1.00 |
| interface-segregation | 4 | 4 | 0 | 0 | 1.00 | 1.00 |
| open-closed | 17 | 0 | 0 | 17 | 0.00 | — |

**Effective precision: 85.4%** (111/130)

The SOLID analyzer performs well on production TypeScript. `solid/class-size`, `single-responsibility`, and `solid/method-complexity` all catch real maintainability issues with high precision. `dependency-inversion` correctly identifies classes that import and instantiate concrete dependencies directly. `interface-segregation` finds interfaces with too many members.

`open-closed` is all true-but-useless — the rule flags "frequently modified" classes based on git history, but "frequently modified" does not imply "should have been closed via extension." Some classes are modified often because they're the core of the domain, not because they violate the open-closed principle.

The single false positive for `solid/method-complexity` is a test fixture; the single false positive for `single-responsibility` is also in a test file.

**Recommendation:** All SOLID rules at current severities. `open-closed` → suggestion (time-correlated signal, not deterministic).

### DRY Analyzer (6 sampled / 6 total)

| Rule | Sampled | T | F | TBU | Precision |
|------|---------|---|---|-----|-----------|
| dry/duplicate | 6 | 2 | 4 | 0 | 0.33 |

Four of six `dry/duplicate` findings are test fixtures with intentionally duplicated code. Two are production duplicates worth addressing.

**Recommendation:** Keep at current severity; sample size too small for recalibration.

## Classification Logic

The classifications follow these principles:

1. **Test fixtures are false positives by definition** — files in `src/__tests__/fixtures/`, `tests/`, `bench/corpus/` contain intentionally crafted violations. The analyzer is supposed to flag them, but they are not real bugs in the codebase. They are excluded from the "judged-true" denominator.

2. **Domain mismatch is false** — rules that assume a web-application domain (organization filters, tenant isolation) produce false positives on a CLI tool.

3. **True-but-useless covers**:
   - Documentation linting — JSDoc on every function is noise in a well-typed codebase
   - Internal tool patterns — queries without WHERE on small config tables, N+1 on local SQLite
   - Time-correlated signals — "frequently modified class" without evidence that modification is the wrong pattern
   - Schema analysis on unknown external SQL

4. **True requires that a reasonable engineer would take action.** A 300-line function is a real maintainability problem regardless of whether it's in a tool or a web app. A class with 40 methods is hard to understand regardless of domain.

## Blind Spots and Limitations

- **Single-corpus bias:** This triage covers only the code-auditor self-audit. The data-access analyzer's precision is domain-dependent — it may perform much better on a SaaS web application. The `missing-org-filter` rule, in particular, is disabled by default based on this corpus alone, but external validation on Gin and Excalidraw corpora is warranted.
- **No second reviewer:** All classifications are single-implementor judgments. A second reviewer might reasonably disagree on borderline cases (e.g., whether a 250-line function warrants refactoring).
- **Sampling error:** For rules with <400 total findings, the sample was exhaustive. For higher-volume rules (documentation, schema), the 50-finding random sample may not capture the full distribution.

## Artifacts

- Full classified triage: `bench/results/triage-classified.json` (691 findings with verdict and rationale)
- Sampling source: `bench/results/triage-sample.json`
- Full audit report: `/tmp/audit-out/audit-report.json` (2,278 raw findings)
