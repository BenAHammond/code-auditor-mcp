# Spec 69 R5 criterion 10 — receiver-resolution overlap (the §10 deletion-cost instrument)

Criterion 10 (§10 of the producer contract) requires receiver identification to
be **declaration-based, not name-based**. The §10 implementation order is:
build the cross-file in-repo declaration resolution **first**, then **measure
the overlap** before the `DB_RECEIVER_NAMES` name list can be deleted, so the
deletion cost is known rather than guessed. This note is that measurement. It
supersedes the receiver-level cost table in
`spec69-r3-criterion10-name-fallbacks.md` ("What deleting the name list costs"),
which counted every word-boundary occurrence of a list name (including JSON,
comments, and `this.db`) and predates the resolution existing at all.

## What is being measured

A **name-list receiver** is a `(file, name)` pair where `name ∈
{db, database, sql, stmt}` and `name` is a **bare identifier** that is the
direct object of a `member_expression` (`db.prepare(…)`, `db.user.findMany(…)`).
`this.db.query(…)` is deliberately *not* a receiver: its object is the member
expression `this.db`, not a bare `db`, and it fires via the name-independent
`this.<method>` path rather than the name list. This definition matches the
name list's actual load-bearing effect across both consumers — the schema file
gate (`schema/discovery.ts:335`) and the data-access analyzer's call detection —
and excludes the JSON/comment/`this.db` noise that inflated the earlier count.

For each receiver, the structural cross-file resolution
(`scripts/measure-receiver-resolution.ts` → `resolveReceiverProvenance`) says one
of three things, independent of the name list:

1. **recovered** — resolution marks the identifier DB-provenanced (package
   import / `DB_HANDLE_TYPES` annotation / propagation / wrapper / cross-file).
2. **not-a-DB-handle** — the identifier's declaration is a non-DB literal value.
3. **nothing (cannot-fire)** — resolution cannot resolve it: a runtime binding
   like `env.DB`, a `./db` whose target is absent, an unannotated parameter.

## The three numbers × 6 corpora

| corpus | receivers | recovered | not-a-handle | cannot-fire |
|---|---|---|---|---|
| recall-protocol | 323 | 134 | 5 | **184** |
| hhra-org | 18 | 9 | 0 | **9** |
| knex | 38 | 0 | 3 | **35** |
| primer-css | 0 | 0 | 0 | 0 |
| blitz | 60 | 6 | 0 | **54** |
| endless-guessing | 3 | 1 | 0 | **2** |
| **total** | **442** | **150** | **8** | **284** |

## What the resolution recovers (the 150)

The recovered receivers are exactly the ones whose *repo declaration is
annotated with a `DB_HANDLE_TYPES` member or traceable to a package import*:

- **recall-protocol — 134.** The dominant pattern `db: D1Database` (a function
  parameter) is recovered by the parameter-type-annotation propagation added to
  `propagateProvenance` (Rule 8b). Before that rule, recovery was 1; adding it
  moved 133 receivers from cannot-fire to recovered. This is the directive's
  anchoring working as specified: a `D1Database` annotation is a declaration, not
  a name guess.
- **hhra-org — 9.** The `queue-worker`/`processing-service` `Database` wrapper
  class (wrapping `@neondatabase/serverless`) resolves through the class-wrapper
  + cross-file-import layers (`processing-service.ts`'s `db: Database` parameter).
- **blitz — 6.** Direct `@prisma/client` re-export paths.
- **endless-guessing — 1.** A direct D1 handle.

## What stays cannot-fire (the 284), by cause

The cannot-fire residual is not one defect class; it is three, and each is a
**documented `cannot-fire` reason**, not a silent `clean`:

1. **Runtime bindings** — recall-protocol's Cloudflare D1. `env.DB`,
   `this.env.DB`, `(env as CfEnv).DB`, and the `getDb(Astro.locals)`
   / `getDbBinding()` / `makeRestD1(…)` accessors are runtime injections with no
   in-repo declaration to annotate. This is the largest single block (~149 of
   recall-protocol's `db` receivers, plus the `sql`/`stmt` prepared-statement
   aliases). The `DB_BINDING_NAMES` list (which *stays*) still matches the bare
   `env.DB` form; what goes cannot-fire is the **local alias** `const db =
   env.DB`.

2. **Unannotated callback/parameter aliases** — hhra-org's
   `fetchWithDrizzle(async (db) => …)` (the callback parameter type is inferred,
   not declared locally) and `const db = appDb.getDb()`. A deeper resolution that
   traces the callback's formal parameter type or `getDb()`'s return type would
   recover these; the declared-handle-type resolution does not, and reports
   cannot-fire honestly.

3. **Library internals** — knex's own `lib/…` and `test/…` sources use `sql`/
   `db`/`stmt` as query-compiler/client references. knex *is* the DB library; its
   internals are not name-list-deletable receivers in the app-code sense, and
   they resolve to nothing.

## What this means for the deletion (the cost)

Deleting `DB_RECEIVER_NAMES` without the resolution would have collapsed
raw-SQL/ORM receiver detection to zero on recall-protocol and blitz. **With** the
resolution, 150 of 442 receivers are recovered by declaration, and **284 become
`cannot-fire`**. The deletion is therefore safe **only if** the cannot-fire
accounting is implemented in the same change: the coverage channel must show the
cannot-fire count rising by the same amount the finding count moves down, per
corpus. §10's "no silent regression" guard — "what must not happen is a receiver
going unseen and the rule reporting `clean`" — is exactly the 284 receivers
above; none of them may become `clean`.

## Status

- **Resolution built (S1).** `src/analyzers/receiverResolution.ts` (cross-file
  fixed-point), `detectDbWrapperClasses` + `DB_HANDLE_TYPES` (including `Knex`,
  grep-distinguishable from `DB_RECEIVER_NAMES`), and the parameter-type-annotation
  propagation rule (Rule 8b) in `src/analyzers/provenance.ts`.
- **Overlap measured (S2).** The table above is the deletion-cost instrument the
  directive required to exist before the list comes out.
- **Deletion landed (S3).** `DB_RECEIVER_NAMES` and its fallback machinery were
  deleted with the cannot-fire accounting in the same change, so none of the 284
  resolution-unrecoverable receivers goes silently `clean`. The 32 tests that
  broke on deletion were fixed by real `DB_HANDLE_TYPES` annotations (Rule 8/8b),
  not a resolver special case; full suite green. See
  `spec69-r3-criterion10-name-fallbacks.md` (now "met") for the post-deletion
  grep proof.
- **Fixtures given declaring files (S4).** The ~20 fixtures importing a DB handle
  from a nonexistent `./db` now use a real declaring file / `D1Database`
  annotation. §10 is met; the remaining step is the final R5 re-measure (F1).
- **Final re-measure (F1) exposed an instrument blind spot.** The receiver-level
  table above counted only *bare* receivers (`db` as a direct object) and
  deliberately excluded `this.db`, on the assumption that `this.db.query(…)`
  fires via a name-independent `this.<method>` path. That assumption was wrong:
  the deleted name-list fallback also proved `this.db` by name (`db`), so the
  deletion dropped hhra-org's five `queue-worker/src/queue-worker.ts`
  `this.db.query(…)` IDOR surfaces **silently** (68 → 63), because `this.db =
  new Database()` is a `new <wrapper-class>()` construction the resolution does
  not trace, and the `cannot-fire` diagnostic only covers *unresolved* imports
  (`./db` resolves). This is the S5 construction gap — see
  `spec69-r5-hhra-redisposition.md` §"F1 — post-§10 re-measure". The instrument
  must be widened to include member-expression receivers before the deletion cost
  is treated as fully measured.

## S5e re-measure (after the binding-rule completion, before the member-expression widening)

Re-running `scripts/measure-receiver-resolution.ts` on the same six corpora after
S5b/S5c/S5e (import + param + class-field + `new X()` binding rule, wrapper-class
resolution, and the Go processor — none of which affect the *bare*-receiver
denominator) shows the receiver-level before/after:

| corpus | recovered (S2 → now) | cannot-fire (S2 → now) |
|---|---|---|
| recall-protocol | 134 → **143** (+9) | 184 → **175** (−9) |
| hhra-org | 9 → **15** (+6) | 9 → **3** (−6) |
| knex | 0 → 0 | 35 → 35 |
| primer-css | 0 → 0 | 0 → 0 |
| blitz | 6 → 6 | 54 → 54 |
| endless-guessing | 1 → 1 | 2 → 2 |
| **total** | 150 → **165** (+15) | 284 → **269** (−15) |

The +15 recovered (and the matching −15 cannot-fire) is the S5b/S5c binding-rule
completion, not a denominator change: the bare-receiver count is unchanged at 442.
`recall-protocol`'s +9 is the `db: D1Database` parameter-annotation propagation
(Rule 8b) finishing its recovery; `hhra-org`'s +6 is the `Database` wrapper class
(`@neondatabase/serverless`) resolving through the completed binding rule. The
residual 269 cannot-fire receivers are the three documented causes above, unchanged
in kind — none became `clean`.

This receiver-level re-measure is the `before/after` reconciliation for the
*deletion-cost instrument*. It is distinct from the S5e **diagnostic-level**
over-fire count (`1527 → ~9`), which counts emitted `cannot-fire` coverage entries
across the whole audit rather than unique `(file, name)` receiver pairs; the two
are reported separately (S5e).

## S5d re-measure — member-expression receivers (corrected denominator)

The S2 instrument (`scripts/measure-receiver-resolution.ts`) counted only the
*bare* receiver shape (`db.query`), and the F1 note flagged that it missed
`this.db.query` — a member expression whose object is `this.db`, not a bare
`db`. S5d widens the instrument to also collect `this.<field>` / `super.<field>`
receivers whose field is a name-list member, then re-runs the six corpora.

Corrected denominator (**450**, up from 442):

| corpus | bare | this.\<field\> | total | recovered | not-a-handle | cannot-fire |
|---|---|---|---|---|---|---|
| recall-protocol | 323 | 2 | 325 | 143 | 5 | 177 |
| hhra-org | 18 | 5 | 23 | 20 | 0 | 3 |
| knex | 38 | 1 | 39 | 0 | 3 | 36 |
| primer-css | 0 | 0 | 0 | 0 | 0 | 0 |
| blitz | 60 | 0 | 60 | 6 | 0 | 54 |
| endless-guessing | 3 | 0 | 3 | 1 | 0 | 2 |
| **total** | **442** | **8** | **450** | **170** | **8** | **272** |

The 8 `this.<field>` receivers are: recall-protocol 2 (`this.db`, `this.sql`,
both cannot-fire — Cloudflare runtime bindings), hhra-org 5 (`this.db` 3,
`this.sql` 2), knex 1 (`this.sql` in `lib/raw.js`, cannot-fire). **hhra-org's 5
are all recovered** — the F1 note's "dropped silently (68 → 63)" concern is
closed by the S5b form-4 binding rule (`this.db = new Database()` / class-field
type annotation), which the resolution now traces. The F1 instrument was written
before S5b landed.

The "8 receivers in neither bucket" (150 + 284 = 434 vs 442) are the S2
`not-a-DB-handle` receivers — neither recovered nor cannot-fire, so they resolve
to `clean`. All eight are legitimately non-DB values, named here:

- **recall-protocol (5 × `sql`)** — `const sql = \`INSERT INTO …\`` template
  strings in `scripts/run-knowledge-downstream.ts`,
  `scripts/run-knowledge-keystone.ts`, `scripts/sync-meta.ts`,
  `src/ops/run-knowledge-downstream.ts`, `src/ops/run-knowledge-keystone.ts`.
  `sql` is a query *string* passed to a wrangler CLI `--command`, not a handle.
- **knex (3 × `sql`)** — `const sql = {}` in
  `lib/dialects/oracle/query/oracle-querycompiler.js` and
  `lib/dialects/oracledb/query/oracledb-querycompiler.js`, and `const sql = []`
  in `lib/dialects/sqlite3/schema/ddl.js` — plain object/array accumulators, not
  clients.

None is a DB handle misclassified as clean; `not-a-DB-handle` is correct for all
eight, so the cannot-fire residual (272) is the honest "resolution cannot prove
this" surface and nothing has gone silently `clean`.

## B2 — the schema bench fixture is a mock, not a resolution gap

`npm run bench` is red on exactly one line: `schema  DRIFT (declared 2):
missing  src/unknown-table.ts|unknown-table|critical (declared 2, produced 0)`.
This is *not* a pre-existing drift and *not* a dead rule. The rule fires on a
real handle (pinned by `spec68-schema-slice.spec.ts` via the `sql\`…\`` tag +
DDL path, and `spec68-schema-parity.spec.ts`). The bench fixture's `db` is a
bare mock — `const db = { exec: async (_sql) => {} }` in
`bench/corpus/schema/src/{unknown-table,known-tables,aliased-queries}.ts`. Under
§10 a DB receiver must be declaration-provenanced; the mock has no provenanced
identifier, so `passesFileGate` (mode `hybrid`, `dbProvenanced` empty, no
`sql\`…\`` tag) rejects all three files and `schema-usage` extracts nothing.
Same shape as the data-access fixture S4 fixed (`fake-db.ts` → `getDB():
D1Database`): the fixture models a mock, and the resolver correctly refuses to
learn mocks. Fix = give the schema corpus a real declaring `./db` (or `sql\`…\``
tag) like S4. The `nearMissFiles` assertions (`known-tables`, `no-sql-signal`,
`aliased-queries`) are currently *vacuous* — they pass because the gate fails,
not because the alias/known-table filter works.

## rows.map() mirror — answered

The "mirror" of the name-list defect is the method-name direction: `Array.map()`,
`path.join()`, `page.locator()`, `params.set()` all clear the candidacy filter but
resolve to `not-handle`, so they are `clean`. `rows.map(r => …)` (a query result
mapped in memory) is the same case: `map` is not a DB/ORM candidacy method, so the
call is never examined as a query, and `rows` (bound to a `.all()`/`.findMany()`
result array, not to a handle) is not a DB receiver. No special case is required;
the loop-query half of the same shape is pinned separately in
`loopQueryShapes.spec.ts` ("query is the subject of .map").
