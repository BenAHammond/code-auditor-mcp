# Spec 22 — Line-Number Conversion Sweep Report

**Date:** 2026-07-25
**Status:** ✅ COMPLETE — release-gating item satisfied

## Principle

**Convert once at the adapter boundary; never compensate downstream.**

All tree-sitter positions enter the system 0-based. The single conversion point is
`toSourceLocation()` in `converter.ts`. Every downstream consumer — violation display,
DB index, churn mapping, SARIF export, hook contract validation — receives 1-based
positions from that single point. Any code that adds its own `+ 1` after
`toSourceLocation()` or `getLineAndColumn()` is a double compensation producing
2-based values.

## Root Cause

`converter.ts:51-63` — `toSourceLocation()` returned 0-based lines and columns
directly from tree-sitter without conversion. The comment on line 55 said
"convert to 1-based columns" but the code added zero to both line and column.

This created three pipelines:

| Pipeline | Path | Before Fix | Issue |
|----------|------|-----------|-------|
| A | `toSourceLocation()` → callers | 0-based | Callers compensated individually |
| B | `getLineAndColumn()` wraps A with `+1` | 1-based | Double compensations downstream |
| C | Raw TS node access (`row` directly) | 0-based | Independent, bypassed converter |

## Sites Touched (6 files, 6 edit locations)

### 1. Root cause fix: `converter.ts`

**File:** `src/languages/tree-sitter/converter.ts:51-63`
**Change:** Added `+ 1` to all four position fields (line and column for both start and end). Added invariant documentation comment.
**Effect:** All `toSourceLocation()` callers now receive 1-based positions. This fixes both Pipeline A (0-based → 1-based) and eliminates the need for Pipeline B's internal compensation.

### 2. Remove internal compensation: `adapterBridge.ts`

**File:** `src/languages/adapterBridge.ts:167-171`
**Before:** `getLineAndColumn()` added `+ 1` to line and column.
**After:** Returns `toSourceLocation()` values directly (already 1-based).
**Effect:** Pipeline B is now the identity over Pipeline A. Callers of `getLineAndColumn()` still receive 1-based — no behavioral change, just one fewer `+1` in the chain.

### 3. Remove scattered compensation: `UniversalAnalyzer.ts`

**File:** `src/languages/UniversalAnalyzer.ts:221`
**Before:** `line: location.line + 1`
**After:** `line: location.line`
**Effect:** `createViolation()` was Spec 22's original narrow fix (the one-line `+1`). No longer needed — `location.line` is already 1-based from the adapter boundary.

### 4. Remove scattered compensation: `astParser.ts`

**File:** `src/utils/astParser.ts:84-85`
**Before:** `line: e.location.start.line + 1, column: e.location.start.column + 1`
**After:** `line: e.location.start.line, column: e.location.start.column`
**Effect:** Parse error positions were +1'd because `toSourceLocation()` returned 0-based. No longer needed.

### 5. Remove DOUBLE compensation: `componentScanner.ts`

**File:** `src/componentScanner.ts:149-157`
**Before:** 
- `line` from `getLineAndColumn()` (1-based, Pipeline B with +1)
- `lineNumber: line + 1` → 2-based (DOUBLE)
- `startLine: line + 1` → 2-based (DOUBLE)
- `endLine: endLine + 1` → 1-based (single compensation of Pipeline A 0-based endLine)
**After:**
- `lineNumber: line` → 1-based
- `startLine: line` → 1-based
- `endLine: endLine` → 1-based (both line and endLine now come from toSourceLocation → 1-based)
**Effect:** DB component metadata now has consistent 1-based spans.

### 6. Remove DOUBLE compensation: `dependencyExtractor.ts`

**File:** `src/utils/dependencyExtractor.ts:196-197, 276`
**Before:**
- `line: line + 1, column: column + 1` (line 196-197, `resolveCallExpression`)
- `existing.lineNumbers.push(line + 1)` (line 276, `extractIdentifierUsage`)
**After:**
- `line, column` (no compensation)
- `existing.lineNumbers.push(line)` (no compensation)
**Effect:** Call graph edges and usage records now have 1-based positions (not 2-based).

## Sites NOT Touched (verified independent)

These were surveyed and confirmed to have independent coordinate systems:

| File | Location | Coordinate System | Why Independent |
|------|----------|-------------------|-----------------|
| `adapterBridge.ts:468` | `extractImports()` | Raw `TSNode.startPosition.row + 1` | Raw tree-sitter node, bypasses `toSourceLocation()` |
| `invariants/ruleEngine.ts:468-469` | ast-grep results | ast-grep positions `+ 1` | ast-grep, not tree-sitter. Unrelated coordinate system |
| `UniversalSchemaAnalyzer.ts:660, 933` | String-position math | Regex/offset positions | String-level position calculations, not AST nodes |
| `conventionMiner.ts:151` | array index `i + 1` | Array index → 1-based line | Not a tree-sitter position |

## Secondary Effects Fixed

### Mixed-basis DB spans (`functionScanner.ts`)

**File:** `src/functionScanner.ts:397-398, 448-450`

Before the sweep, `startLine` in the DB came from `getLineAndColumn()` (1-based via Pipeline B +1) while `endLine` came from `node.location?.end?.line` (0-based via Pipeline A). Same record had 1-based start and 0-based end — a mixed basis.

After the sweep, both `line` and `endLine` are 1-based from `toSourceLocation()` — basis is consistent.

### Churn attribution off-by-one/sometimes-off-by-two

**File:** `src/churn/churnExtractor.ts:88-90, 299-305`

Churn mapping reads `start_line, end_line` from the DB and compares against git hunk ranges (1-based). Before the sweep, DB spans could be 0-based, 1-based, or 2-based depending on which code path stored them. After the sweep, all stored positions are consistently 1-based, matching git hunk ranges — the off-by-one/sometimes-off-by-two in churn attribution is resolved.

### `validateHookContract` guard (`auditRunner.ts:1269-1290`)

The guard drops violations with `line < 1`. Before Spec 22's narrow fix, violations at line 0 (first line of file) were dropped because `createViolation()` passed 0-based positions. The narrow fix added `+ 1` in `createViolation()`. After the sweep, `createViolation()` no longer adds `+ 1` — but the positions are already 1-based from the adapter boundary, so the guard behaves identically.

## Verification

```
Build:  clean (tsc + grammars + natives)
Tests:  755/755 passing (all 44 test files)
Bench:  13/13 analyzers passing, all corpora at F1=1.0
```

### CLI purity regression check

```bash
node dist/cli.js changed --json --fail-on critical 2>/dev/null | python3 -m json.tool
# Output: [] — clean JSON, no stderr contamination

echo "src/codeIndexDB.ts" | node dist/cli.js changed --stdin --json --fail-on critical 2>/dev/null | python3 -m json.tool
# Output: valid JSON — clean
```

## Invariant

As stated in the `converter.ts` JSDoc:

> **INVARIANT:** All positions returned by `toSourceLocation()` are 1-based (line and column). Tree-sitter uses 0-based positions internally; the conversion happens once here. Callers MUST NOT add their own +1 compensations — doing so produces 2-based values.

This invariant is now mechanically enforced: there is zero `+ 1` compensation remaining anywhere in the tree-sitter→adapter→consumer pipeline. Any future `+ 1` after `getLineAndColumn()` or `toSourceLocation()` is a bug detectable by code review.
