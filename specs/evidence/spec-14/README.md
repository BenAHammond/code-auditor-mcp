# Spec 14 — Graph & Architecture: Evidence Bundle

**Date**: 2026-07-24
**verify:close result**: ✅ exits 0 — 723/723 tests pass, bench 13/13 pass, build clean

---

## Evidence files

| File | Content |
|------|---------|
| [verify-close.md](verify-close.md) | verify:close transcript, bench summary, per-metric results, acceptance checklist, blast radius latency measurement |
| [plan.md](plan.md) | Pre-implementation plan with architecture and implementation order |

## Supporting artifacts (in repo)

| Artifact | Path |
|----------|------|
| Graph Cache | `src/graph/graphCache.ts` |
| PageRank | `src/graph/pageRank.ts` |
| Betweenness Centrality | `src/graph/betweenness.ts` |
| Louvain Community Detection | `src/graph/louvain.ts` |
| Blast Radius | `src/graph/blastRadius.ts` |
| Risk Ranking | `src/graph/riskRanking.ts` |
| Martin Metrics | `src/graph/martinMetrics.ts` |
| Graph Unit Tests | `src/graph/__tests__/*.test.ts` |
| Graph Types | `src/types.ts` |
| Schema Migration (v5) | `src/codeIndexDB.ts` |
| Defaults Config | `src/config/defaults.ts` |
| CLI Commands | `src/cli.ts` (index status, risk, architecture) |
| CodeMap Sections | `src/services/CodeMapGenerator.ts` |
| Bench Fixture | `bench/corpus/graph/` |
| Bench Baseline | `bench/baselines/baseline.json` |

## Gates passed

1. **verify:close**: 43 test files, 723 tests, all pass
2. **bench**: 13/13 analyzers pass, μF1=1.0000, μTrueF1=0.9649
3. **build**: TypeScript compiles clean
4. **graph analyzer**: metrics-only, all 8 expected metrics present in bench fixture

## Metric summary

| Metric | Bench constraint | Result |
|--------|-----------------|--------|
| Risk entry count | ≥15 | ✅ (PageRank, betweenness, risk formula exercising) |
| Core PageRank | ≥0.05 | ✅ (central node identified) |
| Bridge betweenness | ≥0.01 | ✅ (bridge: high BC, modest PR — centralities diverge) |
| Untested risk | ≥0.001 | ✅ (untested flag inflates risk score) |
| Community count | 1-6 | ✅ (Louvain communities detected) |
| Agreement score | 0-1.0 | ✅ (directory/community alignment scored) |
| Abstractness | ≥0.01 | ✅ (Martin abstractness computed) |
| Martin entry count | ≥1 | ✅ (D = |A+I−1| per directory) |

## Key design invariants

1. **Zero violations from this spec** — all graph and architecture metrics are advisory (reports and annotations). The bench `expected.json` uses `"kind": "metrics"` with `expectedMetrics` instead of `expectedViolations`.
2. **Blast radius ≤100ms hook budget** — recursive CTE with MAX_DEPTH=10. Measured at <50ms at this repo's scale. Ships enabled by default.
3. **All graph algorithms are own implementations** — zero algorithm dependencies. PageRank (iterative), Brandes betweenness (exact + pivot-sampled), Louvain community detection.
4. **No rendering dependencies** — Graphviz/Mermaid output is text emission only; rendering stays the consumer's tool.

## Summary

| Dimension | Status |
|-----------|--------|
| R1 — Graph construction (weighted call + import graphs) | ✅ |
| R2 — PageRank + betweenness centrality + risk ranking | ✅ |
| R3 — Louvain community detection + directory purity | ✅ |
| R4 — Instability/abstractness Martin metrics + D distance | ✅ |
| R5 — Graph output formats (dot, mermaid) | ✅ |
| R6 — Blast radius in hook path (≤100ms budget) | ✅ |
| R7 — Measurement (bench fixture, unit tests, algorithm verification) | ✅ |
| Test suite | 43 files, 723 tests, all passing |
| Bench harness | 13/13 analyzers, μF1=1.0000 |
| Violations shipped | **Zero** — reports and annotations only |
| Blast radius latency | <50ms at this repo's scale — ships enabled |
