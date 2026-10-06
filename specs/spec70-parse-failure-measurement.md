# Spec 70 R1 — parse-failure and detection loss (post-normalization)

Measured with `scripts/measure-sql-parse-failure.ts` and
`scripts/measure-sql-detection-loss.ts` against the six corpora, using each corpus's
named `Dialect` (recall-protocol/endless-guessing/blitz = `sqlite`, hhra-org =
`postgresql`, knex = all three, primer-css = none). The population is the same the
regex→AST conversion is handed: the first string/template argument of a query-shaped
call (member/selector callee), plus every `.sql` migration file.

This is the measurement **after** the declared input normalization landed in
`sqlAst.ts`:

- `?1`/`?n` → `?` (D1 numbered positional parameters, quote-aware)
- multi-statement strings split on top-level `;` and parsed statement-by-statement
- standalone transaction control (`BEGIN [TRANSACTION]`, `COMMIT`, `ROLLBACK`, `END`)
  recognized as SQL with no facts
- `.sql` files carrying a `{{…}}` template placeholder classified "not SQL until
  rendered", separate from genuine parse failures

Every residual failure is a `cannot-fire`, never a `clean` — there is no regex
fallback.

## Per-corpus table (post-normalization)

| corpus | dialect | code literals (cand→fail) | code fail % (was) | .sql files (unparseable / templated) |
| --- | --- | --- | --- | --- |
| recall-protocol | sqlite | 531 → 60 | **11.3%** (32.2%) | 206 (17 / 0) |
| hhra-org | postgresql | 16 → 2 | **12.5%** (12.5%) | 116 (29 / 34) |
| endless-guessing | sqlite | 63 → 6 | 9.5% (9.5%) | 3 (0 / 0) |
| blitz | sqlite | 0 | — | 12 (1 / 0) |
| knex | sqlite | 798 → 400 | 50.1% (53.4%) | 0 |
| knex | postgresql | 798 → 308 | 38.6% (42.7%) | 0 |
| knex | mysql | 798 → 523 | 65.5% (66.8%) | 0 |
| primer-css | none | 0 | — | 0 |

The one number that moved: **recall-protocol 32.2% → 11.3%** (171 → 60 failing
literals). The 111 recovered literals were the `?1`/`?n` positional-parameter sites
(the standard D1 form) plus the multi-statement and transaction-control strings. The
other corpora are unchanged because their failures are not in those classes.

## Dequoting-fix delta (`stripSqlQuotes`)

A later fix — `stripSqlQuotes` (provenance.ts / UniversalDataAccessAnalyzer.ts) no
longer hands the raw source slice to node-sql-parser, it un-escapes the inner JS/TS
escapes first — moves only the **knex** rows above, because knex is the one corpus
whose SQL literals carry escape sequences. The `(was)` value in each knex row is the
pre-dequoting number this delta replaces.

| corpus | dialect | recovered | fail % before → after |
| --- | --- | --- | --- |
| knex | sqlite | 26 | 53.4% → 50.1% |
| knex | postgresql | 33 | 42.7% → 38.6% |
| knex | mysql | 10 | 66.8% → 65.5% |

Every recovered literal is in knex **test fixtures** (`test/unit/schema-builder/*.js`,
`test/integration2/schema/*.spec.js`) — not `lib/` production code, where knex builds
SQL dynamically with no static literal. The escapes are the two schema-DDL shapes:
`\"` (a double-quoted identifier inside a double-quoted JS string, e.g.
`"create view \"adults\" …"`) and `\'` (an embedded single quote in a column comment,
e.g. `comment 'The table\'s first column'`). Before the fix the raw `\…` reached the
parser and the statement failed; after un-escaping it parses as the identifier/string
the author wrote. No oracle-gate aggregate moved: `verify:oracle-shortfalls` pins
*candidate/extractor* facts (AST-projected, no SQL parse) and `ddl-declarations`
(parses `.sql` files, not code literals), none of which the dequoting fix touches.

## Residual failure causes, by corpus

**recall-protocol (60 code literals):** (a) `INSERT … ON CONFLICT(…) DO UPDATE`
upserts — the dominant residual, node-sql-parser's `sqlite` grammar has no
`ON CONFLICT`; (b) `datetime('now', ?)` — a bare `?` as a scalar-function argument,
a residual grammar gap the `?n`→`?` rewrite does not cover; (c) `PRAGMA
table_info(…)`; (d) a node-sql-parser strictness ("column count doesn't match value
count") on one wide multi-row INSERT. `.sql` (17): `PRAGMA foreign_keys`,
`DROP INDEX/TRIGGER/VIEW IF EXISTS` — SQLite-specific statement forms.

**hhera-org (2 code literals):** a `jsonb_set(…)` UPDATE and a `::type` cast UPDATE —
genuine Postgres dialect features node-sql-parser does not cover. `.sql` (29
unparseable + 34 templated): the 34 are `{{VERSION}}`/`{{YEAR}}` templated
migrations ("not SQL until rendered"); the 29 are `DO $$…$$` dollar-quoting,
PL/pgSQL function bodies, `::` casts, `ON CONFLICT`, `ARRAY[…]` literals.

**knex (426/341/533):** the library's own cross-dialect test fixtures — prose that
matches a bare SQL verb, bare fragments, `SELECT 1 as 1`, `PRAGMA`, `DROP SCHEMA`,
`serial` under sqlite, PL/SQL `BEGIN…END;`. Not production SQL; the knex acceptance
case lives in step 7 (438 unproven / 328 `.raw`).

## Detection loss (post-normalization)

The number that decides the go/no-go: of the sites still unparseable after
normalization, how many currently produce a finding. Findings that survive on a
handle/shape/text signal (`loop-query`, `duplicate-string-literal`) are counted but
are **not** lost by conversion — only the SQL-content-dependent rules are.

| corpus | unparseable sites | sites with ≥1 finding | findings by rule |
| --- | --- | --- | --- |
| recall-protocol | 60 | 6 | 3 written-never-read, 2 loop-query, 1 duplicate-string-literal |
| hhra-org | 2 | 2 | 2 missing-org-filter (critical) |
| knex (sqlite) | 426 | 14 | 14 duplicate-string-literal — **all in `test/` fixture paths → 0 production** |

**SQL-content-dependent loss (the real cost of conversion):**

- `written-never-read` — 3 findings (recall-protocol `INSERT … ON CONFLICT` sites):
  the write-verb read cannot see past `ON CONFLICT`, so those 3 go `cannot-fire`.
- `missing-org-filter` — 2 findings (hhera `jsonb_set`/`::` UPDATE sites): the
  tenant-predicate read cannot parse the Postgres cast/`jsonb_set`, so those 2 go
  `cannot-fire`.

**Not lost** (survive on non-SQL signals): `loop-query` (2), `duplicate-string-literal`
(1 + knex's 14) — these fire on handle identity, loop position, or string content,
which conversion does not touch.

**Net:** 5 findings across two production corpora would be lost, all on genuine
dialect gaps (`ON CONFLICT`, Postgres `jsonb_set`/`::`) that must honestly
`cannot-fire`. Detection loss after normalization is near zero — the conversion is
clear to proceed. The residual abstentions are recorded as a known limitation with
site counts, not as a blanked conversion.

## Detection-live re-run (step 4)

The table above passes each corpus its *named* dialect explicitly. The real
pipeline does not: it runs `detectDialect(projectRoot)` from the dependency
manifest (R4 / step 2), with explicit `databaseType` config as the only override.
Neither hhra-org nor recall-protocol carries a `.codeauditor.json`, so the real
pipeline has no override and is detection-only. Re-running the detection step live:

| corpus | detected dialect | matches doc? |
| --- | --- | --- |
| recall-protocol | `sqlite` (wrangler D1 binding) | ✓ |
| hhra-org | **null — ambiguous** (`pg`, `pg-pool`, `@neondatabase/serverless`, `postgres` vs `mysql2`) | ✗ (doc assumed `postgresql`) |
| endless-guessing | `sqlite` (`better-sqlite3`) | ✓ |
| blitz | **null — no driver in manifest** | ✗ (doc assumed `sqlite`) |
| knex | **null — ambiguous** (`better-sqlite3`/`sqlite3` vs `mariadb`/`mysql`/`mysql2` vs `pg`) | ✗ (doc ran all three) |
| primer-css | none | ✓ |

Three of six corpora resolve to a null dialect, and only one of them (blitz, 0 code
literals) loses nothing. The material discrepancy is **hhera-org**: `mysql2@^3.11.3`
is a runtime `dependencies` entry sitting alongside the Postgres drivers, so the
manifest genuinely names two dialects and detection must abstain — this is honest
`cannot-fire`, not a guess. The consequence is larger than the "2 findings" above,
which counts only findings on *unparseable* sites under an assumed postgresql:
under detection hhra-org never reaches the parser at all, so **every** hhra-org
SQL-content finding (parseable or not) goes `cannot-fire ("dialect undetermined
(ambiguous drivers)")`. The 2 `missing-org-filter` sites above are a subset.

**Disposition (not resolved here):** hhra-org is the one corpus where detection
loss is real and user-facing. The fix is a one-line explicit config — a
`databaseType: "postgresql"` in hhra-org's `.codeauditor.json` (or removing the
stale `mysql2` dependency if it is legacy) — which restores the full SQL-content
surface. This is Ben's call: the corpus is read-only reference, and adding config
there is a product decision, not a code-auditor change. `blitz` (no driver) and
`knex` (deliberately cross-dialect) are correct abstentions with zero production
findings lost.
