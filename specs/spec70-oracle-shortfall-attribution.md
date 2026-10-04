# Spec 70 — oracle-shortfall drift: attribution

The `verify:oracle-shortfalls` gate failed on a stale baseline (recorded at
`f100097`, Spec 69 R2). Before re-recording, every drift line is attributed to a
named change. The governing rule: **a moved number is attributed to the
producer/oracle change that moved it, or it is an open defect, not a re-record.**

## Headline

The drift is **five fact-kinds, 42 drift lines, all on the SQL / data-access
surface**. The other **14 fact-kinds are byte-stable** (batch-functions,
code-block, cross-language-entities, dynamic-sql, export-form, file-imports,
file-symbols, function-index, import-form, react-component, secret-candidates,
security-candidates, style-declarations, type-declarations — zero drift).

The oracle **definitions did not move** *for the C1–C5 drift*: `git log` shows
`src/phase/producers.ts` and `src/phase/phaseModel.ts` were last touched for
these kinds at Spec 69 R1/R2 (the baseline's own commits) or by `6f734e0`
(Spec 69 R4, value-drift only — unrelated to the five kinds). The C1–C5 drift is
therefore **producer-side**, not oracle-side: the per-file oracle (`expected`) is
fixed, and the aggregate `files`/`expected` moves because the *set of files with a
shortfall* shifted as producers emitted more or fewer facts. The one oracle-side
change — C6, the `countDdlOps` non-rename exclusion — is a **later** tightening
(not part of the original C1–C5 drift) and is attributed in the
`ddl-declarations` section.

## The named changes (attribution lexicon)

| id | change | what it moved |
| --- | --- | --- |
| **C1** | Spec 70 R1 — `detectDialect` threaded into the phase model (`sqlDialect` on the runner/producer) | a corpus with **null/ambiguous** dialect gates the SQL-*parse*-dependent producers (`schema-usage`, `ddl-declarations`) to `cannot-fire` empty sets instead of the pre-Spec-70 regex-extracted facts |
| **C2** | Spec 70 R2/R13 — regex→AST conversion (`parseSqlTables`, the DDL regex, the query-site keyword scan → `parseSql` / `ddl*` AST walk) | a SQL string that fails to parse under the named dialect is `cannot-fire`, not regex-extracted — so `actual` drops by exactly the parse-failure population |
| **C3** | Spec 70 R3/R4 — `handleVerdictForCall` via manifest-package import + parsed SQL argument; `isDbCallNode` now requires a proven `handle` (the type-annotation / `unproven`-admitting arm is deleted) | `data-access-calls` `actual` **up** (more calls recognized as DB via the manifest + parsed-SQL handle); `loop-queries` / `query-sites` `actual` **down** (a call that no longer proves a handle is no longer a DB call in a loop / query site) |
| **C4** | Spec 69 R5 (`0bee64a`) — hhra-org re-disposition | part of the `data-access-calls` / `query-sites` movement on hhra-org, committed after the R2 baseline |
| **C5** | `7fbf0fe` — loop-query iterator-subject fix (in `UniversalDataAccessAnalyzer.ts`, the shared `extractLoopQueries` the phase producer calls) | `loop-queries` candidate extraction narrowed (a query in a `.map` *subject* is no longer in-loop) |
| **C6** | Spec 70 — `countDdlOps` non-rename exclusion (the `RENAME TO` guard in `DDL_HEADER_RE`) | `ddl-declarations` `expected` **down** — an `ALTER TABLE … ADD/DROP/ALTER COLUMN` / `ADD CONSTRAINT` header is a column/constraint change, not an op, so the oracle no longer counts it; files whose *only* DDL was non-rename `ALTER` drop out of the shortfall set. **Oracle-side**, unlike C1–C5 |

C1/C2/C3/C5/C6 are this release's own changes; C4 predates this session but
postdates the baseline commit.

**Why the handle-admission producers move *up* even under a null dialect.** The
C1 blank-out reaches only the producers that *parse* SQL — `schema-usage` and
`ddl-declarations` — because `parseSql` needs a named dialect and abstains
without one. The handle-admission producers (`data-access-calls`, `query-sites`,
`loop-queries`) do **not** blank out: `identifyHandle` proves a handle three ways,
and only one of them (R3, the parsed-SQL argument) is dialect-gated. The other
two — R4's manifest-package lookup (a receiver traced to `pg`/`mysql2`/… via the
dependency manifest) and the provenance/type-annotation fallback — are
**dialect-independent**. So on a null-dialect corpus the R3 arm abstains but R4
still fires, and the R4 arm *adds* handles the old type-annotation-only baseline
never saw. That is why `data-access-calls` actual rises on *every* corpus
(including blitz — no driver — and hhra-org — ambiguous) while `schema-usage`
and `ddl-declarations` fall to zero on the same corpora.

## The drift, per fact-kind per corpus

### `schema-usage` — C1 + C2

| corpus | recorded | current | direction | cause |
| --- | --- | --- | --- | --- |
| hhra-org | actual 13 | actual 0 | down to zero | C1 — `detectDialect` = **null (ambiguous** pg vs mysql2**)**; the whole SQL-content surface is `cannot-fire` |
| openstatus | actual 8 | actual 0 | down to zero | C1 — null dialect |
| recall-protocol | files 1502 / exp 164402 / act 1909 | files 1398 / exp 147136 / act 1303 | down | C2 — `parseSqlTables` (regex) → `parseSql`; the sqlite parse-failure population now `cannot-fire` instead of regex-extracting |

The hhra/openstatus zero is the same "dialect undetermined" disposition recorded
in `spec70-parse-failure-measurement.md` §3 — honest `cannot-fire`, Ben's product
call on a read-only corpus.

### `ddl-declarations` — C1 + C2 + C6

| corpus | recorded | current | direction | cause |
| --- | --- | --- | --- | --- |
| hhra-org | files 10 / exp 219 / act 91 | files 27 / exp 201 / act 0 | act → 0, set expands | C1 — null dialect ⇒ producer emits 0 DDL ops ⇒ every DDL file shortfalls; `exp` re-derived vs C6 |
| blitz | *absent* | files 12 / exp 40 / act 0 | newly shortfalling | C1 — null dialect (no driver) ⇒ 0 ops over the 12 `.sql` files; its DDL carries no non-rename `ALTER`, so C6 leaves `exp` at 40 |
| openstatus | files 46 / exp 136 / act 17 | files 42 / exp 97 / act 0 | act → 0 | C1 — null dialect; `exp` re-derived vs C6 |
| recall-protocol | files 88 / exp 376 / act 59 | files 6 / exp 29 / act 17 | down | C2 (sqlite parse of `PRAGMA`/`DROP INDEX|TRIGGER|VIEW`/`VACUUM` now `cannot-fire`) + C6 (`exp` 394→29) + the still-uncommitted `ddlMigrationOps` tightening (`act` 39→17) |

**Re-derived against the current `countDdlOps` (C6).** The `current` column was
first written against the pre-fix oracle, which counted every `ALTER TABLE`
header — including `ADD/DROP/ALTER COLUMN` and `ADD CONSTRAINT` — as a DDL op.
That is a column/constraint change, not an op, so the oracle was tightened to the
`RENAME TO` guard. Re-deriving `expected` drops hhra-org 315→201, openstatus
216→97, recall-protocol 394→29 (blitz 40→40), and the `files` set shrinks by
exactly the files whose only DDL was non-rename `ALTER`. recall-protocol's
`actual` also moved 39→17 via the still-uncommitted `ddlMigrationOps` tightening
— a *producer* move, distinct from the oracle re-derivation — leaving a residual
of 12 parse-rejected statements across 6 files. These post-C6 numbers are the
ones recorded in `bench/baselines/oracle-shortfalls.json`.

### `data-access-calls` — C3 + C4

| corpus | recorded | current | direction | cause |
| --- | --- | --- | --- | --- |
| blitz | act 119 | act 360 | up | C3 — tri-state `identifyHandle` + query-builder-shape discovery admits more Prisma/ORM calls than the type-annotation-only baseline |
| hhra-org | act 334 | act 1406 | up | C3 + C4 — R4 manifest resolves `pg`/`mysql2` handles (dialect-independent, fires despite the ambiguous corpus dialect) |
| openstatus | files 1980 / exp 75573 / act 2187 | files 1978 / exp 75570 / act 3681 | up | C3 (the ±2 file/expected is shortfall-set boundary) |
| recall-protocol | files 1416 / exp 95724 / act 1848 | files 1310 / exp 84229 / act 3423 | up | C3 — more calls proven; the `files`/`expected` drop is the shortfall set shrinking as more calls are recognized |

### `query-sites` — C1 + C2 + C3 + C4

| corpus | recorded | current | direction | cause |
| --- | --- | --- | --- | --- |
| blitz | act 10 | act 6 | down | C2/C3 — stricter recognition |
| hhra-org | files 453 / exp 11624 / act 540 | files 457 / exp 11632 / act 857 | up | C4 + C3 — R4 manifest admits more files as DB-context (hhra's pg/mysql2 are manifest packages) |
| openstatus | files 1550 / exp 38355 / act 1097 | files 1553 / exp 38360 / act 940 | down | C2/C3 |
| recall-protocol | files 1347 / exp 58555 / act 2316 | files 1243 / exp 51295 / act 1885 | down | C2/C3 — parse-failure + handle requirement |

### `loop-queries` — C3 + C5

| corpus | recorded | current | direction | cause |
| --- | --- | --- | --- | --- |
| blitz | files 31 / exp 65 / act 0 | files 33 / exp 67 / act 0 | set +2 | C3 — two files' calls lost their (type-annotation) DB handle, so their loops now shortfall |
| hhra-org | act 5 | act 4 | down | C3 — `isDbCallNode` requires `handle` |
| openstatus | files 234 / exp 508 / act 11 | files 249 / exp 523 / act 0 | act → 0 | C3 — openstatus's DB calls no longer prove a handle |
| recall-protocol | files 641 / exp 2665 / act 176 | files 549 / exp 2207 / act 91 | down | C3 + C5 |

## Honest residual

There is **no unattributable drift.** Every drift line maps to C1–C6. The two
numbers that look like "oracle moved" — the `files`/`expected` columns — are
**shortfall-set membership shifts**: the per-file oracle is fixed, and a
producer that emits more (C3 `data-access-calls`) drops files *out* of the
shortfall set while a producer that emits less (C1 `ddl-declarations`/`schema-usage`)
pulls files *in*. The gate pins the aggregate of a step function, so a producer
move shows up in all three columns, not just `actual`.

The one thing this attribution does **not** settle is whether the new numbers are
the *correct* new numbers — that is the composition notes' job, re-authored in the
same change as the re-record (§ below).

## Consequence for the re-record

The baseline is stale **only** because the producers legitimately moved (C1–C5)
— with one oracle-side exception: C6 (`countDdlOps` non-rename exclusion) is an
oracle change, and it is the reason `ddl-declarations` `expected` was re-derived
downward in that section. C6 is not a drift *correction* against a stale baseline;
it is a genuine tightening of the oracle's unit of count (one op per
CREATE/DROP/ALTER-*RENAME* TABLE, not per `ALTER` header). Re-recording is
therefore the correct disposition —
it re-pins the aggregate to the post-Spec-70 producer behavior, and the 19
composition notes are re-authored to state the *current* producer semantics (the
dialect-gated `cannot-fire` for null-dialect corpora, the parse-failure `cannot-fire`,
and the manifest/parsed-SQL handle) rather than the pre-Spec-70 regex semantics they
still describe. Numbers and notes land in the same change.
