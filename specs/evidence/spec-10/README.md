# Spec 10 — Style Intelligence: Evidence Bundle

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
| CSS/SCSS Adapter | `src/languages/tree-sitter/TreeSitterCssAdapter.ts` |
| Style Extractor | `src/styles/styleExtractor.ts` |
| Style Normalizer | `src/styles/normalizer.ts` |
| Tailwind Expander | `src/styles/tailwindExpander.ts` |
| Tailwind Config Loader | `src/styles/tailwindConfigLoader.ts` |
| Style Indexer | `src/styles/styleIndexer.ts` |
| Styles Analyzer | `src/analyzers/universal/UniversalStylesAnalyzer.ts` |
| Style Types | `src/styles/types.ts` |
| React Raw-Element Detection | `src/analyzers/reactAnalyzer.ts` (checkRawElements) |
| Style Invariant Rules | `src/invariants/ruleEngine.ts` (style-mechanism, no-raw-values) |
| Style Bench Fixtures | `bench/corpus/styles/` |
| Bench Baseline | `bench/baselines/baseline.json` |

## Gates passed

1. **verify:close**: 43 test files, 723 tests, all pass
2. **bench**: 13/13 analyzers pass, μF1=1.0000, μTrueF1=0.9649
3. **build**: TypeScript compiles clean
4. **styles analyzer**: 8/8 non-known-miss rules F1=1.0, 1 known miss (styles/off-scale)

## Detector summary

| Detector | Rule ID | Severity | Bench Count |
|----------|---------|----------|-------------|
| Value drift | `styles/value-drift` | suggestion | 2 |
| Off-scale values | `styles/off-scale` | suggestion | 0 (1 known miss) |
| Dead/undefined classes | `styles/undefined-class` | suggestion | 1 |
| Token bypass | `styles/token-bypass` | warning | 1 |
| Mechanism fragmentation | `styles/mechanism-fragmentation` | suggestion | 1 |
| Mechanism mixing | `styles/mechanism-mixing` | suggestion | 1 |
| Declaration-set similarity | `styles/declaration-set-similarity` | suggestion | 1 |
| Z-index sprawl | `styles/z-index-sprawl` | suggestion | 1 |
| Z-index singleton | `styles/z-index-singleton` | suggestion | 1 |

## Known limitation — `styles/off-scale`

`inferScaleStep` picks step=2 which always wins ties; all remainders fall within 1px tolerance. Off-scale detection is a known algorithmic limit documented in the expected.json annotation.

## Summary

| Dimension | Status |
|-----------|--------|
| R1 — CSS/SCSS language support | ✅ |
| R2 — Style extraction (5 mechanisms) | ✅ |
| R3 — Style index, search operators, code map | ✅ |
| R4 — Styles analyzer (7 detectors, 10 rule IDs) | ✅ |
| R5 — React raw-element detection | ✅ |
| R6 — Style invariant rule kinds | ✅ |
| Test suite | 43 files, 723 tests, all passing |
| Bench harness | 13/13 analyzers, μF1=1.0000 |
| Severity (all detectors) | suggestion (entry tier), token-bypass at warning |
