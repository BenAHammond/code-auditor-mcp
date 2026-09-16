# Corpus baselines — post-rework (Spec 49 acceptance #10)

Re-pinned after the 33-rule crude sweep (Sessions 1–27) and the after-33 pass
(Sessions 28–30). Each row is `analyzer::rule → count`, full per-rule
attribution so any future delta can be attributed to a named cause.

Measured read-only with `scripts/measure-corpus-counts.ts`
(`CODE_AUDITOR_DATA_DIR=/tmp/ca-baseline-<name> npx tsx scripts/measure-corpus-counts.ts <corpus>`),
which runs the same `runAuditDispatch` path the CLI uses and writes nothing into
the target project.

**Corpora measured**: recall-protocol, hhra-org, knex, primer-css, blitz, endless-guessing.
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

Re-pinned 2026-09-11 after Spec 55 R1 (orphaned-nodes call-graph resolver). The
resolver's reference set was rebuilt: it was a flat global bare-name table built
from `metadata.callees` (only named `call_expression` callees — so anonymous
arrow functions, JSX tags, and bare function values were invisible). It is now a
scope-aware index (same file → same directory → unique global) built from
whole-file `fileReferences`, which walks every call site, JSX tag, and bare
identifier-in-`arguments`/`array` in the file. A name defined and called in one
file can no longer be orphaned, because its own file's reference set contains it.
Only `dependency-graph::orphaned-nodes` moved; every other rule reproduced
exactly on all five corpora (the total finding delta equals the orphan delta on
each):

- `dependency-graph::orphaned-nodes` 104 → 24 (recall-protocol). **−80** — React
  JSX components, top-level `main()` entry points, callbacks passed to
  `.map()`/array literals, and object-literal methods, all resolved by the
  whole-file walk. Sampled and confirmed: no genuine dead code lost.
- `dependency-graph::orphaned-nodes` 17 → 4 (hhra-org). **−13** — same causes.
- `dependency-graph::orphaned-nodes` 17 → 7 (knex). **−10** — same causes.
- `dependency-graph::orphaned-nodes` 5 → 0 (primer-css). **−5** — same causes.
- `dependency-graph::orphaned-nodes` 47 → 44 (blitz). **−3** — blitz's orphans
  are almost all a *different* class: `export default <const>` page components
  (Next.js file-system routing, no in-code call site) and module-internal
  helper consts (`withBrand`/`branded`/`spinner`/`variable`, `seed`). Those are
  entry-point-by-convention / default-export-visibility, not "defined and called
  in one file", so R1's resolver does not (and per the spec should not) touch
  them. The remaining 44 are unchanged from the prior pin — a clean narrowing,
  not a regression.

No fourth exclusion was added; the change is a widening of what "referenced"
means, not a carve-out for any shape.

Re-pinned 2026-09-11 after Spec 55 R2 (`multi-table-write` batch recognition).
A function whose writes are accumulated into prepared statements and committed
with a single `.batch()` (Cloudflare D1 / SQLite atomic batch) is now treated as
its own transaction scope, so the multi-table shape no longer flags. Detection
re-parses the file and checks whether an enclosing function of the write line
contains `.batch(` — function-scoped, not file-scoped, so an unrelated batch in
the same file never suppresses a genuine finding. Only
`cross-domain::cross-domain/multi-table-write` moved, on recall-protocol; every
other corpus reproduced exactly:

- `cross-domain::cross-domain/multi-table-write` 10 → 7 (recall-protocol). **−3**
  — `heroes/[id]/index.ts` `PATCH`, `admin/ability/extraction.ts` `POST`, and
  `build-articles.ts` `upsertStoredBuildArticle` each commit 4 tables in one
  `db.batch([…])`; verified by reading the source. The 7 survivors write ≥4
  tables with no batch commit (eager `.run()` per statement).

(On the Spec 55 target corpus, endless-guessing, the two §1.3 findings —
`mergeClosed` and `flush` — both drop to 0 by the same rule.)

Re-pinned 2026-09-11 after Spec 55 R3 (`loop-query` / `unfiltered-query` /
`too-many-queries` test-file exclusion). The three query-shape rules are now
excluded from test files at the *rule* level — a new language-agnostic
predicate (`isTestOrSpecPath`: `*.test.*` / `*.spec.*` filenames and `test/` /
`tests/` / `__tests__/` directory segments, plus Go `*_test.go`) — not a
severity cap (that mechanism was removed in Spec 54). Security and org-filter
rules (`sql-injection-risk`, `missing-org-filter`, `hardcoded-connection`)
still fire on test files, since a hardcoded connection in a test is as real a
signal as in production. Only the three query-shape rules moved; every other
rule reproduced exactly (the total delta equals the three-rule delta on each
corpus):

- `schema-code::too-many-queries` 193 → 3 (knex). **−190** — knex's `test/`
  integration suite (244 `.js` files exercising the query builder) was
  essentially the entire rule; the three survivors are in `lib/` (real source).
- `data-access::unfiltered-query` 15 → 1 (knex), 30 → 22 (blitz), 32 → 31
  (recall-protocol). **−14 / −8 / −1** — query-without-filter in test fixtures.
- `schema-code::too-many-queries` 22 → 21 (hhra-org). **−1**.
- `data-access::loop-query` 6 → 2 (knex). **−4** — test loops that were
  correctly flagged as N+1 but live in `test/`.
- `data-access::loop-query` 290 (recall), 18 (hhra), 2 (blitz) — **unchanged**:
  those findings are on `scripts/**` (real backfill/migration scripts that run
  genuine queries in loops) and `fixtures/**`, not test files, so R3 does not
  touch them. This is the correct boundary: scripts and fixtures are not test
  files.

On the Spec 55 target corpus (endless-guessing), the nine §2 test-file findings
drop to 0 — `loop-query` ×5, `unfiltered-query` ×2, `too-many-queries` ×2. The
three §1.4 *non-test* `loop-query` findings (`replayFanOut`, `Leaderboard.apply`,
the auth uniqueness probe) are deliberately left in place — R3 scopes test files
only, and those are source files (§1.4 has no R in the spec; flagged separately).

**Removed-capping enumeration (R3's second half).** Spec 54 deleted path-profile
severity capping; `excludeFromGate` now scopes profile-matched files out of the
blocking gate, but their findings report at full severity. The reporter asked
what those findings are. On recall-protocol, the built-in `scripts-and-tests`
profile (paths `scripts/**`, `tests/**`, `test/**`, `__tests__/**`,
`fixtures/**`, `*.test.*`, `*.spec.*`) matches **486** advisory findings
(measured via `scripts/measure-profile-findings.ts`; the reporter's "672" was a
different snapshot — this tree re-measures 486). Every one is on a
`scripts/**` or `fixtures/**` file (the test-file subset is 0 after R3 — the
recall `tests/` files are vitest mocks that do not fire these rules), so the
query-shape exclusion does not change them. Per-rule:

| analyzer::rule | count |
| --- | --- |
| solid::function-length | 244 |
| data-access::loop-query | 72 |
| documentation::function-documentation | 60 |
| conventions::conventions/error-handling | 29 |
| schema-code::too-many-queries | 24 |
| solid::parameter-count | 17 |
| conventions::conventions/import-form | 5 |
| data-access::unfiltered-query | 5 |
| dependency-graph::orphaned-nodes | 5 |
| solid::solid/method-complexity | 5 |
| dry::dry/similar-expression | 4 |
| cross-domain::cross-domain/read-never-written | 3 |
| data-access::complex-query | 3 |
| conventions::conventions/usage-pair | 2 |
| data-access::sql-injection-risk | 2 |
| schema::unknown-table | 2 |
| styles::styles/undefined-class | 2 |
| cross-domain::cross-domain/written-never-read | 1 |
| dependency-graph::tight-coupling | 1 |

These are all gate-excluded (the profile sets `excludeFromGate: true`), so none
blocks; they report at full severity because a backfill script with a 244-line
function or an unfiltered query is a real, if lower-priority, signal. The three
query-shape rules are the only ones R3 excludes from the rule entirely — the
rest remain profile-scoped, which is the intent: capping is gone, and the honest
replacement for *query-shape noise in test files* is rule exclusion, not a
severity ceiling.

Re-pinned 2026-09-11 after Spec 55 R4 (`no-error-boundary` recognizes
`getDerivedStateFromError`). The rule fires on a class component that renders an
error UI but implements neither `componentDidCatch` nor the React-recommended
static form `static getDerivedStateFromError(error)`. The static getter was
missing from the detection, so a component that *does* implement
`getDerivedStateFromError` was wrongly flagged. Only `react::no-error-boundary`
moved; every other rule reproduced exactly:

- `react::no-error-boundary` 103 → 0 (recall-protocol). **−103** — all 103 were
  class components whose boundary logic is the static `getDerivedStateFromError`
  lifecycle method (the preferred render-only-fallback form) rather than
  `componentDidCatch`.
- `react::no-error-boundary` 79 → 0 (hhra-org). **−79** — same cause.
- `react::no-error-boundary` 16 → 0 (blitz). **−16** — same cause.

knex and primer-css are unchanged (0). The rule still fires on a component that
renders an error UI with neither lifecycle method — a genuine missing boundary,
not a weakening to zero (pinned by `reactErrorBoundary.spec.ts`).

Re-pinned 2026-09-11 after Spec 55 R5 (`unfiltered-query` + `complex-query`
contracts). Both rules had fired on the wrong shape; each now has an honest
predicate. `unfiltered-query` targets an unfiltered *write* — a DELETE/UPDATE
with no WHERE/HAVING/LIMIT row-limiting clause (a mass-mutation foot-gun) — not
an unfiltered read; `complex-query` targets a genuinely join-heavy query (many
tables), not a mere subquery. The two rules moved together, only on the corpora
that had either shape:

- `data-access::unfiltered-query` 31 → 68 (recall-protocol). **+37** — the
  unfiltered writes now caught outweigh the unfiltered reads no longer flagged.
- `data-access::complex-query` 67 → 1 (recall-protocol). **−66** — the 66 were
  subquery-shaped queries, no longer "complex" under the corrected contract.
- `data-access::unfiltered-query` 0 → 4 (hhra-org). **+4**.
- `data-access::unfiltered-query` 22 → 0 (blitz). **−22** — all 22 were
  unfiltered reads.
- `data-access::unfiltered-query` 1 → 1 (knex). Unchanged — the lone finding is
  an unfiltered write, which the corrected contract still flags.

primer-css is unchanged (0 on both rules). The corrected contracts are pinned by
the `data-access-rules` fixture (true positive + near-miss negative for each).

Re-pinned 2026-09-11 after Spec 55 R6 (`styles/off-scale` reads declared tokens).
The rule no longer infers a scale from hardcoded Tailwind constants; it reads the
project's *declared* scale from the style index (`style_tokens`: Tailwind theme
`spacing.*`/`fontSize.*` tokens and CSS custom-property `--space-*`/`--font-size-*`
tokens) and flags only values outside a scale the project actually declares.
Where a family declares no scale, the rule is `notApplicable`, not a guess. Only
`styles::styles/off-scale` moved:

- `styles::styles/off-scale` 735 → 984 (recall-protocol). **+249** — recall
  declares its spacing scale as CSS custom properties (`--space-*` in
  `theme.css`/`global.css`) and a Tailwind `@theme`; that declared scale is
  tighter than the hardcoded Tailwind defaults the old rule inferred, so more
  genuinely off-scale literals surface.
- `styles::styles/off-scale` 50 → 0 (blitz). **−50** — blitz's styles are
  styled-components/inline; it declares no spacing or font-size scale as tokens,
  so the rule is `notApplicable`.
- `styles::styles/off-scale` 101 → 0 (primer-css). **−101** — primer declares
  its spacing scale as Sass `$spacer-*` variables, which the style index does not
  capture (it captures CSS custom properties and a Tailwind theme only), so no
  scale is declared and the rule is `notApplicable`. This is within R6's scope —
  the rule reads what the index can see — but the Sass-variable gap is noted
  rather than papered over.

On the Spec 55 target corpus (endless-guessing), the 12 §4 off-scale findings
drop to 0 — `styles.css` declares `--radius`/`--radius-sm`/`--tap` and color
tokens but no spacing or font-size scale, so `notApplicable` is the honest
answer, not "13px is off a scale the project never declared". `styles/token-bypass`
(3 findings) is unchanged. A value genuinely outside a *declared* scale still
fires — pinned by unit tests (`is notApplicable when the project declares no
scale for the family`, `reads CSS custom-property tokens as a declared spacing
scale`).

Re-pinned 2026-09-12 after Spec 55 R5/R6 follow-up fixes (the second external
audit's acceptance pass sampled the new findings and found two over-firing
regressions in the new contracts — both real bugs, not explanations). Two guards
were restored; only `data-access::unfiltered-query` and `styles::styles/off-scale`
moved, on three corpora:

**`unfiltered-query` — the R5 re-target dropped the old rule's `tables.length > 0`
guard.** A DELETE/UPDATE-verb *method call* that extracts no string table read as
a SQL mass-write. A `this.update({…})` / `this.listeners.delete(x)` on an
in-memory class, or an ORM `db.update(schema).set(…).where(…)` whose table is a
schema object / runtime variable (not a string literal), is not a SQL mass
mutation. The old read-rule carried this guard and the write-rule must too.
Re-adding it drops 28 phantom / over-fired findings:

- `data-access::unfiltered-query` 68 → 45 (recall-protocol). **−23** — plain JS
  `update()`/`delete()` methods (`this.listeners.delete(x)` on a React state
  manager, etc.) with no SQL table at all.
- `data-access::unfiltered-query` 4 → 0 (hhra-org). **−4** — filtered Drizzle
  `.where(eq(…))` writes whose table is a schema-object reference.
- `data-access::unfiltered-query` 1 → 0 (knex). **−1** — a filtered
  `getTable(…).where('is_locked','=',0).update({…})` in `Migrator._lockMigrations`,
  whose table is a runtime variable. (This supersedes the R5 note that knex's lone
  finding was a genuine unfiltered write — it was a filtered query-builder method.)

  Honest caveat (deferred, not papered over): the guard keys on *extracted string
  tables*, so an ORM write against a schema object is invisible to the rule whether
  or not it is filtered — `hasQueryFilter` matches WHERE/HAVING/LIMIT *keywords*
  only, not an ORM `.where()`. That pre-existing gap is worth its own spec. The
  re-added guard is a false-positive narrowing, not a weakening: an unfiltered
  string-literal write (`db.exec("DELETE FROM users")`) still fires (pinned by
  `unfilteredQuery.spec.ts`).

**`styles/off-scale` — `detectOffScaleValues` flagged `px === 0` as off-scale when
the declared scale omits a zero step.** Zero is the absence of a value, not a
scale step — `margin: 0` / `padding: 0` (the universal reset) is never off-scale,
even when the project declares no `--space-0`. `TRIVIAL_VALUES` already treats
`'0'` as trivial, so two code paths disagreed about the same concept; the flag
loop now skips `px === 0`:

- `styles::styles/off-scale` 984 → 759 (recall-protocol). **−225** — the reset
  decls on every component. Of the 759 survivors, 381 are hardcoded px literals
  on Tailwind-default intermediate steps (2/6/10/14/28/36/56) that recall's sparse
  `--space-*` scale intentionally omits; the rest were off-scale before R6 too.

  Survivor-check (the 381 narrower-scale findings, the largest new block): all
  eight distinct values were read against source, one example each, and every one
  is a genuine hardcoded px literal off recall's declared scale — no false
  positives. Histogram `1×9, 2×50, 6×81, 10×117, 14×105, 28×13, 36×2, 56×4`.
  The values and properties report correctly; the only inaccuracy is line-number
  off-by-one (+1) for findings inside Astro `.astro` `<style>` blocks (e.g.
  `pricing.astro`, `DiscordCtaBand.astro`, `DuoArticleInline.astro`), where the
  reported line is one below the literal. `.css` files and inline-style cases are
  exact. This is a pre-existing line-positioning quirk in the language layer
  (positions inside embedded `.astro` `<style>` blocks report one line low), not
  R6-specific: it affects any rule reporting a position inside an embedded style
  block, not just `off-scale`. The value/property of a finding is unaffected —
  only its line anchor — so it is a line-position fix of its own, not a rule fix.

primer-css and blitz are unchanged (both rules are `notApplicable`/0 on them).

Re-pinned 2026-09-12 after Spec 56 R1 (`unfiltered-query` excludes upserts). An
upsert is keyed by construction — its conflict target / unique key scopes the row,
and an `INSERT` has no `WHERE` by definition — so "unfiltered INSERT" is not a
category. The rule's verb check read the `DO UPDATE` clause of
`INSERT … ON CONFLICT … DO UPDATE` as a mass `UPDATE`, flagging it. `isUpsertForm`
now gates the write check ahead of the verb (the four Spec 52 R2 spellings —
`INSERT OR IGNORE`, `INSERT OR REPLACE`, `REPLACE INTO`, `ON CONFLICT` — plus
MySQL's `ON DUPLICATE KEY UPDATE`). Only `data-access::unfiltered-query` moved, on
recall-protocol (the only corpus with live upserts); every other rule reproduced
exactly:

- `data-access::unfiltered-query` 45 → 6 (recall-protocol). **−39** — D1 upserts
  (`INSERT … ON CONFLICT … DO UPDATE` across `lib/`, `pages/api/`, `ops/`) were
  false positives. The 6 survivors are genuine `DELETE FROM t` with no WHERE
  (`hero-data-sync.ts` ×5: `powers`/`items`/`strategy_knowledge`/`hero_strategies`/
  `popular_builds`, and `reconciliation/fts-repair.ts` `strategies_fts`) — sampled
  and confirmed.

hhra-org (0), knex (0), blitz (0), and primer-css (0) are unchanged — none has a
live upsert on the unfiltered-query path. The rule still fires on a bare
`UPDATE t SET x = 1` / `DELETE FROM t` with no row-limiting clause (pinned by
`unfilteredQuery.spec.ts`, which now also pins the four upsert near-misses).

Re-pinned 2026-09-12 after the Spec 56 R4 `DELETE FROM` fix. The generic `FROM`
pattern in `sqlTablePatterns()` was matching `FROM users` in `DELETE FROM users`
as a *read* (a `select` ref), in addition to the `delete` ref — the same
token-without-context family as `SKIP LOCKED` read as a table and `REPLACE()`
mistaken for `REPLACE INTO`. `isDeleteFrom` now gates the `FROM` pattern so
`DELETE FROM` classifies as a write only. Two rules moved, on two corpora; every
other rule reproduced exactly:

- `cross-domain::cross-domain/written-never-read` 10 → 20 (recall-protocol).
  **+10** — tables that are only ever deleted (never SELECTed) were misread as
  "read" by the spurious `select` ref, which suppressed the finding. Ten such
  tables now fire: eight delete-only (`foundational_migration_flags`,
  `hero_knowledge_flags`, `hero_stadium_matchup`, `hero_stadium_synergy`,
  `hero_synergy`, `suggestions`, `hero_strategies_pruned`,
  `hero_technique_abilities`) and two written-and-deleted (`build_item_scores`
  update+delete, `build_read_sources` insert+delete). Sampled and confirmed: none
  of the ten has a `SELECT` anywhere, so each is a genuine write-never-read, not a
  reclassified false positive.
- `schema::unknown-table` 17 → 16 (knex). **−1** — `sqlite_sequence` in
  `lib/dialects/sqlite3/query/sqlite-querycompiler.js`
  (`delete from sqlite_sequence where name = …`) fired once for the `delete` ref
  and once for the spurious `select` ref; the second is gone.

`cross-domain::cross-domain/read-never-written` is **unchanged** on all five
corpora (recall 14, hhra 1, knex 4). A delete-only table still carries a `delete`
write row, so `read-never-written` ("read but never written") correctly does not
fire for it — the fix does not invert that rule. `schema-code::table-naming-convention`
(knex 1) and `schema-code::reserved-word` (blitz 4) are unchanged: their findings
are on `SELECT`/other contexts, not `DELETE FROM`. hhra-org, primer-css, and
blitz show zero delta (no raw `DELETE FROM` string literals / no SQL /
variable-named deletes). `multi-table-write` and `no-validator-reachable` read
the write set only, so they are unaffected.

Re-pinned 2026-09-12 after Spec 50 (size-threshold defaults recalculated, and the
project lint config made an authoritative threshold source). The size rules'
numbers were never chosen deliberately — `function-length` at 50 fired on any
function over ~one screen. Every default was raised to a defensible number with a
rationale recorded in the rule registry; the full old→new table lives in the Spec
50 plan and the CHANGELOG entry. Only the size rules moved; every other rule
reproduced exactly on all five corpora (the total finding delta equals the
size-rule delta on each). **None of the five corpora configures a size rule in
ESLint** (recall-protocol's flat config has only `no-restricted-syntax` + Node
globals; knex's `.eslintrc.js` only mocha/unused-vars; primer-css only
`languageOptions`), so the deltas below are entirely default raises — the lint
reader is validated by the fix contract, not a corpus delta. The Go size rules
fire on zero of the five corpora (no corpus contains `.go`), so their raises are
code-correctness changes validated by the Go specs, not a corpus delta.

- `solid::function-length` 902 → 95 (recall-protocol) / 381 → 32 (hhra-org) /
  59 → 9 (knex) / 3 → 0 (primer-css) / 88 → 3 (blitz). **−807 / −349 / −50 / −3 /
  −85** — the 50-line ceiling flagged ordinary handlers, React components, and
  backfill scripts; at 200 the survivors are genuine >200-line functions.
- `solid::parameter-count` 89 → 11 (recall-protocol) / 2 → 0 (hhra-org) /
  6 → 0 (knex) / 9 → 0 (blitz). **−78 / −2 / −6 / −9** — at 4 it flagged ordinary
  dependency-injected constructors and config functions; at 6 the survivors are
  genuinely >6-param signatures (an options object is warranted).
- `solid::solid/class-size` 31 → 15 (knex) / 3 → 2 (recall-protocol) / 1 → 0
  (hhra-org). **−16 / −1 / −1** — the 15-method ceiling flagged ordinary domain
  models and query builders; at 20 methods (and 150 aggregate complexity) the
  survivors are genuine god-objects.
- `solid::interface-size` 8 → 4 (knex). **−4** — at 20 members it flagged
  legitimate query-builder interfaces; at 25 the survivors (52-member
  `JoinClause`, 57-member `TableBuilder`, 191-member `QueryInterface`, 30-member
  `SchemaBuilder`) are genuinely oversized.
- `react::complexity` 66 → 29 (recall-protocol) / 36 → 6 (hhra-org) / 3 → 0
  (blitz). **−37 / −30 / −3** — at 10 it flagged ordinary components with a few
  conditionals; at 20 (ESLint's own `complexity` default) the survivors are
  genuinely intricate components.

`solid::solid/method-complexity` is unchanged (33 recall / 7 hhra / 1 blitz) —
McCC 50 was already a huge function and its survivors were genuine outliers, not
idiomatic code; the rationale documents why it is kept. `dependency-graph::tight-coupling`
(0.7) is unchanged — a density ratio, not a "size" number. recall-protocol
`interface-size` (2) and `method-complexity` (33) are unchanged.

Survivor sample (five, confirmed genuine by reading source): `executePipeline`
(12 params, `workers/discovery-drain.ts`), the build-editor `reducer` (675 lines),
knex `QueryInterface` (191 members), hhra `EtlPageClient` (1,103 lines, McCC 120),
blitz `upgradeLegacy` (1,383 lines). Each is unambiguously over the raised
threshold — no false positives.

Re-pinned 2026-09-15 after Spec 58 (two analyzer gaps on a real D1/Workers project,
endless-guessing — SQL assembled in a variable, and dynamic imports missing from
the import graph). Both fixes make the affected rules *see more*, so counts move in
both directions; a rule that stopped firing everywhere would have been broken. No
read/write-set or import-graph rule did.

**R1 — SQL assembled in a variable.** The schema table extractor
(`extractDbCallRefs`) read only a *direct* string/template-literal argument to a DB
call; a bare identifier holding SQL (`db.prepare(UPSERT_SQL)`) was silently treated
as table-free. Now the identifier resolves via the adapter's `resolveLocalConstant`
(same-module `const` bound to a string/template literal), and when it cannot resolve
(imported const, concatenated/ternary expression, call result) the query is reported
as `schema-code::unresolved-query` rather than as absence. Boundary: only
SQL-carrying methods (`exec`/`prepare`/`query`/`raw`/`execute`) resolve identifiers —
`batch`/`run`/`all`/`first` take a statements array or bound params, so a bare
identifier there is not SQL and is not reported; a direct string/template literal is
parsed for *every* method (node-sqlite3 `db.all(sql)` passes SQL as a literal).

**R2 — dynamic imports in the import graph.** `clCollectFileInfo` indexes
`import('./x')` / `require('./x')` with a static string argument as an import edge,
so a module reached only via `await import()` is live, not `unreferenced-module`. A
no-interpolation template literal (`` import(`./x`) ``) is a compile-time constant and
also resolves to an edge. A computed specifier (`import(someVar)`, an interpolated
template, or a call like `path.join(...)`) cannot resolve and is reported as
`dependency-graph::unresolved-dynamic-import` (reported, not silenced, not a confident
edge).

Deltas (every one attributed):

- recall-protocol **3157 → 3183** (+26).
  - `dependency-graph::unreferenced-module` 124 → 114 (**−10**, R2) — ten modules
    reached only via a static-string dynamic import are now counted live.
  - `schema-code::unresolved-query` 0 → 37 (**+37**, R1) — identifier-held SQL that
    cannot statically resolve (sampled: all `fn=sql` / `fn=countSql` / `fn=liveQuery`
    held in concatenated/ternary/imported expressions).
  - `cross-domain::cross-domain/written-never-read` 20 → 19 (**−1**, R1) — a table
    previously seen as written-only now has its const-bound SELECT read recognized.
- hhra-org **743 → 743** (0) — no computed dynamic imports, no identifier-held SQL.
- knex **112 → 124** (+12).
  - `dependency-graph::unresolved-dynamic-import` 0 → 11 (**+11**, R2).
  - `schema-code::unresolved-query` 0 → 1 (**+1**, R1) — `lib/execution/runner.js:241`,
    `fn=query`.
- primer-css **16 → 16** (0) — no DB access, no dynamic imports.
- blitz **721 → 736** (+15).
  - `dependency-graph::unresolved-dynamic-import` 0 → 14 (**+14**, R2).
  - `schema-code::unresolved-query` 0 → 1 (**+1**, R1).
- endless-guessing (now on disk, 87 files) → **23** (first pin). Its only
  `read-never-written` is gone (the metrics `UPSERT_SQL` const is now resolved, so the
  `metrics` table is seen as both written and read), and its only `unreferenced-module`
  is gone (`email.ts` reached via `await import('../lib/email')` now counts as live).
  The 3 `unresolved-query` are all `fn=sql` ternary/concatenated SQL
  (`routes/questions.ts:75`, `tests/e2e/harness-dev.ts:29`, `tests/e2e/helpers.ts:58`).

Survivor sample (standing contract — confirm the survivors are genuine, not a rule
gone silent): recall `written-never-read` survivors include `anon_strategist_claims`
(`INSERT OR IGNORE`, never SELECTed) and `foundational_migration_flags` (`DELETE`,
never SELECTed) — genuine written-only tables. blitz/knex `unresolved-dynamic-import`
are genuinely computed (`path.join(...)`, `process.env.KNEX_TEST`, `resolveFrom(...)`).
`read-never-written` still fires at 14 (recall) / 4 (knex) / 1 (hhra);
`written-never-read` at 19 (recall) / 1 (knex) / 2 (hhra); `unreferenced-module` at 114
(recall) / 60 (hhra) / 1 (primer).

Re-pinned 2026-09-15 after the Spec 58 follow-up (severity reclassification). The two
Spec 58 rules that reported an *unresolvable* case as a `high`-severity `Violation` —
`schema-code::unresolved-query` (SQL held in an unresolvable identifier) and
`dependency-graph::unresolved-dynamic-import` (a computed `import()`/`require()`
specifier) — are moved off the findings channel onto the coverage-diagnostics channel.
They are not defects: "the code is wrong" vs "the tool couldn't see" is the category
boundary, and every severity in the findings model is blocking, so unresolvable-but-
legitimate code (`` import(path.join(...)) ``, SQL in an imported constant) was gating
edits it could never fix. They now land in `metadata.diagnostics` as
`CoverageDiagnostic` (`unresolved-query` / `unresolved-dynamic-import`), still
**visible, counted, with file + line**, rendered in the "Coverage gaps" report section
that leads the report, and carried through `changed --json` — but never a gate. The
two rules are removed from the rule registry and the near-miss executor.

This is a 1:1 move, so each corpus's delta is exactly the removed-rule count and no
other rule moved (confirmed by re-measure; diagnostics re-counted via the measure
script's new "coverage diagnostics" section):

- recall-protocol **3183 → 3146** (−37). `schema-code::unresolved-query` 37 → a
  `unresolved-query` diagnostic (37).
- knex **124 → 112** (−12). `dependency-graph::unresolved-dynamic-import` 11 and
  `schema-code::unresolved-query` 1 → diagnostics (11 + 1).
- blitz **736 → 721** (−15). `dependency-graph::unresolved-dynamic-import` 14 and
  `schema-code::unresolved-query` 1 → diagnostics (14 + 1).
- endless-guessing **23 → 20** (−3). `schema-code::unresolved-query` 3 → a
  `unresolved-query` diagnostic (3).
- hhra-org **743 → 743** (0) and primer-css **16 → 16** (0) — neither corpus has an
  unresolvable query or computed specifier, so nothing moved.

---

## recall-protocol — 3,146 advisory findings (4,268 files)

| analyzer::rule | count |
| --- | --- |
| solid::function-length | 95 |
| styles::styles/off-scale | 759 |
| documentation::function-documentation | 574 |
| styles::styles/token-bypass | 456 |
| data-access::loop-query | 290 |
| dependency-graph::unreferenced-module | 114 |
| react::raw-element | 111 |
| dependency-graph::orphaned-nodes | 24 |
| react::performance | 95 |
| schema-code::too-many-queries | 84 |
| solid::parameter-count | 11 |
| documentation::method-documentation | 80 |
| data-access::complex-query | 1 |
| react::complexity | 29 |
| conventions::conventions/usage-pair | 60 |
| styles::styles/mechanism-fragmentation | 52 |
| conventions::conventions/error-handling | 51 |
| styles::styles/undefined-class | 47 |
| solid::solid/method-complexity | 33 |
| data-access::unfiltered-query | 6 |
| cross-domain::cross-domain/read-never-written | 14 |
| dry::dry/similar-expression | 21 |
| styles::styles/declaration-set-similarity | 21 |
| documentation::class-documentation | 16 |
| react::accessibility | 13 |
| conventions::conventions/naming | 10 |
| cross-domain::cross-domain/multi-table-write | 7 |
| schema::unknown-table | 10 |
| styles::styles/mechanism-mixing | 9 |
| cross-domain::cross-domain/written-never-read | 19 |
| styles::styles/z-index-singleton | 7 |
| dry::dry/duplicate | 6 |
| conventions::conventions/import-form | 5 |
| data-access::sql-injection-risk | 4 |
| solid::solid/dependency-inversion | 3 |
| solid::solid/class-size | 2 |
| solid::interface-size | 2 |
| conventions::conventions/export-shape | 1 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::hub-nodes | 1 |
| styles::styles/z-index-sprawl | 1 |

## hhra-org — 743 advisory findings (760 files)

| analyzer::rule | count |
| --- | --- |
| solid::function-length | 32 |
| styles::styles/undefined-class | 346 |
| documentation::method-documentation | 69 |
| dependency-graph::unreferenced-module | 60 |
| react::performance | 57 |
| documentation::function-documentation | 51 |
| documentation::class-documentation | 39 |
| react::complexity | 6 |
| data-access::loop-query | 18 |
| dependency-graph::orphaned-nodes | 4 |
| schema-code::too-many-queries | 21 |
| solid::solid/dependency-inversion | 8 |
| solid::solid/method-complexity | 7 |
| conventions::conventions/naming | 6 |
| conventions::conventions/usage-pair | 5 |
| dry::dry/similar-expression | 5 |
| cross-domain::cross-domain/written-never-read | 2 |
| cross-domain::cross-domain/read-never-written | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::hub-nodes | 1 |
| react::accessibility | 1 |
| schema::invalid-json | 1 |
| schema-code::dynamic-sql-construction | 1 |

## knex — 112 advisory findings (474 files)

| analyzer::rule | count |
| --- | --- |
| schema-code::too-many-queries | 3 |
| solid::function-length | 9 |
| solid::solid/class-size | 15 |
| solid::solid/dependency-inversion | 12 |
| dependency-graph::orphaned-nodes | 7 |
| schema::unknown-table | 16 |
| data-access::hardcoded-connection | 16 |
| solid::solid/open-closed | 12 |
| solid::interface-size | 4 |
| data-access::loop-query | 2 |
| data-access::sql-injection-risk | 5 |
| cross-domain::cross-domain/read-never-written | 4 |
| cross-domain::cross-domain/written-never-read | 1 |
| dependency-graph::hub-nodes | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::tight-coupling | 1 |
| dry::dry/similar-expression | 1 |
| schema-code::table-naming-convention | 1 |
| secrets::hardcoded-secret | 1 |

## primer-css — 16 advisory findings (137 files)

| analyzer::rule | count |
| --- | --- |
| styles::styles/z-index-singleton | 11 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::unreferenced-module | 1 |
| documentation::function-documentation | 1 |
| styles::styles/token-bypass | 1 |
| styles::styles/z-index-sprawl | 1 |

## blitz — 721 advisory findings (788 files)

| analyzer::rule | count |
| --- | --- |
| documentation::function-documentation | 191 |
| documentation::method-documentation | 161 |
| styles::styles/declaration-set-similarity | 161 |
| solid::function-length | 3 |
| react::raw-element | 54 |
| dependency-graph::orphaned-nodes | 44 |
| documentation::class-documentation | 34 |
| styles::styles/token-bypass | 16 |
| styles::styles/undefined-class | 15 |
| solid::solid/dependency-inversion | 11 |
| react::performance | 9 |
| schema::unknown-table | 4 |
| schema-code::reserved-word | 4 |
| secrets::hardcoded-secret | 3 |
| conventions::conventions/naming | 2 |
| data-access::loop-query | 2 |
| solid::solid/open-closed | 2 |
| conventions::conventions/export-shape | 1 |
| dependency-graph::tight-coupling | 1 |
| dependency-graph::circular-dependency | 1 |
| dependency-graph::hub-nodes | 1 |
| solid::solid/method-complexity | 1 |

## endless-guessing — 20 advisory findings (87 files)

| analyzer::rule | count |
| --- | --- |
| react::performance | 12 |
| data-access::loop-query | 3 |
| styles::styles/token-bypass | 3 |
| dependency-graph::tight-coupling | 1 |
| solid::function-length | 1 |
