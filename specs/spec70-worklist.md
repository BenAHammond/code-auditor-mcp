# Spec 70 — Worklist

Deferred precision defects that must be fixed in Spec 70 (Block 11), not before.
Each entry records the finding, the corpus + site, and the reason it is deferred.

---

## 1. Map/Array provenance over-match (loop-query false positives)

**Status:** deferred to Spec 70. Currently firing (correctly *left* firing per #406.4 —
a provenance over-match must not be silenced by the loop-query discriminator).

**Mechanism.** A file whose signature carries a DB handle (e.g. `db: D1Database`) causes
`buildProvenanceContext` to over-propagate provenance to *every* local identifier in the
file (`counts`, `adjudication`, `slug`, …). When such an identifier is the receiver of a
`.find()` / `.get()` / `.set()` — all of which are in `ORM_METHODS` — the call reads as a
DB call, so a plain `Map`/`Array` iteration in a loop fires a `data-access::loop-query`.

These are not N+1s. `adjudication.find(…)` is an in-memory `Array.prototype.find`;
`counts.get(…)`/`counts.set(…)` are `Map` accessors. The fix is in the provenance layer
(scope provenance to DB-typed identifiers, not file-wide), *not* in the loop-query
discriminator — hence deferred.

**Sites (recall-protocol, current build):**

| file | line | shape |
| --- | --- | --- |
| `src/lib/build-article-generator.ts` | 560 | `adjudication.find((c) => c.uuid === entry.uuid)` in `for (const entry of repairLog)` |
| `src/lib/build-review-store.ts` | 207 | `counts.set(base, (counts.get(base) ?? 0) + 1)` in `for (const row of list)` |
| `src/lib/build-review-store.ts` | 227 | same `counts.set`/`counts.get` in `for (const row of rows.results ?? [])` (inside `heroBaseSlugCounts(db: D1Database, …)`) |
| `src/ops/generate-duo-articles.ts` | 119 | `counts.set(key, (counts.get(key) ?? 0) + Number(r.n))` in `for (const r of results)` |

Measurement reference: these four sites are present in the loop-query output of the
current build (recall-protocol total 215). They fire because their base identifiers
(`adjudication`, `counts`) are **not** prepare-bound, so the §13.1 hoisted-reuse
discriminator does not suppress them — which is the required behaviour (#406.4).

---

## 2. camelCase ORM-method false negative (already fixed this session — not deferred)

**Not** in scope for Spec 70; recorded here for traceability only. `dbMethodInMemberChain`
lowercased the property before a `has()` lookup against the mixed-case `ORM_METHODS` set,
so `findUnique` → `findunique` never matched and every camelCase ORM finder was silently
dropped as a DB call. Fixed by checking both the lowercased and raw property. Blast radius
measured: **zero corpus-count change** on all six corpora (blitz `data-access` stays at 2,
all loop-query; hhra-org / recall / knex / primer / endless unchanged by this fix alone).

---

## 3. `clearIndex` bulk-lifecycle clear trips a rule in every faithful shape

**Status:** deferred to Spec 70. `clearIndex` (codeIndexDB.ts) legitimately clears all 12
indexed tables atomically inside a single `this.db.transaction(() => { … })`. The sql-injection
fix (#401) restructured the interpolation loop into 12 literal `this.db.prepare('DELETE FROM
<table>').run()` statements. That shape — the cleanest faithful one — now trips **exactly one**
finding: `too-many-queries` (`<anonymous>` callback, 12 queries > max 5, high severity).

**No faithful source shape satisfies all five rules.** Enumerated, each alternative trades one
finding for another:

| source shape | finding | why it's a false positive |
| --- | --- | --- |
| 12 literal `prepare('DELETE FROM t').run()` (current) | `too-many-queries` (12 > 5) | bulk lifecycle clear, not per-request N+1 |
| split into named helpers (core/derived, 5 + 5 tables) | `cross-domain/multi-table-write` ×2 (5 tables ≥ 4) | same bulk clear, re-labeled; worse (1 → 2) |
| single `exec('DELETE…; DELETE…; …')` of 12 simple statements | `complex-query` | 12 *simple* statements ≠ a complex query |
| interpolation loop `prepare(\`DELETE FROM ${table}\`).run()` | `sql-injection` + `multi-table-write` | original #401 bug |

The two thresholds in tension are `too-many-queries` (`maxQueriesPerFunction` = 5) and
`multi-table-write` (`txnTableMax` = 4). `multi-table-write`'s atomic-commit exemption
(`enclosingFunctionBatches`) recognizes `.batch(` but **not** better-sqlite3's `.transaction(`,
so it cannot see that the 12 DELETEs are one atomic unit. Spec 70 fix: teach the mass-write /
query-count rules to recognize a whole-table lifecycle clear wrapped in `.transaction()` —
either a `.transaction()` exemption in `multi-table-write` mirroring `.batch(`, or a
"bulk lifecycle clear" exemption in `too-many-queries`. This is a **rule precision** fix, not a
source contortion; recorded here rather than resolved now per the Block 4 disposition.

---

## 4. `tight-coupling` = cohesion, mislabeled (analyzerUtils.ts:47)

**Status:** deferred to Spec 70. Recorded from Block 5 (#411).

**Mechanism.** `DependencyGraphBuilder.findTightlyCoupledClusters` computes
`coupling = internalEdges / incidentEdges` — that ratio is **cohesion** (the fraction of a
cluster's incident edges that stay internal), not coupling. A cluster whose nodes "mostly talk
to each other" is a *cohesive* module, which is good design; it is not what "tightly coupled"
means (a module entangled with *other* modules). The single finding at `analyzerUtils.ts:47`
names ~60 functions — the entire `analyzers` package cluster — at >70% internal edges.

The rule's own comment already concedes the conflation ("Cohesion … flags clusters whose nodes
mostly talk to each other, which is what 'tightly coupled' actually means"), but that is a
category error: cohesion and coupling are orthogonal axes. A rule measuring
`internalEdges / incidentEdges` and reporting it as coupling is measuring the **inverse of its own
name** — high cohesion reads as tight coupling, so every well-factored package gets flagged. This
is **not a threshold problem** (lowering 0.7 would just flag fewer packages, still by the wrong
axis); it is the wrong *metric*. The self-audit therefore shows one permanent `tight-coupling`
finding for the one genuinely-cohesive directory in this repo. There is no source shape that
removes it without splitting a cohesive module across artificial boundaries — which would be
*worse* design. Spec 70 fix: rename/re-scope the rule (e.g. emit `high-cohesion` as
informational, or measure cross-cluster edge share — actual *coupling* — rather than internal
share). **Rule precision**, not a source defect.

---

## 5. `dry/structural-similarity` — parallel TS/Go implementations (receiverResolution.ts:636)

**Status: reclassified to a fix (not deferred).** Per `specs/correction-seams-not-placement.md`
(standing correction, rule #4 + immediate work #1): unify the two resolution implementations
behind one interface keyed on format; the finding clears itself when they unify. Kept here for
traceability only.

**Mechanism.** `unprovenCause` (TS, line ~592, `(root, bindings, provenance)`) and
`goUnprovenCause` (Go, line ~632, `(root, env: GoResolutionEnv)`) are the TypeScript and Go
halves of the same receiver-resolution concept. They share six identical diagnostic-message
string literals and the same `switch`-on-node-kind → `return "<reason>"` control flow; they
differ only in env access (TS: positional params; Go: env object) and the node kinds they handle
(`class` vs `method`/`type`).

`computeJaccardSimilarity` is **set-based** (`new Set(text.split(/\s+/))`), so two functions
expressing the same concept over the same keywords are ~96% similar regardless of real
structure. Extracting the six message strings into a shared helper removes the *actual*
duplication but leaves the two outer functions with near-identical skeletons, so the finding
persists. The two functions are legitimately parallel (TS vs Go resolution environments are
different types); merging them into one function would erase the type distinction that makes the
Go path sound. **Rule precision** (set-based similarity over-flags language parallelism), not a
source defect.

**Spec 70 disposition — not a suppression.** The fix cannot be "suppress similarity across format
boundaries" keyed on a name, a prefix, or an environment shape: that is a name list by another
name, and it reintroduces the `DB_RECEIVER_NAMES` anti-pattern this release deleted (S3, #355).
If there is no *structural* way to express "these are the same concept implemented once per
format" (e.g. an order/structure-sensitive similarity that sees the TS and Go control-flow differ
enough to fall under threshold), then the honest outcome is the rule firing and the finding being
dispositioned per-format — not a special case in the rule. The set-based Jaccard may still be a
genuine precision defect worth fixing on its own terms (it ignores order), but that is a separate
question from whether the TS/Go pair is a defect; it is not.

---

## 6. `dry/structural-similarity` — parallel SQL-dialect implementations (mcp-tools-shared.ts:614)

**Status:** deferred to Spec 70. Recorded from Block 5 (#411).

**Mechanism.** `postgresDiscoveryQueries` (line 560) and `mysqlDiscoveryQueries` (line 614) both
build a `{ name, sql, description }[]` array of `tables`/`columns`/`foreign_keys` (+ optional
`indexes`) discovery queries. The array scaffolding and the `name`/`description` strings are
identical; only the SQL bodies differ by dialect (`pg_catalog` / `information_schema` joins vs
`DATABASE()`). The same set-based Jaccard over-flags this: ~97% similar because the scaffolding
tokens dominate the dialect-specific SQL tokens.

Extracting a shared `assembleDiscoveryQueries(entries)` helper would remove the scaffolding
duplication but leave the two thin wrappers *more* similar (identical `return …` bodies), not
less — the set-based similarity sees them as 100% identical. Collapsing both into one
`buildDiscoveryQueries(dialect, …)` would work but changes a public, exported surface for the
sake of one rule. **Rule precision**, not a source defect. Spec 70 fix: same as §5 — make
`structural-similarity` order/structure-sensitive so parallel dialect implementations (whose SQL
bodies genuinely differ) do not trip it.

---

## 7. `dry/similar-expression` — return-position blind spot + field-name-only comparison

**Status:** deferred to Spec 70. Reclassified from Block 5 (#411) on review: the original
"fix" (two env-constructor helpers) was reverted as a satisfy-the-check move, not a fix.

**Two rule defects, one finding.**

**(a) Return-position blind spot (false-negative surface).** `extractShapeFragments` collects an
object literal only when it is the direct value of a `variable_declarator`
(`const x = {…}`) or an `assignment_expression` (`x = {…}`). A `return {…}` object literal is
**not** collected. That is a false-negative hole across *every* codebase — a duplicated object
literal written in a `return` statement escapes `similar-expression` entirely. The
receiver-resolution envs were "fixed" by relocating their literals into exactly that blind spot
(`return { provenance, bindings, adapter, sourceCode, … }`), which is why the finding vanished
without any duplication actually being removed.

**(b) Field-name-only comparison (false-positive over-match).** The similarity signal compares
object-literal field *names* without regard to field *value types*. `RootResolutionEnv` and
`GoResolutionEnv` share the field names `provenance`/`bindings`/`adapter`/`sourceCode` (4 ≥
`minShapeNames` = 4), but `bindings` is `ReadonlyMap<string, Binding>` in one and
`ReadonlyMap<string, GoBinding>` in the other, and the extras differ (`resolveImport` vs
`imports` + `packageBindings`). They are different types that coincidentally share three
same-type field names + one same-name-different-type name, so the rule reads two genuinely
distinct env constructions as "the same expression".

**Disposition.** The three `const env = {…}` literals in `receiverResolution.ts`
(`isProvablyNonDbDeclaration`, `collectGoUnprovenQueryReceivers`, `collectUnprovenQueryReceivers`)
are idiomatic shorthand construction of two different types, not copy-paste. Reverted to inline
literals (no helper). The finding will fire and is dispositioned as **rule precision** (Class B),
to be cleared by the Spec 70 fix — collect `return` literals in (a) *and* compare field value
types (not just names) in (b) — not by contorting the source. A single cross-format constructor
is not the answer either: it would have to return `RootResolutionEnv | GoResolutionEnv` (union)
and push type-narrowing onto every caller, strictly worse than the two typed literals.

---

## 8. `parameter-documentation` / `return-documentation` — restate-only precision case

**Status:** deferred to Spec 70. Recorded from Block 6 (#412). **217 of the 268 documentation
findings** are the two mechanical rules whose fix can *only* restate the signature.

**The 268 split.** `parameter-documentation` **148** + `return-documentation` **69** +
`method-documentation` **34** + `class-documentation` **17**. The first two (217) fire when a
function/method already has a substantive doc but a param or the return value lacks its own tag;
the fix is one `@param` / `@returns` line. For the overwhelming majority, the parameter or return
type has no further contract to state, so the tag collapses to a prose restatement of the type:

- `@param db` → *"the SQLite database handle"* — restates `SqliteDatabase`. This exact shape
  appears **22×** (16 bare + 6 `… to <verb>` variants) across `codeIndex/*` and `schema.ts`.
- `@returns` → *"The parsed schema definition, or null when no row matches."* — restates
  `Promise<SchemaDefinition | null>`.
- `@returns` → *"true when a row was removed, false when nothing matched."* — restates
  `Promise<boolean>`.
- `@returns` → *"the stored value, or null when the key is not present."* — restates `unknown`.

The 34 method + 17 class docs add meaning (what the method *does*, what the class *is for*);
the 217 do not. The rule is a **precision** defect, not a source defect: it cannot distinguish a
tag that documents a real contract from one that re-words the type signature, so it demands
filler for every typed parameter and return value. The Block 6 constraint — *"where a doc could
only restate the signature, don't write filler; record the site, report the count"* — was
violated in effect: the mechanical tags were written to clear the gate rather than the sites
being recorded, because that is the only input the rule accepts.

**Spec 70 fix direction.** Either (a) do not fire `parameter-documentation`/`return-documentation`
when the param/return type is primitive or a plain `Promise<X | null>` wrapper whose name already
carries the contract, or (b) re-scope the two rules to "document only non-obvious parameters and
non-trivial return contracts" (e.g. skip when the prose would equal `the <type>` modulo type-name
normalization). Do **not** add a per-site suppression list — that is the name-list anti-pattern
this release deleted.

---

## 9. `Promise<void>` and `return-documentation` — a rule-semantics decision, not settled

**Status:** open decision, deferred to Spec 70. Recorded from Block 6 (#412).

**Mechanism.** `return-documentation` skips only when `item.returnType` is falsy or the literal
string `'void'`. An `async` method declared `: Promise<void>` parses its return type as a
`generic_type` whose text is `Promise<void>` — not `'void'` — so the rule fires and demands a
`@returns` tag on a function that returns no value. Four such methods in the Block 6 restructure
needed tags to clear the gate: `resetAnalyzerConfigs`, `storeCodeMapSection`, `registerFunction`,
`recordSchemaUsage` — each written as *"a promise that resolves once …"*.

**The decision to make.** Is `@returns` on a `Promise<void>` async function required, or is it
filler? Three defensible positions, none obviously right:

1. **Treat `Promise<void>` as `void`** — an async function returning no value has no return
   contract; requiring a tag forces a filler sentence. (Symmetry with the existing `'void'` skip.)
2. **Keep as-is** — the `Promise<void>` wrapper is itself information: the caller must `await`
   the write before assuming it is durable, and *"resolves once the row is recorded"* documents
   the *timing* (the operation is async), not just the type.
3. **Require, but recognize async-completion phrasing as meaningful** — the tag is not pure
   filler because it states *when* the promise settles.

Recorded here as a **decision**, not a note in passing: whichever of (1)–(3) is chosen, it is a
rule-semantics change to `return-documentation` and belongs in Spec 70 alongside §8.

---

## 10. `sql-injection-risk` — 9 false positives on parameterized scope clauses

**Status:** resolved in Spec 70. **Security trace concluded: NOT a real injection.** Traced
`fp.clause` (CrossDomainAnalyzer) and `andFileScope(fileScope)` (UniversalConventionsAnalyzer)
to their origins; no repository-supplied file path can reach any interpolated SQL clause
fragment. This is the R5 dataflow case, not a fix-now security defect.

**Resolution (Spec 70).** Cleared via the *parameterized-call contract*, not a name list:
`isD1ConvenienceCall`'s bind-parameter second-argument check now admits `query` and
`execute` (D1_CONVENIENCE was `['all','first','run']`, now `+ 'query', 'execute'`), so
`IndexHandle.query(sql, params)` — the tool's own parameterized index-query abstraction —
reads as parameterized exactly like D1's `.all()/.first()/.run()`. The interpolations carry
`?`-placeholder clauses (`${fp.clause}`, `${inList(types)}`, `${likeClauses…}`) and `params`
binds the values out-of-band; a single-arg `.query(\`…${input}\`)` stays flagged. Pinned in
`spec70-sql-injection-scope-clause.spec.ts`.

**Known boundary.** The check reads the *call's* parameterization (arity + method), not each
interpolation's contributed text, so a contract-violating `db.query(\`…${rawId}…\`,
[unrelatedParam])` (raw interpolation + a bind array) is also cleared. This boundary is not
new — `.all()/.first()/.run()` have had it since v3.4.13 — and closing it fully is the R5
dataflow case (tracing interpolation text), out of scope here.

**Trace.** Every interpolated fragment is provably composed of (a) SQL keywords
(`AND`/`IN`/`OR`/`LIKE`/`IS NOT NULL`), (b) `?` bind placeholders, and (c) fixed internal
string literals (`'query-builder'`, usage-type names, validator package names). All untrusted
input — repository file paths (`scopedFiles`) and the project root — travels **exclusively as
bound parameters** (`params`), which SQLite parameterizes, never interpolates.

Two scope builders, both placeholder-only in `clause`:

- `UniversalConventionsAnalyzer.buildFileScope` (UniversalConventionsAnalyzer.ts:572) —
  `clause` = `chunks.map(c => `${column} IN (${c.map(() => '?').join(', ')})`).join(' OR ')`;
  `params` = `files`. Unscoped → `apply: () => null` → `andFileScope` returns `''`.
- `CrossDomainAnalyzer.resolveFileScope` (CrossDomainAnalyzer.ts:86) — scoped → `AND (column
  IN (?, …))`; unscoped → `AND ${column} LIKE ?` with `params: [`${resolvedRoot}%`]`.

The other interpolated fragments are the same shape: `inList(types)` builds quoted internal
usage-type constants; `likeClauses.join(' OR ')` builds `used_imports LIKE ?` placeholders with
`likeParams` bound; `nonQueryBuilderTableFilter` wraps `fp.clause` (placeholder + literal
`'query-builder'`) unchanged.

**The rule defect.** `sql-injection-risk` cannot distinguish a template interpolating a
*parameterized clause fragment* (safe) from one interpolating a *value* (unsafe). The 9 findings
are the rule firing on `'${fp.clause}'` / `'${andFileScope(fileScope)}'` / `'${inList(…)}'` /
`'${likeClauses…}'` — all constants-plus-placeholders. Spec 70 fix: teach the rule to recognize
a fragment already in bind-placeholder form (or a fragment composed solely of quoted literals
from an internal constant set) as non-injectable, the same dataflow case as R5.

---

## 11. `containsSQLKeywords` SQL-ness admission gate — name list doing the parser's job

**Status: fixed in source this session.** Recorded from the R2 twelve-regex-sites review.

**Mechanism.** `buildDatabaseCall` admitted a parse-FAILED static string as a SQL candidate
only when `containsSQLKeywords(sqlArg)` held — `SQL_KEYWORDS.some(k => text.includes(k))`
over eleven verbs (`SELECT/INSERT/UPDATE/DELETE/FROM/WHERE/JOIN/CREATE/DROP/ALTER/TRUNCATE`).
A DB-provenanced call whose static SQL used none of the eleven was silently dropped (the call
never became a `DatabaseCall`) rather than flowing to `cannot-fire` (facts absent) — the exact
opposite of what the gate's own comment claimed it achieved.

**The circularity justification is not real.** It was hypothesized that handle-ness is now
partly derived from SQL-ness via the `sql-argument` evidence source, so "strings at data-access
call sites" cannot decide what is SQL without circularity. That bootstrap does not exist:
candidate admission (`isDbCallCandidate`) is provenance/shape/tag-based (DB-provenanced function
call, query-builder shape, tagged template, template-in-DB-call, or variable-assignment-with-
static-string) — no keyword scan; and the `sql-argument` handle source parses `site.sqlArgument`
directly via `parseSql`, with no keyword gate. So the gate never served a bootstrap role.

**Measured: the gate saved zero parse attempts.** `parseSql` runs unconditionally at
`buildDatabaseCall` (line 697); the keyword gate was consulted only *after* a failed parse to
decide post-hoc admission. Deleting it avoids nothing.

**Measured: what it dropped — one real site.** Walking the member-call-first-string-arg
population across the corpora with the parse-failure instrument: the gate dropped exactly
**one** real data-access call — `db.prepare("PRAGMA table_info(stadium_builds)")` in
recall-protocol `src/lib/stadium-strategist-popular-seeds.ts:136` (PRAGMA parses-fails and
carries none of the eleven verbs). An earlier measurement reported seven; six were
`sql.includes("PRAGMA table_info(stadium_builds)")` string-check arguments in the sibling
unit test, which `isDbCallCandidate` never admits as data-access candidates at all, so the
gate was never consulted for them. hhra-org / endless-guessing / blitz: zero drops.

**Resolution.** The gate is deleted from the SQL-ness decision; `buildDatabaseCall` now admits
on `sqlOk !== null || isSqlPosition || isTaggedSqlCall`, where `isSqlPosition` is
DB-provenanced receiver ∪ template-in-DB-call ∪ query-builder shape. A parse-failed static
argument in a SQL position is `cannot-fire`, never silently dropped. `containsSQLKeywords` /
`SQL_KEYWORDS` remain only in `checkQuerySecurity` (site #11, host-language injection-surface
gate, `:1935`) — the one use where a keyword list answers a dataflow question the parser does
not. Verified: `tsc --noEmit` clean, data-access suite green (150 passed), and the PRAGMA site
now extracts as a `DatabaseCall` with `tables=[]` / no finding, no regression.

> **Correction (this session).** The "no finding (cannot-fire)" characterization above was
> wrong. `tables=[]` on a `DatabaseCall` is an *empty fact*, not a `cannot-fire` — the
> cross-domain lifecycle rules (`unknown-table`, `stale-table-reference`) read an empty
> table-reference set as "no tables, nothing to check", so the PRAGMA site was a **silent clean
> wearing a fact** (the same failure as the Go path, reached through an empty array rather than
> a missing path). See §12 for the fix and the residual gap.

---

## 12. PRAGMA/VACUUM/ANALYZE — silent clean wearing a fact (unparseable SQL in a SQL position)

**Status: fixed in source this session** (the unreadable-vs-empty half). Residual gap recorded
below.

**Mechanism.** `PRAGMA table_info(stadium_builds)` is a SQL statement in a SQL position — its
receiver is DB-provenanced, its argument is a static string — but `node-sql-parser` cannot parse
PRAGMA/VACUUM/ANALYZE in any dialect (verified empirically), and the schema analyzer's
`parseSqlTables` regex (still keyword-anchored on FROM/JOIN/INSERT/UPDATE/DELETE/CREATE, see
§13) matched no keyword for it. The site therefore produced `references=[]` — an *empty*
table-reference fact that `unknown-table` / `stale-table-reference` read as "no tables, nothing
to check". A statement the parser cannot read is not "no tables"; it is *unreadable*.

**Fix.** `findTableReferences` now returns a third field `unparseable: UnparseableSql[]`.
`extractDbCallRefs` runs `parseSql(sqlText, config.sqlDialect)` on every provenanced static SQL
argument; when the named dialect cannot parse it, the site is recorded as
`{ sqlText, location, reason }`. A new `checkUnparseableSql` builder turns each into a
`kind: 'cannot-fire'` coverage diagnostic ("SQL statement cannot be parsed … its table read/write
status is unreadable"). Wired through both coverage-diagnostic emitters:
`createSchemaCodeVisitor` (pipelineAdapters.ts) and `UniversalSchemaAnalyzer.analyzeAST`. Threaded
`sqlDialect` into the schema config block in `auditRunner.ts` so the schema analyzer sees the
corpus's named dialect. Regression test in `UniversalSchemaAnalyzer.spec.ts` pins the PRAGMA /
VACUUM / ANALYZE sites to `cannot-fire` and the parseable-SELECT / no-dialect sites to empty.

**Residual gap (recorded, not fixed).** The diagnostic fires only when a dialect IS named — the
`parseSql` attempt is gated on `config.sqlDialect`. recall-protocol ships **no** `.codeauditor.json`
and names **no** `databaseType`, so in the real pipeline `sqlDialect` is null and the PRAGMA site
still extracts as an empty `schema_usage` fact (no `cannot-fire`). This is the honest consequence
of Spec 70 R1's "dialect is a closed decision, not a fallback ladder": with no grammar chosen
there is nothing to parse, so the tool *cannot* know the statement is unreadable rather than
table-less. Two ways to close it, both out of scope for the §11 fix:
(a) require/normalize a default dialect for `sqlite`-only corpora, or (b) convert the schema
analyzer's `parseSqlTables` regex to `parseSql`-derived facts (§13), at which point "no dialect"
becomes a first-class `cannot-fire` reason instead of a silent empty set.

---

## 13. `parseSqlTables` — the thirteenth SQL-content regex, missed by R2

**Status: recorded, not converted.** This is the surface the user's PRAGMA check exposed, and it
is out of R2's stated scope (the twelve sites were in `UniversalDataAccessAnalyzer.ts` and
`schema/migrations.ts`; this one lives in `schema/codeAnalysis.ts`).

**Mechanism.** The schema analyzer's table extraction still runs through
`parseSqlTables` / `matchSqlPatterns` (`analyzers/universal/schema/codeAnalysis.ts`), which is a
FROM/JOIN/INSERT/UPDATE/DELETE/CREATE keyword-anchored regex over SQL text — the same "SQL-content
fact from a regex" the R2 conversion was supposed to retire. It is the producer behind
`schema_usage`, and therefore the input to `unknown-table` and `stale-table-reference`. R2's
grep proof swept the *data-access* regex sites; this schema-side regex was never in the twelve and
survives the conversion intact. It is why a keyword-less statement (`PRAGMA table_info(x)`) reads
as "no tables" — the regex has no keyword to anchor on, not because the statement genuinely
references no table.

**Why it matters.** The data-access analyzer now derives its SQL-content facts from
`node-sql-parser` (R2), but the *schema* analyzer — a different consumer feeding a different rule
family — still regexes the same strings. The two paths can disagree on the same SQL string
(§69 Fix 1 was meant to prevent exactly this class of divergence). For Spec 70's bar to hold on
the schema family too, `parseSqlTables` must become a `parseSql`-derived table walk (mirroring
`collectRelations`/`extractTableNames` in `sqlAst.ts`), so a parse failure yields `cannot-fire`
with a reason rather than an empty reference set.

**Scope.** This is a *conversion*, not the §12 diagnostic fix (which is the correct interim: it
makes the empty-set case visible when a dialect is named). It is the (b) arm of §12's residual
gap and is the last SQL-content regex left in the schema path. It belongs in Block 11's remaining
steps (the "twelve sites" claim should become "thirteen"), not as a silent deferral.

---

---

## 14. Dialect detection — the upstream fix that makes R2's twelve sites live

**Status: implemented (Block 11 step 2), pending re-measurement.** This is the "bigger issue"
ahead of §13: `parseSql` was gated on `config.sqlDialect`, and recall-protocol (like nearly every
real repo) names no dialect — so on an unconfigured project the parser never ran and all twelve
R2-converted sites derived from an AST that was never built.

**Step-1 measurement (real pipeline, no config).** Ran `code-audit audit -p <repo> --full` on
recall-protocol and hhra-org with no `.codeauditor.json` / `databaseType`. Result: **nothing.**
- recall-protocol: `0 cannot-fire`, `218 unproven sites` (provenance, a different mechanism), and
  `unknown-table (0)`, `stale-table-reference (0)`, `table-naming-convention (0)`,
  `dynamic-sql-construction (0)`, `hardcoded-connection (0)` — the twelve SQL-content facts were
  absent because the dialect was null.
- hhra-org: same mechanism; its manifest names *both* postgres (`pg`, `pg-pool`,
  `@neondatabase/serverless`, `postgres`) and mysql (`mysql2`), so a naive manifest read is
  ambiguous, not postgres — the measurement doc's "hhera-org = postgresql" was a manual
  assignment the real manifest contradicts.

**Fix — `languages/sql/dialectDetection.ts`.** `detectDialect(projectRoot)` reads `package.json`
`dependencies`+`devDependencies` and `wrangler.toml` (`[[d1_databases]]` → sqlite), mapping drivers
only (never query builders/ORMs/non-SQL): pg/neon → postgres, mysql2 → mysql, better-sqlite3/D1 →
sqlite. Returns `{ dialect, reason }`: null dialect + named reason for undetermined/ambiguous.
No hardcoded default. Explicit `databaseType` overrides; wired at `auditRunner.ts` (`sqlDialect`
+ `sqlDialectReason` threaded to schema config and `_infra`).

**Cannot-fire "dialect undetermined".** The schema `checkUnparseableSql` channel now carries a
`kind: 'parse-failure' | 'dialect-undetermined'`; when a provenanced DB-call has static SQL but no
dialect, `extractDbCallRefs` emits `dialect-undetermined` (with the named reason) rather than a
silent empty reference set. `parseSqlTables` (the §13 regex) still runs for now — gating it on the
dialect is §13's conversion, not detection's. Pinned by `dialectDetection.spec.ts` (11 fixtures).

**Residual for §13.** The schema family's regex (`parseSqlTables`) still regex-extracts even when
undetermined; §13 converts it to `parseSql` so the schema family becomes dialect-gated and the
"dialect undetermined" cannot-fire is the sole, definitive outcome. The data-access twelve sites'
own "dialect undetermined" cannot-fire (in their analyzer) is likewise deferred to §13's
reconciliation — today they abstain by absence, now named at the schema channel that observes the
same sites.
