# Spec 22 — Triage Resolutions

**Source:** `specs/test-feedback/test-feedback.md` (committed verbatim, SHA-256: `f5f82835eaf8f0da8c46dcf86dc8c11b0818a02346c7547f92955cb701a6449b`)
**Date:** 2026-07-20

## Triage Items → Requirements

The post-release dogfood triage of code-auditor-mcp@3.4.1 on the recall corpus (8,160 findings; ~21% real; ~79% false, concentrated in styles/conventions/cross-domain) identified six defect classes.

| Triage Item | Defect Class | Findings | Spec Requirement | Resolution |
|-------------|-------------|----------|------------------|------------|
| 1 | styles/undefined-class | 2,837 | R1 | Tailwind utility dictionary generated from default theme; arbitrary-value grammar (`mt-[17px]`); variant prefix handling; fail-open rule disables detector on config resolution failure |
| 2 | styles/token-bypass | ~1,200 | R2 | CSS custom property definition sites and `var()` references excluded from token-bypass; only raw literals in usage position flagged |
| 3 | styles/value-drift | ~130 | R3 | Categorical CSS properties (21-property exclusion list) excluded from drift analysis; drift applies only to continuous domains (lengths, colors, numerics) |
| 4 | SQL extraction — JS identifiers as SQL | ~120 | R4 | Routing gates on Drizzle adapter (file-level import check, expression-level companion-method gates); data-access variable-assignment keyword threshold 1→2; SQL alias filtering |
| 5 | conventions/naming — mixed populations | ~150 | R5.1 | Naming conventions partitioned by export kind (React components, hooks, functions, constants); per-population minCorpus; stored in `export_kind` DB column |
| 6 | conventions/usage-pair — built-in correlation | ~50 | R5.2 | Built-in/stdlib calls (~80 identifiers) excluded from antecedent/consequent; antecedents must be project-defined (functions-table membership); pairConfidence 0.9→0.95, minCorpus 20→30 |

## Noise Reduction Estimates

| Analyzer | Before (est.) | After (est.) | Primary Requirements |
|----------|---------------|--------------|---------------------|
| styles | ~4,167 | ~0 | R1, R2, R3 |
| conventions | ~200 | ~0–50 | R5.1, R5.2 |
| data-access/schema | ~120 | ~0 | R4 |

*Before counts from triage data; after counts are estimated from fixture-gated fixes. The ~50 residual in conventions is the error-handling domain (legitimate alternatives at suggestion severity — working as intended per spec R5.3).*

## Positive Detector Confirmation

Each fix is paired with a positive fixture proving the detector still fires on its true case:

| Requirement | Positive Fixture | Expected Finding |
|-------------|-----------------|-----------------|
| R1 | genuinely undefined class (`bg-tyop-blue`) | 1 finding |
| R2 | raw hex `#22d3ee` where `--accent` token exists | 1 finding naming the token |
| R3 | 2 off-values against 47 clustered values | 1 drift finding |
| R4 | N/A — noise elimination, no positive cases affected | — |
| R5.1 | `my_snake_function` in PascalCase component directory (function population) | 1 finding |
| R5.2 | `errorHandler` calling `handleError` without `logError` (both project-defined) | 1 finding |

## Severity Tier Confirmation

All affected rules inspected — every one at `suggestion` severity:
- `styles/undefined-class`: suggestion
- `styles/token-bypass`: suggestion
- `styles/value-drift`: suggestion
- All data-access/schema SQL-adjacent rules: suggestion
- All conventions rules: suggestion
