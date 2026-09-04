# Item 7 — verify:close script

**Gate**: `verify:close` exits 0.

## Script added to package.json

```json
"verify:close": "npm run test && npm run verify:dist"
```

This runs the full test suite (vitest run — all 480 tests including hash assertions, registry test, oracle sweep) followed by the distribution verification script.

## Evidence

```
npm run verify:close
```

Output:
```
> code-auditor-mcp@3.1.1 verify:close
> npm run test && npm run verify:dist

> vitest run
 Test Files  34 passed (34)
      Tests  480 passed (480)

> bash scripts/verify-dist.sh
PASS: code-audit changed runs end-to-end
PASS: web-tree-sitter loads
PASS: All WASM grammars present in dist/grammars/
========================================
  All distribution checks PASSED
========================================
```

Exit code: **0**.

## Coverage

`verify:close` covers:
- **Full test suite** (480 tests): Includes baseline tests, oracle sweep, triage hash, registry tests, cross-surface fingerprint identity, exemptPatterns, invariants, SARIF validation, CLI integration, benchmarks, all analyzer tests
- **Distribution verification** (`verify:dist`): CLI round-trip, WASM loading, grammar file presence
