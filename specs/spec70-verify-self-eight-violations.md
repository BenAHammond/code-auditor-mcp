# Spec 70 — Report 1: the eight `verify:self` violations and their fixes

`verify:self` is the self-audit gate (Spec 68 §13.1): run the shipped product
against its own `src/`, block on every `critical`/`severe`/`high` finding in
scope, no per-rule exemption growth. The gate surfaced **8 scoped blocking
violations** in the uncommitted Spec 68/69/70 tree, split 5 + 3 by rule. This is
the record of what each was, what fixed it, and the fresh-run result.

## The five `loop-query` violations — real N+1 patterns, exposed by a broadened receiver

The `loop-queries` producer's receiver resolution broadened this release to
treat the code index's own SQLite handles (`rawDb.prepare`, `IndexHandle.query`)
as DB receivers. That is correct — the code index *is* a SQLite database — and it
exposed five genuine query-in-loop patterns in the tool's own source, each a real
N+1 (one query per item in a collection). None was a false positive; each was
fixed by batching the query out of the loop, not by suppressing the rule.

| site | shape (before) | fix |
| --- | --- | --- |
| `src/auditRunner.ts:364` | `for (const fn of changedFunctions) { rawDb.prepare('SELECT id FROM functions WHERE name=? AND file_path=?').get(...) }` | chunked batch — `BATCH = 900`, one `OR`-clause (`(name = ? AND file_path = ?)` per row) query per chunk, `ORDER BY id` + first-wins reproduces the old `.get` semantics |
| `src/cli.ts:2487` | `for (const e of top) { rawDb.prepare('SELECT id FROM functions …').all(...) }` (DOT output) | single top-N query — `orClause = top.map(() => '(name = ? AND file_path = ?)').join(' OR ')`, `.all(...params)` once |
| `src/invariants/ruleEngine.ts:433` (`checkStyleMechanism`) | per-file `indexHandle.query(...)` inside the `files` loop | path filter up front, `chunkedInClause('file_path', matchingFiles)` — one query over the matching files |
| `src/invariants/ruleEngine.ts:486` (`checkNoRawValues`) | same per-file query loop | same path-filter-up-front fix |
| `src/invariants/ruleEngine.ts:506` (`checkNoRawValues`) | `for (const row of rows) { indexHandle.query(...) }` — a nested per-row query | `token_ref` selected in the *same* query so the "has a token ref" test is a `Set` membership check, not a per-row query |

All five are behaviour-preserving refactors: the query results are identical, the
query is issued once (or once per 900-row chunk) instead of once per item.

## The three `table-naming-convention` violations — false positives, a rule precision defect

`table-naming-convention` fired three times on `SqliteCollectionAdapter`
(`src/codeIndex/sqliteCollection.ts`), which interpolates its instance field into
every statement it issues:

- `find()` — `FROM "${this.tableName}"` (line 60)
- `remove()` — `DELETE FROM "${this.tableName}"` (line 174, reported **twice** —
  a duplicate fact in the `schema-usage` producer, not the rule)

`parseSqlTables` reads the double-quoted `"${this.tableName}"` as a literal
identifier, so the fact's `tableName` is the substitution text `"${this.tableName}"`,
and the rule flagged it as non-snake_case. The name is a host-language value
filled at query-composition time, not a schema literal — naming conformance is a
property of the schema, not the substitution.

**Fix in the rule**, not the site: `src/phase/rules/schema.ts` now skips any
`tableName` containing `${`, the same carve-out rationale as the `query-builder`
origin skip. The producer still reports the substitution accurately.

This is the precision case recorded in
`specs/rule-authenticity-ledger.md:166` ("Precision case (Spec 68,
`table-naming-convention`)"), with the three sites named there.

## Fresh-run result

After the fixes, a fresh `npm run build && npm run verify:self` reports **0**
`loop-query` and **0** `table-naming-convention` in scope. The eight findings
Task 1 was scoped to clear are gone by rule, not by exemption: `SCOPED_EXEMPTIONS`
remains empty, and no rule body was taught to ignore a site.

## Honest residual — a *different* eight is now on the board (Item 4's surface)

A fresh run on the *current* working tree does **not** read zero: it reads **8**,
and they are not the eight above.

| rule | sites |
| --- | --- |
| `unknown-table` (3) | `src/codeIndex/sqliteCollection.ts:60, 174, 174` |
| `stale-table-reference` (2) | `src/codeIndex/migrations.ts:83, 539` |
| `parameter-documentation` (2) | `src/auditRunner.ts:1040` (duplicate fact) |
| `return-documentation` (1) | `src/auditRunner.ts:1040` |

These are the in-progress Item 4 (double-parse collapse) surface, not a regression
in the Task 1 fixes:

- `sqliteCollection.ts` — the `${}` skip moved the finding from
  `table-naming-convention` (now skipped) to `unknown-table` (which still reads the
  substitution as an unknown literal table). The same root substitution now surfaces
  one rule down; the `unknown-table` rule needs the same `${}` carve-out.
- `migrations.ts:83/539` — the DDL-extractor dialect fallback (Task 2, oracle
  shortfalls) exposed `stale-table-reference` findings at those lines.
- `auditRunner.ts:1040` — the newly exported `persistDryPairs` (Item 2 gap) lacks
  `@param`/`@returns` JSDoc.

None of these eight is a Task 1 finding left unfixed; they are the residual the
Item 4/5 pass must clear before `verify:close` is green. They are tracked as such,
not re-recorded as a bare count.
