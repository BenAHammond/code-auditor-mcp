# Spec 70 — Test Adjudication (the four numbers + the residue)

Date: 2026-10-02. Companion to `spec-70-sql-as-a-parsed-format.md`.

Spec 70 R1.2/R3/R4 deletes the type-annotation handle heuristic
(`receiverHasTypeAnnotation` + the `unproven`-admitting arm of `isDbCallNode`).
A query-shaped call now produces `loop-query` / `sql-injection-risk` **only** when
`identifyHandle` folds to `handle`, which requires one of two proofs:

- **R3 (`sql-argument`)** — a *static* SQL argument that parses under a *named*
  dialect (`facts.sqlDialect`). Dynamic interpolation/concat → `null` static
  SQL → the source stays silent; `null` dialect → the source cannot parse.
- **R4 (`declaration-resolution`)** — the receiver's import resolves to a package
  in `database-packages.json`.

A `D1Database`-typed ambient binding (`const db: D1Database = getDb()`) is now
`unproven` (cannot-fire) on both sources: the type name is `unproven` under
`classifyTypeText` (criterion 9 deletes handle-type names), and dynamic SQL has
no parseable argument. That is the intended Spec 70 behaviour, not a regression.

---

## The four numbers

| # | Question | Answer |
|---|----------|--------|
| (a) | of 157 loop-query FPs, how many clear | **157 / 157** — fresh `audit --path src` reports **0** `loop-query` |
| (b) | of 8 sql-injection FPs, how many clear | **8 / 8** — fresh `audit --path src` reports **0** `sql-injection-risk` |
| (c) | of the 71 currently-passing pinned tests, how many still pass unmodified | **61 / 71 pass unmodified; 10 broke** (5 spec-19 r3-gating + 5 spec-52), each adjudicated and fixed — none deleted |
| (d) | the residue list | **empty** (enumerated below) |

**The "71" is a three-file set** — `spec-19/r3-sql-injection-gating.test.ts`
(9) + `spec-52.test.ts` (58) + the spec-70 scope suite (4) — the tests that were
passing before the change by pinning the deleted type-annotation signal. 61 of
them already prove the handle via R3 (`sql-argument`) or R4 (manifest package)
and pass unmodified; the 10 that broke are the 5 `r3-sql-injection-gating` cases
(bare dynamic `query(\`…\${…}\`)`) plus the 5 `spec-52` cases, all fixed per-test.
The per-test adjudication below covers the **full 58-test suite across 19 files** —
the 10 broken above plus a further 48 data-access tests in other files
(`loopQuery*.spec.ts`, `spec68-*`, `spec69-*`, `nearMiss*`, `spec-17`, `spec-33`)
that broke for the same root cause and are fixed the same way. Post-fix the full
suite is green (2503 passed / 127 skipped / 0 failed).

`verify:self` (post-rebuild) reports **0** data-access violations: the 10
`hardcoded-connection` and 7 `dynamic-sql-construction` findings that remain in
a raw `audit --path src` all land in `__tests__`/`fixtures`/`.spec.ts`/`.test.ts`
or `ruleRegistry.ts` — files `verify:self`'s `inScope` filter excludes. The
earlier "44 data-access violations" read was a **stale** `/tmp` report (the CLI
refused to overwrite it); the fresh run resolves the discrepancy.

### (d) The residue — enumerated, not a count

Residue = "type-annotated, passes no parseable SQL argument, and fires **today**."

With the heuristic deleted, no site fires on type-annotation alone: every
`D1Database`-typed receiver with dynamic SQL now reports `unproven`
(cannot-fire). The residue is therefore **empty**. Per Ben's step 5: residue
empty → **no mechanism question** — nothing replaces the type signal, and
`unproven` is the final answer for the D1 Worker env binding.

---

## Uniform root cause of the 58 failures

Every failing test is a genuine-defect "MUST fire" test (real N+1, real
injection). Its **assertion is still correct** under Spec 70; what broke is the
**fixture's handle proof**. All such fixtures are `const db: D1Database = getDb()`
(or `db: D1Database` param/field), whose SQL is either dynamic (no `sql-argument`)
or static-but-unthreaded-dialect (`sqlDialect` is `null` in `DEFAULT_DATA_ACCESS_CONFIG`).

The fix is per-fixture, exactly one of:

- **`dialect` threading** — static-SQL fixtures: pass `dialect: 'sqlite'` so R3
  proves the handle. Minimal (config only, no fixture surgery).
- **manifest import** — dynamic-SQL / ORM-builder fixtures: replace the ambient
  `D1Database` receiver with an import from a manifest package whose method
  surface matches the fixture (`better-sqlite3` for `.prepare/.exec/.get/.all/.run`,
  `knex` for `.raw/.select/.from/.where`, `pg` for `.query`).

---

## Per-test adjudication (58 tests, 19 files)

### Group A — static SQL → thread `dialect: 'sqlite'` (27 tests)

Each asserts a genuine N+1 in a loop with a **static** `prepare('… ?')` /
`query('… ?', params)` argument. Still correct; the handle is now proven by R3
once a named dialect is threaded.

1. `loopQueryAnchor.spec.ts` (2) — anchor precision on `db.prepare(…).bind(…).all<T>()` / `db.all<T>()`. Static SQL. Prove via R3.
2. `loopQueryBatchBinding.spec.ts` (4) — `run(e.id)`, `run(row.id, row.name)`, chunked re-loop, spread-over-collection. Static SQL. R3.
3. `loopQueryLlmDiscriminator.spec.ts` (4) — plain N+1 / generic-helper / per-loop dedup / two-loops. Static SQL. R3.
4. `loopQueryQueueConsumer.spec.ts` (2) — plain N+1 / unrelated-member-call. Static SQL. R3.
5. `loopQueryShapes.spec.ts` (4) — replayFanOut / Leaderboard.apply / uniqueness probe / `.forEach` callback. Static SQL. R3.
6. `spec68-loop-query-parity.spec.ts` (4) — `db.query("SELECT … WHERE id = ?", [id])`. Static SQL. R3 (via `runLoopQueriesSlice`).
7. `spec-52.test.ts` item 4 / 6 / 7 / 10 (4) — `this.sql.exec('… ? …', …)`, chained `prepare('…').bind().run()` / `.first<Row>()`, `Promise.all(map(prepare().bind().all()))`. Static SQL. R3.
8. `spec-17.test.ts` R4.1 / R4.2 / R4.1-per-item (3) — `db.query("… ?", [user])`, nested, `db.prepare('… ?').get(id)`. Static SQL. R3.

### Group B — dynamic SQL / ORM builder → manifest import (31 tests)

Each asserts a genuine injection (or ORM query-in-loop) with a **dynamic**
argument (template interpolation, `+` concat, or a builder chain with no SQL
string) on an ambient `D1Database` receiver. Still correct; the handle is now
proven by R4 once the receiver imports from a manifest package.

9. `spec-52.test.ts` item 3 (1) — `db.exec(\`… WHERE id = ${item.id}\`)`. Dynamic. → `better-sqlite3`.
10. `spec-19/oracle-rerun.test.ts` items 1 / 3 / 4 / 7 / 8 (5) — bare `query(\`…\${…}\`)` (dynamic). → manifest (see note on bare-call D1 below).
11. `spec-19/r2-db-call-gate.test.ts` (3) — `db.users.find({id})` + `db.select().from('users').where(…)` (ORM, no SQL string) and `query('SELECT … ?', id)` (static bare). Mixed: ORM → manifest; static bare → R3.
12. `spec-19/r3-sql-injection-gating.test.ts` (5) — bare `query(\`…\${…}\`)` dynamic. → manifest.
13. `spec-33/s33-item5-sql-injection.test.ts` (5) — `db.exec(\`…\${ddl}\`)`, `db.exec('DROP TABLE ' + name)`, `db.raw(…)`. Dynamic. → `better-sqlite3` (`.exec`) / `knex` (`.raw`).
14. `spec-33/s33-item6-taint-tracking.test.ts` (3) — `db.raw(\`…\${…}\`)`. Dynamic. → `knex`.
15. `spec-33/s33-item11-method-name-fp.test.ts` (1) — `db.raw(\`…\${modeArg}\`)`. Dynamic. → `knex`.
16. `nearMissExecutor.spec.ts` (1) — liveness: `sql-injection-risk` invalid sample fires through its wired runner. Dynamic. → manifest.
17. `nearMissGuards.spec.ts` (2) — FP 2 (COUNT/WHERE receiver) + FP 5 (escapeSql control). Dynamic. → manifest.
18. `spec68-data-access-calls.spec.ts` (2) — string-concatenated `db.query("…" + id)`. Dynamic. → `pg`.
19. `spec68-data-access-parity.spec.ts` (1) — `db.query("…" + id)`. Dynamic. → `pg`.
20. `spec69-r3-motivating-fixtures.spec.ts` (2) — `db.query(\`… LIKE '%${safe}%'\`)`. Dynamic. → `pg`.

### The bare-call D1 case (spec-19 items 4/7/1/3/8, r3)

D1's bare-call form `const query: D1Database = getDb(); await query<Row[]>(\`…\`)`
has no method surface on any manifest package. Under Spec 70 this is the
canonical `unproven` (Worker env binding) site. Two honest resolutions, per test:

- **Re-provenance** to a method-call manifest handle (e.g. `pg`'s `db.query(sql)`)
  when the point of the test is the *injection-detection* logic — the same
  logic fires unchanged on a method call.
- **Flip the assertion** to `cannot-fire` (0 violations) when the point is the
  *D1 binding itself* — documenting the Spec 70 detection loss, not silently
  preserving a deleted signal.

Either way the test is changed **only** with this adjudication on record.
