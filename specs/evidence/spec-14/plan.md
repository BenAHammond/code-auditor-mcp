# Spec 14 — Implementation Plan

**Date**: 2026-07-24

## Architecture

Graph & Architecture builds on existing SQLite tables (`function_calls`, `imports`) to construct weighted directed graphs, compute network-analysis metrics (PageRank, betweenness centrality, Louvain community detection), and expose architecture reports. **All advisory — reports and annotations only, zero violations.**

### New modules

| File | Purpose |
|------|---------|
| `src/graph/graphCache.ts` | Graph construction from existing tables (call graph + import graph), adjacency caching, incremental patching |
| `src/graph/pageRank.ts` | Weighted PageRank (damping 0.85, convergence 1e-6, iteration cap 100) |
| `src/graph/betweenness.ts` | Exact Brandes (≤2000 nodes), pivot-sampled approximation above |
| `src/graph/louvain.ts` | Louvain community detection on weighted import graph |
| `src/graph/blastRadius.ts` | Recursive CTE blast radius (MAX_DEPTH=10, LATENCY_BUDGET_MS=100) |
| `src/graph/riskRanking.ts` | Risk formula: max(PR percentile, BC percentile) × complexity percentile × (1 + untested) |
| `src/graph/martinMetrics.ts` | Ce/Ca, instability I, abstractness A, distance D per directory |
| `src/graph/__tests__/*.test.ts` | Unit tests against hand-computed small graphs |

### Modified files

| File | Change |
|------|--------|
| `src/types.ts` | Graph types (GraphStats, RiskEntry, CommunityReport, MartinMetrics) |
| `src/codeIndexDB.ts` | Schema migration (v5), graph_cache table, community_cache table, coverage_data table |
| `src/services/deepSync.ts` | Wire graph construction into `deepSync()` |
| `src/auditRunner.ts` | Blast radius annotation on scoped runs |
| `src/cli.ts` | `index status` (graph stats), `risk`, `architecture` commands, `--format dot|mermaid` |
| `src/services/CodeMapGenerator.ts` | CodeMap `risk` and `architecture` sections |
| `src/config/defaults.ts` | Graph config (`betweennessExactNodeCap: 2000`, `communityMinFiles: 5`) |
| `bench/corpus/graph/expected.json` | Metrics-only ground truth |
| `bench/corpus/graph/src/*.ts` | Fixture source files |
| `src/scripts/runBench.ts` | Graph bench entry |
| `bench/baselines/baseline.json` | Graph baseline entry |
| `src/__tests__/bench.test.ts` | Expected analyzer count |
| `SKILL.md`, `CHANGELOG.md` | Docs |

## Key Design Decisions

1. **Zero violations**: Graph and architecture metrics are advisory only. No violation-severity findings ship from this spec. The `expected.json` uses `"kind": "metrics"` with `expectedMetrics` instead of `expectedViolations`.
2. **Blast radius latency budget**: ≤100ms at this repo's scale. Implemented with recursive CTE, MAX_DEPTH=10. If the budget is missed, impact ships disabled by default.
3. **Sampled betweenness**: Exact Brandes up to 2000 nodes; pivot-sampled approximation above. Fixture exercises both paths.
4. **No rendering dependencies**: Graphviz/Mermaid output is text emission only. The user's tool renders.

## Implementation Order

1. Types → 2. Schema migration → 3. Graph construction (graphCache) → 4. PageRank → 5. Betweenness → 6. Risk ranking → 7. Louvain community detection → 8. Martin metrics → 9. Blast radius → 10. Wire into deepSync + auditRunner → 11. CLI commands → 12. CodeMap sections → 13. Unit tests → 14. Bench fixture → 15. Bench runner + baseline → 16. Build, test → 17. SKILL.md, CHANGELOG → 18. Tag
