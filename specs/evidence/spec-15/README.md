# Spec 15 — Cross-Domain Joins: Evidence Bundle

**Date**: 2026-07-24
**verify:close result**: ✅ exits 0 — 723/723 tests pass, bench 10/10 pass, build clean

---

## Evidence files

| File | Content |
|------|---------|
| [verify-close.md](verify-close.md) | verify:close transcript, bench summary, acceptance checklist |
| [plan.md](plan.md) | Pre-implementation plan with architecture and implementation order |

## Supporting artifacts (in repo)

| Artifact | Path |
|----------|------|
| Cross-Domain Analyzer | `src/analyzers/crossDomain/CrossDomainAnalyzer.ts` |
| Cross-Domain Analyzer tests | `src/analyzers/crossDomain/__tests__/CrossDomainAnalyzer.test.ts` |
| ORM adapter registry | `src/analyzers/orm/adapterRegistry.ts` |
| ORM adapter types | `src/analyzers/orm/types.ts` |
| Drizzle ORM adapter | `src/analyzers/orm/drizzleAdapter.ts` |
| Prisma ORM adapter | `src/analyzers/orm/prismaAdapter.ts` |
| ORM adapter index | `src/analyzers/orm/index.ts` |
| ORM adapter tests | `src/analyzers/orm/__tests__/ormAdapters.test.ts` |
| Coverage LCOV parser | `src/coverage/lcovParser.ts` |
| Coverage Istanbul parser | `src/coverage/istanbulParser.ts` |
| Coverage service | `src/coverage/coverageService.ts` |
| Coverage parser tests | `src/coverage/__tests__/parsers.test.ts` |
| Schema usage recording | `src/analyzers/universal/UniversalSchemaAnalyzer.ts` |
| Validator provenance infrastructure | `src/analyzers/provenance.ts` (Spec 21) |
| Schema migration (v6→v7) | `src/codeIndexDB.ts` |
| Cross-domain config types | `src/types.ts` |
| Cross-domain defaults | `src/config/defaults.ts` |
| Cross-domain run entry | `src/auditRunner.ts` |
| Coverage CLI commands | `src/cli.ts` |
| Coverage CodeMap section | `src/services/CodeMapGenerator.ts` |
| Bench corpus | `bench/corpus/cross-domain/` |
| Bench runner entry | `src/scripts/runBench.ts` |
| Bench baseline | `bench/baselines/baseline.json` |
| Bench test update | `src/__tests__/bench.test.ts` |
| CHANGELOG Spec 15 section | `CHANGELOG.md` |

## Gates passed

1. **verify:close**: 43 test files, 723 tests, all pass
2. **bench**: 10/10 analyzers pass, cross-domain metrics-only F1=1.0000
3. **build**: TypeScript compiles clean (`npm run build`)
4. **All 5 detectors fire** on the bench corpus with positive counts
5. **Non-English gate**: Three Spec 21 known-misses (autoriser/missing-auth, nettoyer/missing-sanitization, verarbeiten/open-closed) correctly annotated — none affect validation-bypass (per-identifier provenance detection is language-agnostic)
6. **Coverage riders**: All uncovered-risk violations carry `basis` (`measured` or `static-reach`); measured-path violations carry `sourceFormat`; stale-import warning fires when coverage predates last sync

## Detector summary

| Detector | Rule ID | Severity | Bench count |
|----------|---------|----------|-------------|
| Written-never-read | `cross-domain/written-never-read` | suggestion | ≥5 |
| Read-never-written | `cross-domain/read-never-written` | suggestion | ≥1 |
| Transaction-boundary risk | `cross-domain/transaction-boundary-risk` | suggestion | ≥1 |
| Validation bypass | `cross-domain/validation-bypass` | suggestion | ≥4 |
| Uncovered risk | `cross-domain/uncovered-risk` | suggestion | ≥1 |
| **Total** | | | **≥15** |

## Out of scope for static evaluation

All cross-domain detectors require post-analysis SQLite queries joining `schema_usage`, `graph_cache`, `hotspot_scores`, and `coverage_data` tables — these are available only after a full index sync. The bench harness seeds these tables in-memory before running the analyzer. Real-world validation is deferred until the fields accumulate through organic full-audit runs.

## Summary

| Dimension | Status |
|-----------|--------|
| R1 — Schema lifecycle (written-never-read, read-never-written, txn boundary risk) | ✅ |
| R2 — ORM-aware schema extraction (Drizzle + Prisma adapters) | ✅ |
| R3 — Validation-bypass detection (provenance-based, directory-grouped) | ✅ |
| R4 — Coverage by importance (LCOV + Istanbul parsers, static-reach fallback) | ✅ |
| R5 — Bench fixtures + harness + baseline | ✅ |
| Test suite | 43 files, 723 tests, all passing |
| Bench harness | 10/10 analyzers, μF1=1.0000 |
| Severity (all detectors) | `suggestion` — correct entry tier |
