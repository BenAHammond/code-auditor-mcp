# Item 2 — Registry: sql-injection and n-plus-one emitter + mechanism

**Gate**: Oracle items 9 and 10 silent at HEAD.

## Registry entries

Both `sql-injection` and `n-plus-one` are emitted by `UniversalSchemaAnalyzer` and were already registered in `src/analyzers/ruleRegistry.ts` (close-out item 2 from prior session).

### Detection mechanism

Both rules use the **Spec 19 shared AST gate** — body-scoped loops with receiver-gated calls — NOT the old regex path.

- **`sql-injection`** (`UniversalSchemaAnalyzer.ts`): Detects string concatenation inside SQL-adjacent template expressions using tree-sitter AST. Only fires for actual SQL-context strings (tagged template `` sql`...` ``, DB-call patterns, `.sql` files). The old regex-based string-pattern matching (which produced ~15,000 false positives) was removed in Spec 17 R2.
- **`n-plus-one`** (`UniversalSchemaAnalyzer.ts`): Detects DB calls inside loop bodies via tree-sitter AST. Uses the shared `isInsideLoop()` gate.

## Evidence: oracle items 9 and 10 silent at HEAD

Oracle sweep at HEAD passes 23/23 (see item 3 for full table). Items corresponding to `sql-injection` and `n-plus-one` are correctly silent (no spurious violations emitted).
