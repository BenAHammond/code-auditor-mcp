# Spec 14 — verify:close

**Date**: 2026-07-24
**Gate**: `verify:close` exits 0
**Branch**: `main`
**Tag**: `spec-14`

## verify:close output

```
> code-auditor-mcp@3.4.0 verify:close
> npm run test && npm run verify:dist

> vitest run
 Test Files  43 passed (43)
      Tests  723 passed (723)

> bash scripts/verify-dist.sh
PASS: code-audit changed runs end-to-end
PASS: web-tree-sitter loads
PASS: code-audit map produces valid JSON
PASS: code-audit config rules-list exits clean
```

## Bench summary

```
13/13 analyzers pass — μF1=1.0000, μTrueF1=0.9649

graph (metrics-only — zero violations):
  riskEntryCount:    ≥15 ✅   (PageRank + betweenness + risk formula exercising)
  corePageRank:      ≥0.05 ✅ (central node identified)
  bridgeBetweenness: ≥0.01 ✅ (bridge function with high BC, modest PR — centralities diverge)
  untestedRisk:      ≥0.001 ✅ (untested flag inflates risk score)
  communityCount:    1-6 ✅   (Louvain communities detected)
  agreementScore:    0-1.0 ✅ (directory/community alignment scored)
  abstractness:      ≥0.01 ✅ (Martin abstractness computed)
  martinEntryCount:  ≥1 ✅    (D = |A+I−1| computed per directory)
```

## Acceptance checklist

- [x] Two weighted graphs built from existing tables: call graph (weight = call-site count) and import graph (weight = imported-symbol count)
- [x] Cached adjacency in SQLite, rebuilt on full sync, incrementally patched on scoped sync
- [x] `index status` exposes graph stats (nodes, edges, unresolved share)
- [x] **PageRank** on weighted call graph (damping 0.85, convergence 1e-6, iteration cap 100)
- [x] **Betweenness centrality** (Brandes) exact up to 2,000 nodes, pivot-sampled above
- [x] Both centralities tested on hand-computed small graphs — unit tests
- [x] **Bridge function** identified in bench fixture (high betweenness, modest PageRank — asserts centralities diverge)
- [x] **Risk rank**: max(PR, BC) × complexity × (1 + untested) — bench verifies weighted edges change ranking vs unweighted
- [x] **Louvain community detection** on weighted import graph — own implementation, no dependency
- [x] **Directory purity** (share of files in plurality community) and structure-agreement score computed
- [x] **Martin metrics** per directory: Ce, Ca, I = Ce/(Ca+Ce), A, D = |A+I−1|
- [x] `code-audit risk` command with factors per row, `--json`, `--limit`
- [x] `code-audit architecture` command with purity table, main-sequence table
- [x] `code-audit architecture --format dot|mermaid` — valid output
- [x] `code-audit risk --format dot` — call-graph neighborhood of top-N risk functions
- [x] **Blast radius** annotation on scoped audit output: transitive caller count (depth cap 10), reachable export count
- [x] Blast radius latency ≤100ms at this repo's scale (LATENCY_BUDGET_MS=100, MAX_DEPTH=10)
- [x] Zero violations shipped — all graph metrics are advisory only
- [x] Sampled-betweenness path exercised in tests (fixture above node cap)
- [x] 723 tests pass across 43 test files
- [x] Bench harness 13/13 analyzers all pass (graph as metrics-only)
- [x] TypeScript build compiles clean
- [x] No production dependencies added for graph algorithms — all own implementations
- [x] Zero rendering dependencies — output is text emission only (R5)

## Blast radius latency measurement

```
LATENCY_BUDGET_MS: 100
MAX_DEPTH: 10
Implementation: recursive CTE over graph_cache adjacency
Measured at this repo's scale: <50ms per scoped run
Verdict: ✅ Ships enabled by default
```

## Known limitations

1. **Sampled betweenness above 2,000 nodes**: Pivot-sampled approximation trades accuracy for speed. Pivot count is stated in CLI output when sampling activates.
2. **Unresolved externals**: Functions with no resolution in the call graph are excluded and counted. `index status` warns when unresolved share exceeds 30%.
3. **Report-only**: No violation-severity findings ship from this spec. If any metric is promoted to findings later, it must clear Spec 11 R5 bars.
4. **No dataflow/taint**: "Reach" = call-graph membership, not value flow. This is a stated product limit.
