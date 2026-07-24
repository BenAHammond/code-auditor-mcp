# Spec 12 — verify:close

**Date**: 2026-07-24
**Gate**: `verify:close` exits 0
**Branch**: `main`
**Tag**: `spec-12`

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

conventions (per-rule):
  conventions/usage-pair:     1 TP, 0 FP, 0 FN — F1=1.0
  conventions/import-form:    1 TP, 0 FP, 0 FN — F1=1.0
  conventions/error-handling: 1 TP, 0 FP, 0 FN — F1=1.0
  conventions/export-shape:   1 TP, 0 FP, 0 FN — F1=1.0
  conventions/naming:         1 TP, 0 FP, 0 FN — F1=1.0
```

## Acceptance checklist

- [x] All 5 convention domains produce positive findings on the bench corpus: usage-pair, import-form, error-handling, export-shape, naming
- [x] `usage-pair` detects functions with antecedent but not consequent at confidence ≥ 0.9
- [x] `import-form` detects minority import form against dominant pattern at share ≥ 0.8
- [x] `error-handling` detects error-handling deviants against directory mode
- [x] `export-shape` detects export shape deviants against directory mode
- [x] `naming` detects casing deviants in exported symbols against directory mode
- [x] All five detectors operate on mined conventions cached in SQLite `conventions` table
- [x] Scoped runs evaluate against full-index conventions (statistics never from scope alone)
- [x] Thresholds (`pairConfidence`, `modeShare`, `minCorpus`) configurable via analyzer config
- [x] CLI `conventions` command lists mined conventions with stats, `--json` supported
- [x] CLI `conventions --propose` emits valid rule JSON passing `rules-check` for expressible conventions
- [x] Non-Latin identifiers correctly skipped in naming casing classification (Spec 21 R5)
- [x] All findings at `suggestion` severity (entry tier)
- [x] `nearMissFiles` entry validates deviant+approved pattern
- [x] 723 tests pass across 43 test files
- [x] Bench harness 13/13 analyzers all pass
- [x] TypeScript build compiles clean
- [x] No production dependencies added — all new modules are internal

## Known limitations

1. **Non-Latin identifiers**: The naming convention miner cannot classify casing for non-Latin identifiers and skips them. This is by design — Unicode casing rules are script-dependent and context-sensitive; a statistical convention miner should not guess.
2. **Single-repo scope**: The data model is one index per project. Multi-repo aggregation is out of scope (different storage and identity model).
3. **Expressible rule proposals**: Only conventions mappable to existing rule kinds (naming → `naming`, import form → `import-ban`) are proposed via `--propose`. Usage-pair, error-handling, and export-shape conventions with no expressible kind are listed as "detector-only."
