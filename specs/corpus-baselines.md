# Corpus baselines — post-rework (Spec 49 acceptance #10)

Re-pinned after the 33-rule crude sweep (Sessions 1–27) and the after-33 pass
(Sessions 28–30). Each row is `analyzer::rule → count`, full per-rule
attribution so any future delta can be attributed to a named cause.

Measured read-only with `scripts/measure-corpus-counts.ts`
(`CODE_AUDITOR_DATA_DIR=/tmp/ca-baseline-<name> npx tsx scripts/measure-corpus-counts.ts <corpus>`),
which runs the same `runAuditDispatch` path the CLI uses and writes nothing into
the target project.

**Corpora measured**: recall-protocol, hhra-org, knex, primer-css, blitz.
**Corpora not on disk** (could not be re-measured): gin, svelte-realworld.

Timestamp: 2026-09-07.

Re-verified 2026-09-08 against the current build. All five corpora reproduce
exactly except two transcription errors in the original pin, corrected above:
knex `solid::function-length` was recorded 60 but measures 59 (total 404, not
405); primer-css was missing a `styles::styles/token-bypass` finding of 1 (total
125, not 124). Both were verified by re-measuring the pin commit itself
(`81efaeb`) — the recorded numbers never matched that tree, so these are ledger
errors, not analysis changes.

Re-pinned 2026-09-10 after Spec 52 (findings from a real D1/Workers project
audit). Three defect fixes moved four rules on recall-protocol, two on knex,
and one on hhra-org; every delta is attributed and no genuine N+1 was lost:

- `data-access::loop-query` 301 → 290 (recall-protocol). **−11** — the
  accumulate-then-batch shape (`stmts.push(db.prepare(sql).bind(x))` consumed by
  one `.batch()` after the loop) is no longer flagged as N+1. Genuine N+1s — an
  eager call (`.run()`/`.all()`/`.exec()`) in a loop, *including* a
  `db.prepare(sql).bind(x).run()` chain — still fire (pinned by
  `item-06-chained-prepare-run-in-loop.ts`).
- `schema-code::too-many-queries` 95 → 84 (recall-protocol). **−11** — the net
  of two changes. (a) `.prepare()` SQL is statement construction, not execution,
  so it is no longer counted as a query — this removes pure statement factories
  (`stmts.push(db.prepare(sql))` with no eager call). (b) Eager execution
  methods (`.run()`/`.all()`/`.first()`/`.raw()`/`.batch()`, including the typed
  D1 forms `.all<T>()`/`.first<T>()`) are counted as queries, so a genuine
  `db.prepare(sql).bind(x).all<Row>()` chain still fires. The remaining −11 are
  accumulate-then-batch builders with no eager execution.
- `cross-domain::cross-domain/read-never-written` 21 → 14 (recall-protocol).
  **−7** — a table written via an upsert form is no longer misread as
  "read but never written".
- `cross-domain::cross-domain/written-never-read` 8 → 10 (recall-protocol).
  **+2** — the four upsert forms (`INSERT OR IGNORE`/`OR REPLACE INTO`,
  `REPLACE INTO`, `INSERT … ON CONFLICT … DO UPDATE`) are now classified as
  writes, so two more written-never-read tables surface.
- `schema-code::too-many-queries` 181 → 196 (knex). **+15** — `REPLACE INTO` is
  now counted as a query (+2, the INSERT pattern previously missed it), and
  eager methods `.raw()`/`.run()`/`.all()`/`.first()` (knex's raw-SQL injection
  and better-sqlite3 statement execution) are counted as queries (+13).
- `schema-code::too-many-queries` 17 → 22 (hhra-org). **+5** — the typed eager
  forms `.all<T>()`/`.first<T>()` in hhra's data layer are now counted.

`cross-domain::cross-domain/multi-table-write` and `schema::unknown-table` are
unchanged on every corpus; primer-css and blitz show zero delta on all seven
rules. `cross-domain::cross-domain/no-validator-reachable` is notApplicable in
all five corpora (no validator wiring), so it never contributes.

Edge-case follow-up (same Spec 52 pass): `countQueries` no longer double-counts
the `DO UPDATE` / `KEY UPDATE` clause of an upsert (`INSERT … ON CONFLICT … DO
UPDATE`, `INSERT … ON DUPLICATE KEY UPDATE`) as a second query — the clause is
part of the one INSERT statement. This moved exactly one rule on one corpus:

- `schema-code::too-many-queries` 196 → 193 (knex). **−3** — knex's MySQL
  `ON DUPLICATE KEY UPDATE` raw-SQL test strings (14 occurrences) were counted
  as INSERT + UPDATE; now counted once.

No other corpus moved (recall-protocol 84, hhra-org 22 unchanged).

Re-pinned 2026-09-11 after the `solid/dependency-inversion` escapes-vs-held fix
(an external audit found it firing on a thrown error value, not a held
collaborator). Only that rule moved, on two corpora:

- `solid::solid/dependency-inversion` 20 → 12 (knex). **−8** — the dialect
  adapters and `Client` construct collaborators in factory/accessor methods that
  *return* them (`return new QueryBuilder(this)`, `return new Migrator(this)`,
  `return new Transaction(...)`) — escaped values, not held dependencies.
- `solid::solid/dependency-inversion` 12 → 11 (blitz). **−1** — a `return new
  Response(...)` value in the RPC server.

recall-protocol (3), hhra-org (8), and primer-css (0) are unchanged — the rule
still fires on genuine held collaborators everywhere it fired before, so this is
a false-positive narrowing, not a weakening to zero. gin and svelte-realworld
remain off-disk and unmeasurable.

The escape check also walks through transparent wrappers (`parenthesized_expression`,
`as_expression`, `type_assertion`, `satisfies_expression`, `non_null_expression`),
so `return new Foo() as Bar` and `throw (new AppError())` are cleared too; none
of the five corpora used that form in a class, so the counts above are unchanged
by it. Survivors sampled and confirmed field-held (not escaped): `GuildAgent`
(`this.#migrations = new SQLSchemaMigrations(...)`), `StrategistManager`
(`this.reconnect = new ReconnectController(...)`), `OrgTrackerDatabase`
(`this.pool = new Pool(...)`), `Client` (`this.logger = new Logger(...)` /
`this.pool = new KnexPool(...)` — still fires despite its many `return new X()`
factory accessors), `Generator` (`this.enquirer = new Enquirer()`).

---

## recall-protocol — 4,324 advisory findings (4,268 files)

| analyzer::rule | count |
| --- | --- |
| solid::function-length | 902 |
| styles::styles/off-scale | 735 |
| documentation::function-documentation | 574 |
| styles::styles/token-bypass | 456 |
| data-access::loop-query | 290 |
| dependency-graph::unreferenced-module | 124 |
| react::raw-element | 111 |
| dependency-graph::orphaned-nodes | 104 |
| react::no-error-boundary | 103 |
| react::performance | 95 |
| schema-code::too-many-queries | 84 |
| solid::parameter-count | 89 |
| documentation::method-documentation | 80 |
| data-access::complex-query | 67 |
| react::complexity | 66 |
| conventions::conventions/usage-pair | 60 |
| styles::styles/mechanism-fragmentation | 52 |
| conventions::conventions/error-handling | 51 |
| styles::styles/undefined-class | 47 |
| solid::solid/method-complexity | 33 |
| data-access::unfiltered-query | 32 |
| cross-domain::cross-domain/read-never-written | 14 |
| dry::dry/similar-expression | 21 |
| styles::styles/declaration-set-similarity | 21 |
| documentation::class-documentation | 16 |
| react::accessibility | 13 |
| conventions::conventions/naming | 10 |
| cross-domain::cross-domain/multi-table-write | 10 |
| schema::unknown-table | 10 |
| styles::styles/mechanism-mixing | 9 |
| cross-domain::cross-domain/written-never-read | 10 |
| styles::styles/z-index-singleton | 7 |
| dry::dry/duplicate | 6 |
| conventions::conventions/import-form | 5 |
| data-access::sql-injection-risk | 4 |
| solid::solid/dependency-inversion | 3 |
| solid::solid/class-size | 3 |
| solid::interface-size | 2 |
| conventions::conventions/export-shape | 1 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::hub-nodes | 1 |
| styles::styles/z-index-sprawl | 1 |

## hhra-org — 1,218 advisory findings (760 files)

| analyzer::rule | count |
| --- | --- |
| solid::function-length | 381 |
| styles::styles/undefined-class | 346 |
| react::no-error-boundary | 79 |
| documentation::method-documentation | 69 |
| dependency-graph::unreferenced-module | 60 |
| react::performance | 57 |
| documentation::function-documentation | 51 |
| documentation::class-documentation | 39 |
| react::complexity | 36 |
| data-access::loop-query | 18 |
| dependency-graph::orphaned-nodes | 17 |
| schema-code::too-many-queries | 22 |
| solid::solid/dependency-inversion | 8 |
| solid::solid/method-complexity | 7 |
| conventions::conventions/naming | 6 |
| conventions::conventions/usage-pair | 5 |
| dry::dry/similar-expression | 5 |
| cross-domain::cross-domain/written-never-read | 2 |
| solid::parameter-count | 2 |
| cross-domain::cross-domain/read-never-written | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::hub-nodes | 1 |
| react::accessibility | 1 |
| schema::invalid-json | 1 |
| schema-code::dynamic-sql-construction | 1 |
| solid::solid/class-size | 1 |

## knex — 408 advisory findings (474 files)

| analyzer::rule | count |
| --- | --- |
| schema-code::too-many-queries | 193 |
| solid::function-length | 59 |
| solid::solid/class-size | 31 |
| solid::solid/dependency-inversion | 12 |
| dependency-graph::orphaned-nodes | 17 |
| schema::unknown-table | 17 |
| data-access::hardcoded-connection | 16 |
| data-access::unfiltered-query | 15 |
| solid::solid/open-closed | 12 |
| solid::interface-size | 8 |
| data-access::loop-query | 6 |
| solid::parameter-count | 6 |
| data-access::sql-injection-risk | 5 |
| cross-domain::cross-domain/read-never-written | 4 |
| cross-domain::cross-domain/written-never-read | 1 |
| dependency-graph::hub-nodes | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::tight-coupling | 1 |
| dry::dry/similar-expression | 1 |
| schema-code::table-naming-convention | 1 |
| secrets::hardcoded-secret | 1 |

## primer-css — 125 advisory findings (137 files)

| analyzer::rule | count |
| --- | --- |
| styles::styles/off-scale | 101 |
| styles::styles/z-index-singleton | 11 |
| dependency-graph::orphaned-nodes | 5 |
| solid::function-length | 3 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::unreferenced-module | 1 |
| documentation::function-documentation | 1 |
| styles::styles/token-bypass | 1 |
| styles::styles/z-index-sprawl | 1 |

## blitz — 917 advisory findings (788 files)

| analyzer::rule | count |
| --- | --- |
| documentation::function-documentation | 191 |
| documentation::method-documentation | 161 |
| styles::styles/declaration-set-similarity | 161 |
| solid::function-length | 88 |
| react::raw-element | 54 |
| styles::styles/off-scale | 50 |
| dependency-graph::orphaned-nodes | 47 |
| documentation::class-documentation | 34 |
| data-access::unfiltered-query | 30 |
| react::no-error-boundary | 16 |
| styles::styles/token-bypass | 16 |
| styles::styles/undefined-class | 15 |
| solid::solid/dependency-inversion | 11 |
| react::performance | 9 |
| solid::parameter-count | 9 |
| schema::unknown-table | 4 |
| schema-code::reserved-word | 4 |
| react::complexity | 3 |
| secrets::hardcoded-secret | 3 |
| conventions::conventions/naming | 2 |
| data-access::loop-query | 2 |
| solid::solid/open-closed | 2 |
| conventions::conventions/export-shape | 1 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::hub-nodes | 1 |
| solid::solid/method-complexity | 1 |
