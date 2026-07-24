# Spec 12 — Implementation Plan

**Date**: 2026-07-24

## Architecture

Convention Mining runs over the existing SQLite index at sync time, mining five domains of statistical convention from the codebase's own corpus. Results are cached in a `conventions` table and used by a `UniversalConventionsAnalyzer` that flags minority deviations — all at `suggestion` severity.

### New modules

| File | Purpose |
|------|---------|
| `src/conventions/conventionMiner.ts` | Mining engine — 5 domain miners over SQLite index |
| `src/analyzers/universal/UniversalConventionsAnalyzer.ts` | Analyzer — compares per-file symbols against mined conventions |
| `src/analyzers/universal/__tests__/UniversalConventionsAnalyzer.test.ts` | Unit tests |

### Modified files

| File | Change |
|------|--------|
| `src/types.ts` | Convention types (Convention, ConventionDomain, MinedConvention) |
| `src/codeIndexDB.ts` | Schema migration (v4), `conventions` table, `getConventions()`, `upsertConvention()` |
| `src/services/deepSync.ts` | Wire miner into `deepSync()` post-index |
| `src/config/defaults.ts` | Analyzer config (`pairConfidence: 0.9`, `modeShare: 0.8`, `minCorpus: 20`) |
| `src/auditRunner.ts` | Wire `UniversalConventionsAnalyzer` |
| `src/cli.ts` | `conventions` command group (list, propose) |
| `bench/corpus/conventions/expected.json` | Ground truth |
| `bench/corpus/conventions/src/fixture.ts` | Fixture source |
| `src/scripts/runBench.ts` | Bench entry |
| `bench/baselines/baseline.json` | Baseline entry |
| `src/__tests__/bench.test.ts` | Expected analyzer count |
| `SKILL.md`, `CHANGELOG.md` | Docs |

## Five Convention Domains

1. **usage-pair** — antecedent→consequent call pairs with confidence ≥ `pairConfidence` (0.9) and support ≥ `minCorpus` (20)
2. **import-form** — dominant import form (alias/relative/deep-path) per module specifier at share ≥ `modeShare` (0.8)
3. **error-handling** — dominant error-handling shape (try/catch, .catch, result-envelope) per directory ≥ `modeShare` (0.8) over ≥ `minCorpus` (20) functions
4. **export-shape** — default vs named export mode per directory under same thresholds
5. **naming** — dominant exported-symbol casing convention per directory under same thresholds

Non-Latin identifiers: unclassifiable for casing — skipped, not misclassified (Spec 21 R5).

## Severity

All five domains ship at `suggestion` severity — entry tier. Promotion to warning requires clearing Spec 11 R5 bars (≥0.95 precision AND ≥0.90 judged-true) through real-corpus triage.

## Implementation Order

1. Types → 2. Schema migration → 3. Convention miner engine → 4. Wire into deepSync → 5. Analyzer → 6. Wire into auditRunner + defaults → 7. CLI commands → 8. SKILL.md → 9. Bench fixture → 10. Bench runner + baseline → 11. Build, test → 12. CHANGELOG → 13. Tag
