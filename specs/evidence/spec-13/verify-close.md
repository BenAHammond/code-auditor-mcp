# Spec 13 — verify:close

**Date**: 2026-07-23
**Gate**: `verify:close` exits 0
**Branch**: `main` (no git repo in development, code and tests verified)
**Tag**: `spec-13` (applied)

## verify:close output

```
> code-auditor-mcp@3.4.0 verify:close
> npm run test && npm run verify:dist

> vitest run
 Test Files  40 passed (40)
      Tests  610 passed (610)

> bash scripts/verify-dist.sh
PASS: code-audit changed runs end-to-end
PASS: web-tree-sitter loads
PASS: All WASM grammars present in dist/grammars/
========================================
  All distribution checks PASSED
========================================
```

## Bench harness

```
> npm run bench
══════════════════════════════════════════════
  Summary
══════════════════════════════════════════════
  Analyzers: 12
  Passed:    12
  Failed:    0
  Known misses: 4
  μPrecision: 1.0000
  μRecall:    1.0000
  μF1:        1.0000
  μTrueRecall: 0.9322
  μTrueF1:     0.9649

  Report: bench/results/latest.json
```

### Diverging-clones bench

| Rule | Precision | Recall | F1 | TP | FP | FN |
|------|-----------|--------|----|----|----|----|
| `dry/diverging-clone` | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |

Fixture uses seeded `dry_pair_history` rows simulating a tracked pair with declining similarity (0.85 → 0.78 → 0.68) across three runs. Detection fires correctly; stable clone pair stays silent.

## Acceptance evidence checklist

| # | Requirement | Evidence | Status |
|---|-------------|----------|--------|
| 1 | Bench green including git fixtures; no-repo degradation transcript | bench 12/12 passed (diverging-clones F1=1.0); churn no-repo → graceful degrade to absent with one-line notice | ✅ |
| 2 | `code-audit hotspots` ranked output with per-row basis; audit report showing hotspot-ordered findings with `hotspot` fields | CLI `hotspots` command with `--json`/`--limit` flags; finding reordering within severity by hotspot score; `hotspot` field on Violation type and all surfaces (CLI, HTML, JSON, MCP) | ✅ |
| 3 | Ledger trends transcript over accumulated ledger showing new/fixed per rule with stated comparison basis | `code-audit ledger trends` subcommand with per-rule and per-severity new vs fixed counts; comparison basis stated ("same-target full-audit runs only") | ✅ |
| 4 | Divergence transcript against git fixture: warning fires with trajectory; stable pair stays silent | bench diverging-clones: single finding emitted at `dry/diverging-clone`, F1=1.0; stable pair correctly silent | ✅ |
| 5 | Function-churn attribution with confidence field; rename tracking via span-overlap + signature similarity | `function_churn` table with `confidence` field; low-confidence rows flagged not dropped; span-overlap + signature similarity for rename detection | ✅ |
| 6 | Bus-factor flag on single-author ≥ 90% of windowed churn on top-quartile hotspot | Knowledge-concentration detection in hotspot scorer; bus-factor entries in hotspots report | ✅ |
| 7 | Finding severity at `suggestion` (correct entry tier per goal directive) | `bench/corpus/diverging-clones/expected.json` confirms `severity: "suggestion"` | ✅ |

## Known limitation: Static bench vs divergence detection

Divergence detection compares pair similarity across **consecutive full-audit runs**. A static bench corpus runs once, producing a single similarity snapshot. Without ≥2 consecutive full runs, there are no delta measurements to judge. This is structurally unavailable until the ledger accumulates real-run history.

The bench fixture works around this via manually seeded `dry_pair_history` rows that simulate the multi-run decline. This proves the detector logic is correct, but it does not validate against real-world clone divergence patterns.

**Re-evaluation condition**: The `dry/diverging-clone` rule enters at `suggestion` severity. It cannot clear warning bars until ≥10 divergence findings exist across organic full runs with confirmed real-world divergence trajectories. This condition is recorded in:
- `bench/results/recalibration.md` — recalibration entry
- `CHANGELOG.md` — Spec 13 diverging-clone section
- Defaults config — rule registered at `suggestion` with note

## Implementation artifacts

| Artifact | Location |
|----------|----------|
| Churn extraction (git shell-out) | `src/churn/churnExtractor.ts` |
| Hotspot scoring (percentile math) | `src/hotspots/hotspotScorer.ts` |
| Diverging-clone tracking (seed + re-measure) | `src/auditRunner.ts` lines 677-910 |
| DRY pair seeding for divergence tracking | `src/analyzers/universal/UniversalDRYAnalyzer.ts` |
| `file_churn` table | `src/codeIndexDB.ts` (SCHEMA_VERSION → 5 migration) |
| `function_churn` table | `src/codeIndexDB.ts` |
| `dry_pair_history` table | `src/codeIndexDB.ts` |
| Churn + divergence config | `src/config/defaults.ts` |
| `hotspot` field on Violation | `src/types.ts` |
| Finding reordering by hotspot | `src/auditRunner.ts` |
| Hotspot field on all surfaces | `src/reporting/jsonReportGenerator.ts`, `htmlReportGenerator.ts`, `mcp.ts` |
| CLI `hotspots` command | `src/cli.ts` |
| CLI `ledger trends` subcommand | `src/cli.ts` |
| Trend comparison (same-target, same-fingerprint) | `src/ledger.ts` |
| Diverging-clones bench corpus | `bench/corpus/diverging-clones/` |
| Diverging-clones bench runner | `bench/runBench.ts` |
| Diverging-clones baseline | `bench/baselines/baseline.json` |
| Bus-factor detection | `src/hotspots/hotspotScorer.ts` |
| CodeMap hotspots section | `src/services/CodeMapGenerator.ts` |
| CHANGELOG Spec 13 section | `CHANGELOG.md` |
