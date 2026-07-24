# Spec 13 — Hotspots & Temporal Analysis: Evidence Bundle

**Date**: 2026-07-23
**verify:close result**: ✅ exits 0 — 610/610 tests pass, bench 12/12 pass, verify:dist passes

---

## Evidence files

| File | Content |
|------|---------|
| [verify-close.md](verify-close.md) | verify:close transcript, bench summary, acceptance checklist, known limitation documentation |
| [plan.md](plan.md) | Pre-implementation plan with gap analysis and implementation order |

## Supporting artifacts (in repo)

| Artifact | Path |
|----------|------|
| Churn extraction module | `src/churn/churnExtractor.ts` |
| Hotspot scoring module | `src/hotspots/hotspotScorer.ts` |
| Diverging-clone tracking (two-phase) | `src/auditRunner.ts` lines 677-910 |
| DRY pair seeding | `src/analyzers/universal/UniversalDRYAnalyzer.ts` |
| Temporal tables (SCHEMA_VERSION → 5) | `src/codeIndexDB.ts` |
| Churn + divergence config | `src/config/defaults.ts` |
| `hotspot` field on all surfaces | `src/types.ts`, `src/reporting/`, `src/mcp.ts` |
| CLI commands: hotspots, ledger trends | `src/cli.ts` |
| Trend comparison engine | `src/ledger.ts` |
| Diverging-clones bench corpus | `bench/corpus/diverging-clones/` |
| Bench baseline | `bench/baselines/baseline.json` |
| Bench results (latest) | `bench/results/latest.json` |
| CHANGELOG Spec 13 section | `CHANGELOG.md` |
| Recalibration entry (diverging-clone) | `bench/results/recalibration.md` |

## Gates passed

1. **verify:close**: 40 test files, 610 tests, all dist checks pass
2. **bench**: 12/12 analyzers pass (μF1=1.0000, diverging-clones F1=1.0000)
3. **build**: TypeScript compiles clean
4. **hook path**: `code-audit changed --fail-on critical` exits correctly
5. **no-repo degradation**: Churn gracefully degrades to absent with one-line notice when no git repo

## Out of scope for static evaluation

Divergence detection requires ≥2 consecutive full-audit runs to measure similarity trajectory. The static bench corpus works around this with manually seeded `dry_pair_history` rows, proving the detector logic is correct. Real-world divergence validation is deferred until ≥10 divergence findings accumulate across organic full runs.

## Summary

| Dimension | Status |
|-----------|--------|
| R1 — Churn extraction (file + function level) | ✅ |
| R2 — Hotspot scoring + finding reordering | ✅ |
| R3 — Ownership analytics + bus-factor | ✅ |
| R4 — Ledger trends (new/fixed, per rule, per severity) | ✅ |
| R5 — Diverging clones (two-phase: seed + re-measure) | ✅ |
| R6 — Bench fixtures + git-history corpus | ✅ |
| Test suite | 40 files, 610 tests, all passing |
| Bench harness | 12/12 analyzers, μF1=1.0000 |
| Severity (diverging-clone) | `suggestion` — correct entry tier |
