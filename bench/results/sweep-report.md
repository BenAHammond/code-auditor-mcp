# Sweep Report

**Generated:** 2026-07-23T19:59:35.115Z
**Parameters swept:** 13
**Confirmed (no change):** 3
**Changed:** 10

## Summary

| Parameter | Current | Recommended | Status |
|-----------|---------|-------------|--------|
| DRY minLineThreshold | 15 | 3 | ⚠️ CHANGED |
| DRY similarityThreshold | 0.85 | 0.5 | ⚠️ CHANGED |
| React maxComponentComplexity | 15 | 5 | ⚠️ CHANGED |
| React wrapperMinUsages | 4 | 2 | ⚠️ CHANGED |
| SOLID maxMethodComplexity | 50 | 10 | ⚠️ CHANGED |
| SOLID maxLinesPerMethod | 50 | 50 | ✅ CONFIRMED |
| SOLID maxParametersPerMethod | 4 | 4 | ✅ CONFIRMED |
| SOLID maxImportsPerFile | 20 | 5 | ⚠️ CHANGED |
| SOLID classMethodsThreshold | 15 | 5 | ⚠️ CHANGED |
| SOLID classAggregateComplexity | 100 | 80 | ⚠️ CHANGED |
| Schema maxQueriesPerFunction | 5 | 1 | ⚠️ CHANGED |
| Data-access joinedTableCount | 2 | 2 | ✅ CONFIRMED |
| Documentation minDescriptionLength | 10 | 2 | ⚠️ CHANGED |

### Changes Required

These defaults should be updated in `src/config/defaults.ts`:

- **DRY minLineThreshold**: `minLineThreshold: 15` → `3`
- **DRY similarityThreshold**: `similarityThreshold: 0.85` → `0.5`
- **React maxComponentComplexity**: `maxComponentComplexity: 15` → `5`
- **React wrapperMinUsages**: `wrapperMinUsages: 4` → `2`
- **SOLID maxMethodComplexity**: `maxMethodComplexity: 50` → `10`
- **SOLID maxImportsPerFile**: `maxImportsPerFile: 20` → `5`
- **SOLID classMethodsThreshold**: `classMethodsThreshold: 15` → `5`
- **SOLID classAggregateComplexity**: `classAggregateComplexity: 100` → `80`
- **Schema maxQueriesPerFunction**: `maxQueriesPerFunction: 5` → `1`
- **Documentation minDescriptionLength**: `minDescriptionLength: 10` → `2`

## Per-Parameter Curves

### DRY minLineThreshold

- **Analyzer:** `dry`
- **Config key:** `minLineThreshold`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 15
- **Recommended:** 3 ⚠️ CHANGED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 3 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 **← chosen** |
| 5 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 8 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 10 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 12 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 15 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 20 | 1.0000 | 0.0000 | 0.0000 | 0 | 0 | 1 |
| 30 | 1.0000 | 0.0000 | 0.0000 | 0 | 0 | 1 |

### DRY similarityThreshold

- **Analyzer:** `dry`
- **Config key:** `similarityThreshold`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 0.85
- **Recommended:** 0.5 ⚠️ CHANGED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 0.5 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 **← chosen** |
| 0.6 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 0.7 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 0.75 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 0.8 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 0.85 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 0.9 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 0.95 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |

### React maxComponentComplexity

- **Analyzer:** `react`
- **Config key:** `maxComponentComplexity`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 15
- **Recommended:** 5 ⚠️ CHANGED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 5 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 **← chosen** |
| 8 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 10 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 12 | 1.0000 | 0.0000 | 0.0000 | 0 | 0 | 1 |
| 15 | 1.0000 | 0.0000 | 0.0000 | 0 | 0 | 1 |
| 20 | 1.0000 | 0.0000 | 0.0000 | 0 | 0 | 1 |
| 25 | 1.0000 | 0.0000 | 0.0000 | 0 | 0 | 1 |
| 30 | 1.0000 | 0.0000 | 0.0000 | 0 | 0 | 1 |

### React wrapperMinUsages

- **Analyzer:** `react`
- **Config key:** `wrapperMinUsages`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 4
- **Recommended:** 2 ⚠️ CHANGED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 2 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 **← chosen** |
| 3 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 4 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 5 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 6 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 8 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 10 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 15 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |

### SOLID maxMethodComplexity

- **Analyzer:** `solid`
- **Config key:** `maxMethodComplexity`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 50
- **Recommended:** 10 ⚠️ CHANGED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 5 | 0.3333 | 1.0000 | 0.5000 | 1 | 2 | 0 |
| 10 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 **← chosen** |
| 15 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 20 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 30 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 50 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 75 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 100 | 0.0000 | 0.0000 | 0.0000 | 0 | 1 | 1 |

### SOLID maxLinesPerMethod

- **Analyzer:** `solid`
- **Config key:** `maxLinesPerMethod`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 50
- **Recommended:** 50 ✅ CONFIRMED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 10 | 0.3333 | 1.0000 | 0.5000 | 1 | 2 | 0 |
| 20 | 0.3333 | 1.0000 | 0.5000 | 1 | 2 | 0 |
| 30 | 0.3333 | 1.0000 | 0.5000 | 1 | 2 | 0 |
| 50 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 **← chosen** |
| 75 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 100 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 150 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |

### SOLID maxParametersPerMethod

- **Analyzer:** `solid`
- **Config key:** `maxParametersPerMethod`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 4
- **Recommended:** 4 ✅ CONFIRMED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 2 | 0.3333 | 1.0000 | 0.5000 | 1 | 2 | 0 |
| 3 | 0.3333 | 1.0000 | 0.5000 | 1 | 2 | 0 |
| 4 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 **← chosen** |
| 5 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 6 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 8 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 10 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |

### SOLID maxImportsPerFile

- **Analyzer:** `solid`
- **Config key:** `maxImportsPerFile`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 20
- **Recommended:** 5 ⚠️ CHANGED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 5 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 **← chosen** |
| 10 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 15 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 20 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 25 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 30 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 40 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 50 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |

### SOLID classMethodsThreshold

- **Analyzer:** `solid`
- **Config key:** `classMethodsThreshold`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 15
- **Recommended:** 5 ⚠️ CHANGED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 5 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 **← chosen** |
| 8 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 10 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 12 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 15 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 20 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 30 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |

### SOLID classAggregateComplexity

- **Analyzer:** `solid`
- **Config key:** `classAggregateComplexity`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 100
- **Recommended:** 80 ⚠️ CHANGED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 20 | 0.3333 | 1.0000 | 0.5000 | 1 | 2 | 0 |
| 40 | 0.3333 | 1.0000 | 0.5000 | 1 | 2 | 0 |
| 60 | 0.3333 | 1.0000 | 0.5000 | 1 | 2 | 0 |
| 80 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 **← chosen** |
| 100 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 150 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 200 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |
| 300 | 0.5000 | 1.0000 | 0.6667 | 1 | 1 | 0 |

### Schema maxQueriesPerFunction

- **Analyzer:** `schema`
- **Config key:** `maxQueriesPerFunction`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 5
- **Recommended:** 1 ⚠️ CHANGED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 1 | 1.0000 | 1.0000 | 1.0000 | 3 | 0 | 0 **← chosen** |
| 2 | 1.0000 | 1.0000 | 1.0000 | 3 | 0 | 0 |
| 3 | 1.0000 | 1.0000 | 1.0000 | 3 | 0 | 0 |
| 4 | 1.0000 | 1.0000 | 1.0000 | 3 | 0 | 0 |
| 5 | 1.0000 | 1.0000 | 1.0000 | 3 | 0 | 0 |
| 7 | 1.0000 | 1.0000 | 1.0000 | 3 | 0 | 0 |
| 10 | 1.0000 | 1.0000 | 1.0000 | 3 | 0 | 0 |
| 15 | 1.0000 | 1.0000 | 1.0000 | 3 | 0 | 0 |

### Data-access joinedTableCount

- **Analyzer:** `data-access`
- **Config key:** `joinedTableCount`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 2
- **Recommended:** 2 ✅ CONFIRMED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 2 | 1.0000 | 1.0000 | 1.0000 | 9 | 0 | 0 **← chosen** |
| 3 | 1.0000 | 1.0000 | 1.0000 | 9 | 0 | 0 |
| 4 | 1.0000 | 1.0000 | 1.0000 | 9 | 0 | 0 |
| 5 | 1.0000 | 1.0000 | 1.0000 | 9 | 0 | 0 |
| 6 | 1.0000 | 1.0000 | 1.0000 | 9 | 0 | 0 |
| 8 | 1.0000 | 1.0000 | 1.0000 | 9 | 0 | 0 |
| 10 | 1.0000 | 1.0000 | 1.0000 | 9 | 0 | 0 |

### Documentation minDescriptionLength

- **Analyzer:** `documentation`
- **Config key:** `minDescriptionLength`
- **Selection:** precision-first (highest precision; ties broken by highest recall)
- **Current default:** 10
- **Recommended:** 2 ⚠️ CHANGED

| Value | Precision | Recall | F1 | TP | FP | FN |
|-------|-----------|--------|----|----|----|----|
| 2 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 **← chosen** |
| 5 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 10 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 15 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 20 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 30 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |
| 50 | 1.0000 | 1.0000 | 1.0000 | 1 | 0 | 0 |

## Notes

- The bench corpus is intentionally minimal (1-9 fixtures per analyzer). For parameters where the minimal corpus cannot discriminate between threshold values (e.g., all values produce identical metrics on a single fixture), the precision-first selection picks the most permissive value. Real-corpus triage (Spec 11 R4) validates these recommendations against external repositories.
- Style analyzer parameters (Spec 10) have no corpus and were skipped. They will be calibrated when the analyzer is implemented.
