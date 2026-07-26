# Spec 22 Evidence Bundle — Signal Hotfix 2

**Date:** 2026-07-20
**Status:** Complete
**Spec:** `specs/spec-22-signal-hotfix-2.md`
**Source Data:** `specs/test-feedback/test-feedback.md` (committed verbatim, hash-asserted)

## Bundle Contents

| File | Description |
|------|-------------|
| `README.md` | This index |
| `verify-close.md` | Exit criteria, acceptance checklist, gate status |
| `resolutions.md` | Triage items mapped to spec requirements with resolutions |

## Requirements Coverage

| Requirement | Description | Status |
|-------------|-------------|--------|
| R1 | Styles undefined-class — Tailwind utility dictionary + fail-open rule | ✅ |
| R2 | Styles token-bypass — definition sites + var() references excluded | ✅ |
| R3 | Styles value-drift — categorical properties excluded | ✅ |
| R4 | SQL extraction regression — routing gates + alias filtering | ✅ |
| R5.1 | Conventions naming — export-kind partitioning | ✅ |
| R5.2 | Conventions usage-pair — built-in/stdlib exclusion | ✅ |
| R6 | Evidence bundle (this document) | ✅ |

## Artifacts

- Bench fixtures: `bench/corpus/styles/`, `bench/corpus/data-access/`, `bench/corpus/schema/`, `bench/corpus/conventions/`
- Bench baseline: `bench/baselines/baseline.json`
- CHANGELOG: `CHANGELOG.md` (Unreleased — Spec 22 Signal Hotfix 2)

## Severity Tier

All touched rules remain at `suggestion` severity. No tier promotions — the next recalibration pass will use this spec's fixtures and the committed triage as inputs.

## Hook Path

Byte-identical to v3.4.1 on hook-contract fixtures. No hook ever blocked on any affected rule (all suggestion-tier).
