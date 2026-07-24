# Spec 12 — Convention Mining: Evidence Bundle

**Date**: 2026-07-24
**verify:close result**: ✅ exits 0 — 723/723 tests pass, bench 13/13 pass, build clean

---

## Evidence files

| File | Content |
|------|---------|
| [verify-close.md](verify-close.md) | verify:close transcript, bench summary, per-rule results, acceptance checklist |
| [plan.md](plan.md) | Pre-implementation plan with architecture and implementation order |

## Supporting artifacts (in repo)

| Artifact | Path |
|----------|------|
| Convention Miner | `src/conventions/conventionMiner.ts` |
| Conventions Analyzer | `src/analyzers/universal/UniversalConventionsAnalyzer.ts` |
| Analyzer Tests | `src/analyzers/universal/__tests__/UniversalConventionsAnalyzer.test.ts` |
| Convention Types | `src/types.ts` (Convention, ConventionDomain, MinedConvention) |
| Schema Migration (v4) | `src/codeIndexDB.ts` |
| Defaults Config | `src/config/defaults.ts` |
| CLI Commands | `src/cli.ts` (conventions, conventions --propose) |
| Bench Fixture | `bench/corpus/conventions/` |
| Bench Baseline | `bench/baselines/baseline.json` |

## Gates passed

1. **verify:close**: 43 test files, 723 tests, all pass
2. **bench**: 13/13 analyzers pass, μF1=1.0000, μTrueF1=0.9649
3. **build**: TypeScript compiles clean
4. **conventions analyzer**: 5/5 rules F1=1.0 — all at suggestion severity

## Detector summary

| Detector | Rule ID | Severity | Bench TP | Precision | Recall | F1 |
|----------|---------|----------|----------|-----------|--------|----|
| Usage pairs | `conventions/usage-pair` | suggestion | 1 | 1.0 | 1.0 | 1.0 |
| Import form | `conventions/import-form` | suggestion | 1 | 1.0 | 1.0 | 1.0 |
| Error handling | `conventions/error-handling` | suggestion | 1 | 1.0 | 1.0 | 1.0 |
| Export shape | `conventions/export-shape` | suggestion | 1 | 1.0 | 1.0 | 1.0 |
| Naming | `conventions/naming` | suggestion | 1 | 1.0 | 1.0 | 1.0 |

## Summary

| Dimension | Status |
|-----------|--------|
| R1 — Five convention domains (usage-pair, import-form, error-handling, export-shape, naming) | ✅ |
| R2 — Conventions analyzer at suggestion severity | ✅ |
| R3 — CLI conventions command + --propose rule emission | ✅ |
| R4 — Bench fixture + harness + baseline | ✅ |
| Test suite | 43 files, 723 tests, all passing |
| Bench harness | 13/13 analyzers, μF1=1.0000 |
| Severity (all detectors) | `suggestion` — correct entry tier |
| Non-Latin identifiers | Skipped, not misclassified (Spec 21 R5) |
