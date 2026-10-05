# Known Issues

One board, tracked. **Permanent limitations** are structural gaps — parser or
grammar limits — that are not scheduled for a fix. The **Open board** is the
durable list of still-actionable rows, each carrying the `file:line` where it
is known. Open rows marked *done* carry their fix commit; nothing is silently
dropped.

## Permanent limitations

Persistent detection gaps and parser limitations that are **not** file-local
notes and are **not** scheduled for a fix in the current release. Each entry
names the mechanism, the affected surface, and why it is permanent (or at least
not actionable now) rather than a defect to file against a specific line.

---

### `node-sql-parser` sqlite grammar rejects `text(N)` column spellings

**Surface:** DDL extraction (`ddl-declarations` / `ddlColumnDefinitions` /
`parseSqlTables` — `src/languages/sql/sqlAst.ts`).

**Mechanism.** `node-sql-parser` (5.4.0) under its `sqlite` grammar does not
parse a `text(N)` column type — the `N`-length spelling that Drizzle's SQLite
dialect emits for string columns. `CREATE TABLE t (name text(256), x text(2))`
fails to parse; the un-lengthed `text` and the standard `varchar(255)` spellings
parse fine. This was probed directly (`text` ✓, `varchar(255)` ✓, `text(256)` ✗,
`text(2)` ✗).

**Why it is permanent.** It is an upstream grammar limitation, not a defect in
this tool's extraction logic. The DDL extractors walk the parser's AST; when the
parser refuses the statement there is no AST to walk, so the statement reports
`cannot-fire` (a parse-failure reason) instead of emitting its tables/columns.
`text(N)` is the *default* shape Drizzle-sqlite produces for `text` columns, so
this is a broad, permanent gap across any Drizzle-sqlite corpus — most
acutely openstatus, which is Drizzle-sqlite and carries this spelling throughout.

**Disposition.** Recorded as a known limitation, not a file-local note. The
correct long-term fix is upstream (or a DDL pre-normalization step), not a
regex fallback in this tool — a regex over raw SQL would re-introduce exactly the
hand-rolled parser this release removed (Spec 70 R2/R4). The honest outcome —
`cannot-fire` with a named parse reason — is correct behavior for an unparseable
statement, so nothing fires on a guessed reading.

## Open board

Flat board — one row per open issue, with the file:line where it is known. This
is the durable home for issues that today exist only in a report, a CHANGELOG
note, or a spec's "leaves on the board" tail. Each row is either *open* (still
to fix) or, once resolved, marked *done* with the fix commit — never silently
dropped.

### Release 5.0.0

| # | Issue | Where known | Status |
|---|-------|-------------|--------|
| 1 | **`verify:gate-budget` margin is no longer thin or flaky.** The bimodal tail (occasional 419–430 ms spikes against the 400 ms budget) was the per-block O(n²) `findNodeByLocation` BFS (`queue.shift()` memmove per dequeue) in the code-block producer and its four analyzer copies — collapsed by the shared memoized location index (`a9fac29`). Fresh `verify:close` warm-gate cpu-time **318.9 ms** (~81 ms headroom); 20-run standalone re-measure 319.9–347.1 ms, median 324.7, zero ≥400 ms. The remaining headroom win is the double-parse collapse, tracked entirely in issue 2. | `app/CHANGELOG.md:116` (`scripts/verify-gate-budget.mjs`) | done |
| 2 | **Double-parse — the warm gate parses each file three times** (`detectChangedFunctions` content-hash diff, the legacy pipeline's always-on index-population visitors, the phase model's `parseOne`). Collapsing to one parse is the release's outstanding performance item; see the four couplings (2a–2d) below. | `app/CHANGELOG.md:122` | open |
| 2a | **`receiverProvenance` pre-pass couples legacy → phase.** `resolveCorpusReceivers` ran a full-corpus receiver-resolution parse (`pipeline.ts:792`) whose `fileProvenance` was threaded to the phase model. **Fixed.** The pre-pass is deleted; `receiver-provenance` is now a phase corpus producer fed by four additive file facts (`within-file-provenance`, `import-specifiers`, `export-symbols`, `go-package-bindings`). Parity `computeReceiverProvenance ≡ resolveReceiverProvenance` is byte-identical across all six corpora (recall-protocol 1,499 files / 95 DB-signal, hhra-org 614/172, blitz 669/32, knex 434/2, endless-guessing 83/26, primer-css 13/0), pinned by `spec70-receiver-provenance-parity.spec.ts` (fixture) + `scripts/measure-receiver-provenance-parity.ts` (corpus). Warm-gate CPU re-measured **377.9 ms** (unchanged — the pre-pass was diff-scoped to the single changed file, so removing it does not move the single-file gate). | `app/src/phase/receiverProvenance.ts`, `app/src/phase/withinFileProvenance.ts` | done |
| 2b | **`function-index` visitor → `call-graph`.** `createFunctionIndexVisitor` (`auditRunner.ts:604`) populates `functions`/`graph_cache`; the phase `call-graph` producer reads them (`producers.ts:611`, queries at `:621-622`). Durable fix: re-derive call-graph from phase facts. **Correction (2026-10-03):** the `function-index` fact carries `functionCalls` as *callee-name strings* (`functionIndex.ts:76`), not resolved edges; the legacy `graph_cache` held cross-file-resolved `(node_key, neighbor_key)` edges keyed by DB id. So the re-derivation is a re-implementation of cross-file callee→`(file,name,line)` resolution, not a projection. | `app/src/auditRunner.ts:604`, `app/src/phase/producers.ts:611`, `app/src/phase/functionIndex.ts:76` | open |
| 2c | **`styles` visitors + reducer → `defined-classes` / `unread-style-sources`.** `createStylesCssVisitor`/`createStylesSourceVisitor`/`createStylesReducer` (`auditRunner.ts:607/610/625`) populate `style_defined_classes`/`style_unread_sources`; the phase producers read them (`producers.ts:737`, `:760`). Durable fix: re-derive from phase facts. **Correction (2026-10-03):** `unread-style-sources` is a *negative* (stylesheets the indexer could not read) — it cannot be reconstructed from successfully-read `style-declarations` facts alone; it needs the corpus-level CSS-file discovery list. `defined-classes` reads `.foo {}` definition selectors; the fact's `classUsage` (`stylesCss.ts:35`) may be usage, not definition. | `app/src/auditRunner.ts:607`, `app/src/phase/producers.ts:737`, `app/src/phase/stylesCss.ts:35` | open |
| 2d | **`dry` visitor + `persistDryPairs` → `clone-pair-history`.** `createDryVisitor` (`auditRunner.ts:612`) plus `persistDryPairs` (`auditRunner.ts:1020`) populate `dry_pair_history`; the phase `clone-pair-history` producer reads it (`producers.ts:696`). Durable fix: re-derive from phase facts. **Correction (2026-10-03):** `dry_pair_history` is a *cross-run* ledger (the diverging-clone rule does a cross-run pass; the producer reads `ORDER BY timestamp ASC, last wins`), so a single run's `code-block` fact cannot supply it. The fix is to move the ledger **write** from the legacy `createDryVisitor` to the phase DRY rule's output; the read stays index-backed by necessity. | `app/src/auditRunner.ts:612`, `app/src/phase/producers.ts:696` | open |
| 3 | **`unresolved-query` diagnostic has no phase home.** `createSchemaCodeVisitor` (`auditRunner.ts:630`) must keep running even though its findings are migrated, because its Spec 58 R1 `unresolved-query` diagnostic (DB-call SQL in an unresolvable identifier) is not a finding. Durable fix: give the diagnostic a phase home so the visitor can be deleted. | `app/src/auditRunner.ts:630` | open |
| 4 | **SQL literal dequoting gap.** `stripSqlQuotes` strips only the outer quote, not the inner JS escapes (`\'`, `\"`, `` \` ``), so a static literal whose SQL contains an escaped quote/backtick is fed to the parser with the backslash attached. One of the 128 knex static-`.raw` failures — `create table bar (\`i3\` integer primary key)` — is valid SQLite once un-escaped and fails *only* on this gap (a further site, the mixed-quoting `create table TEST (…'i1'…[i2]…)`, fails regardless). | `app/src/analyzers/provenance.ts:1302`, `app/specs/spec70-acceptance.md` §11 | open |
| 5 | **Drizzle-Kit `text(N)` length qualifier is rejected as sqlite.** openstatus's Drizzle-Kit migrations emit `text(2)`/`text(256)`; node-sql-parser's sqlite grammar accepts `text` but rejects `text(N)` (`varchar(255)` parses). This is a **grammar defect** — sqlite accepts `TEXT(N)` — not a dialect-detection issue, so it is filed separately from the null-dialect abstention above. Latent under the current gate (openstatus's null dialect already abstains), it would surface the moment openstatus declares a sqlite driver. Fixable in our layer (a pre-parse normalization mapping `text(N)` → `varchar(N)`, alongside `normalizePositionalParams`); also an upstream node-sql-parser limitation (its sqlite type-name rule omits the `TEXT(N)` length form). | `app/src/languages/sql/sqlAst.ts` (`parseSingleStatement`), `app/specs/known-issues.md` §ddl-declarations | open |
| 6 | **Spec 38 R2 per-rule timing on the phase path missed the producers.** After the phase-model migration, `withRuleTiming` only wrapped the legacy `Universal*Analyzer` visitors, so `CODE_AUDIT_RULE_TIMING=1` reported the migrated rules (~20 ms) against a ~320–359 ms gate with the fact-build cost invisible. The rule half was restored separately (`withRuleTimingAsync` in `analyzeAll`); the producer half remained. **Fixed** — `processFile` and `buildFacts` now time every producer's `process` under `producer:<id>` (`withRuleTiming`, the sync form), so the gate's breakdown surfaces `producer:schema-usage-candidates.typescript` (16.3 ms), `producer:file-symbols.typescript` (7.3 ms), `producer:code-block.typescript` (5.9 ms), … alongside the rules in one slowest-first list. Producers (~75 ms) + rules (~20 ms) of the ~359 ms gate are now attributed; the remainder is the legacy pipeline + parse + discovery (issue 2, double-parse). | `app/src/phase/phaseModel.ts:582` (file producer), `:424` (corpus producer), `app/src/analyzers/ruleTiming.ts` | done |

### ddl-declarations oracle shortfall — oracle/producer mismatch fixed, not recorded

The `verify:oracle-shortfalls` `ddl-declarations` gate was comparing two
different populations and calling the difference a shortfall: the oracle counted
every `CREATE/DROP/ALTER TABLE` header, while the producer emits one op per
CREATE/DROP/ALTER-RENAME only (an `ALTER TABLE … ADD/DROP/ALTER COLUMN` is a
column change, recorded in `tableColumns` not as an op). The gap was three
overlapping causes; two were fixed at the source, the third is a documented
grammar defect.

**Fixed — comment desynchronization (recall-protocol, dialect sqlite).**
`splitSqlStatements` (`app/src/languages/sql/sqlAst.ts:264`) tracked string/
identifier quotes but did not skip `--` / `/* */` comments, so an apostrophe
inside a comment (`-- don't`) opened a string literal that never closed, and
every later `;` in the file stopped registering as a statement boundary — a
multi-statement migration collapsed into one part. Compounding it,
`parseSqlProgramTolerant` (`sqlAst.ts:575`) pushed only `result.ast` (the first
statement of such a part) and dropped `result.statements`. Fix: skip comments in
the splitter; push `result.statements` in the tolerant parser. Recovery on
recall-protocol's `.sql` migrations: **442 → 574 emitted ops (+132)**.
Regression tests in `sqlAst.spec.ts` (`splitSqlStatements` comment cases) and
`migrations.spec.ts` (`parseMigrationOps` apostrophe/block-comment cases).

**Fixed — oracle counted ALTER non-rename as an op.** `countDdlOps`
(`app/src/phase/oracles.ts:254`) counted every `ALTER TABLE` header, so
`ALTER TABLE … ADD/DROP/ALTER COLUMN` / `ADD CONSTRAINT` counted as an expected
op the producer never emits. The oracle now counts only op-producing statements —
`CREATE/DROP TABLE` and `ALTER TABLE … RENAME TO` (the table-rename form;
`RENAME COLUMN` is a column change and is excluded by the same `RENAME TO`
guard). Oracle and producer now measure the same unit.

**Fixed — null dialect guessed sqlite.** `parseMigrationOps` (and the DDL
column/FK extractors, `app/src/analyzers/universal/schema/migrations.ts`) parsed
under `DEFAULT_SQL_DIALECT = 'sqlite'` when `detectDialect` returned null, so an
ambiguous corpus (hhra-org: postgresql + mysql2) had its Postgres DDL rejected
under a dialect nothing suggested. The fix is honest abstention: a null dialect
emits zero ops, and the caller surfaces the `dialect undetermined` cannot-fire
reason naming the candidates — no parse under an undetected dialect.

The re-measured shortfalls (the corrected baseline, against the pinned trees):

| corpus | dialect | files | expected | actual | residual |
|---|---|---|---|---|---|
| recall-protocol | sqlite (D1 binding) | 6 | 29 | 17 | 12 — grammar rejects of valid sqlite |
| hhra-org | null (pg+mysql ambiguous) | 27 | 201 | 0 | 201 — cannot-fire |
| blitz | null (no driver) | 12 | 40 | 0 | 40 — cannot-fire |
| openstatus | null (no driver) | 42 | 97 | 0 | 97 — cannot-fire |

The recall-protocol residual is the only real one: 12 op-producing statements
across 6 files that node-sql-parser rejects — valid sqlite the grammar cannot
parse (the same class of grammar defect as the openstatus `text(N)` row below).

### Carried from the phase-model migration

These are the Spec 68 board tail, re-measured on the new pipeline — still
outstanding after Spec 68 (listed here as the single source of truth so they are
not scattered across reports):

| # | Issue | Where known |
|---|-------|-------------|
| 5 | Spec 63 R1–R3 — emitted-field set, seam-conformance class, dead-spot disposition. | `specs/spec-68-phases-and-declared-inputs.md:597` |
| 6 | Spec 64 R1–R3 and R5–R7 — Go function index (R1's gate becomes a `needs.formats` declaration). | `specs/spec-68-phases-and-declared-inputs.md:597` |
| 7 | Spec 62 Amendment B R4 — reporting-boundary assertion. | `specs/spec-68-phases-and-declared-inputs.md:597` |
| 8 | Board §6.1 — 27 emitted-but-untested rules get behaviour fixtures. | `specs/spec-68-phases-and-declared-inputs.md:597` |
| 9 | Board §6.2 — 11 rules never through the authenticity ledger. | `specs/spec-68-phases-and-declared-inputs.md:597` |
| 10 | Board §7 — cross-file duplicate detection. | `specs/spec-68-phases-and-declared-inputs.md:597` |
| 11 | Board §8 — rule precision (`method-complexity`, `pgx`, `sqlc`, `ent`). | `specs/spec-68-phases-and-declared-inputs.md:597` |
| 12 | Board §9 — the API contract surface. | `specs/spec-68-phases-and-declared-inputs.md:597` |
