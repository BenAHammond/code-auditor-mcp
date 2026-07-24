# Spec 15 — verify:close

**Date**: 2026-07-24
**Gate**: `verify:close` exits 0
**Branch**: `main`
**Tag**: `spec-15`

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
10/10 analyzers pass — μF1=1.0000, μPrecision=1.0000, μRecall=1.0000

cross-domain (metrics-only):
  written-never-read:  5  (min: 5) ✅
  read-never-written:  1  (min: 1) ✅
  transaction-boundary-risk: 1 (min: 1) ✅
  validation-bypass:   3  (min: 3) ✅
  uncovered-risk:      10 (min: 1) ✅
  totalViolations:     20 (min: 11) ✅
```

## Acceptance checklist

- [x] All 5 cross-domain detectors produce positive findings on the bench corpus
- [x] `written-never-read` detects tables with INSERT/UPDATE/CREATE but zero SELECT (5 violations)
- [x] `read-never-written` detects tables with SELECT but zero INSERT/UPDATE/CREATE (1 violation)
- [x] `transaction-boundary-risk` detects functions writing ≥ `txnTableMax` (4) distinct tables (1 violation)
- [x] `validation-bypass` uses provenance-based validator detection (zod import) and directory-grouped BFS (3 violations)
- [x] `uncovered-risk` detects high-risk functions with no test coverage via static-reach fallback (10 violations)
- [x] All findings ship at `suggestion` severity (entry tier)
- [x] 723 tests pass across 43 test files
- [x] Bench harness 10/10 analyzers all pass
- [x] TypeScript build compiles clean
- [x] No production dependencies added — all new modules are internal

## Known limitations

1. **Post-analysis only**: All five detectors require a populated SQLite index (schema_usage, graph_cache, hotspot_scores, coverage_data). They cannot run as per-file AST analyzers — they are wired as a full `UniversalAnalyzer` subclass with the `analyze()` method overridden to bypass the per-file loop.
2. **Validators require provenance**: The validation-bypass detector's primary path requires validator packages (zod, joi, etc.) present in imports for provenance detection. The `validate*`/`assert*` name heuristic is a conjunctive fallback used only when zero provenance-detected validators exist AND no user config is provided.
3. **Static-reach fallback**: The uncovered-risk detector uses a static-reach fallback (test file imports high-risk functions) when no measured coverage data exists. Measured coverage requires `code-audit coverage --import <path>`.
4. **No dataflow/taint analysis**: Per the stated product limit, "reach" = call-graph membership, not value flow. Validator reach is BFS through the call graph, not taint propagation.
