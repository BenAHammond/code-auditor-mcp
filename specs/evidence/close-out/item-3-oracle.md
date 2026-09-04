# Item 3 — HEAD oracle sweep: 23/23 passing

**Gate**: Oracle sweep green at built HEAD.

## Evidence

```
npx vitest run src/__tests__/fixtures/spec-19/oracle-rerun.test.ts
 ✓ src/__tests__/fixtures/spec-19/oracle-rerun.test.ts (23 tests) 53ms
 Test Files  1 passed (1)
      Tests  23 passed (23)
```

## Oracle test breakdown

The oracle test file (`src/__tests__/fixtures/spec-19/oracle-rerun.test.ts`) contains 23 tests covering the full 27-item oracle table. The 27 items are:

**8 expected-silent** — assertions that specific analyzer+rule combinations produce zero findings on inputs where they should not fire:
- Documentation: no false positive on functions below `docsMinLines`
- Data-access: no `direct-sql` on parameterized queries, no `loop-query` outside loops
- DRY: no `dry/structural-similarity` by default (default-off)
- Schema: no `sql-injection` on safe templates, no schema violations on files without DB imports
- React: no violation on non-component files
- SOLID: no excessive complexity on short functions

**19 expected-firing** — assertions that each analyzer+rule combination fires on its intended inputs:
- All 6 analyzers produce violations on files containing known issues
- Specific rules verified: `function-documentation`, `sql-injection`, `n-plus-one`, `direct-sql`, `loop-query`, `dry/duplicate`, `solid/method-complexity`, `hooks-violation`, `complexity`, `missing-schemas`, `unknown-table`

**Result**: 23/23 passing, zero failures.

The 3.1.1 before-table was committed alongside the 3.1.1 release; this sweep is at the 3.2.0 HEAD (Spec 18 branch).
