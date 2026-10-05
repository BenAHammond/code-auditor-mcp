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
| 7 | **Installed plugin and source tree drift silently, in both directions, and nothing detects it.** `~/.claude/plugins/marketplaces/code-auditor-mcp/plugin/scripts/hook-audit.sh` gained a source-file extension-scoping block (Sep 21) that never landed in `plugin/scripts/hook-audit.sh` (Sep 5); meanwhile the installed `plugin.json`/`SKILL.md` sit at 4.1.0 while the source tree is 5.0.0. A version or checksum check at SessionStart would catch it — that is a spec, not a fix. | `app/plugin/scripts/hook-audit.sh`, `app/plugin/.claude-plugin/plugin.json` | open |
| 8 | **Extension knowledge lives in two hand-maintained places: the per-adapter `fileExtensions` (which `LanguageRegistry` correctly unions) and `fileDiscovery.ts`'s central arrays.** The adapters already do the right thing — `readonly fileExtensions` on each (`TreeSitterTypeScriptAdapter.ts:857`, `GoAdapter.ts:457`, `JsonAdapter.ts:362`, `TreeSitterCssAdapter.ts:50`) and `LanguageRegistry.registerAdapter` builds the `extensionMap` union (`LanguageRegistry.ts:37`). But discovery does not derive from that registry: `findFiles`/`discoverFiles` default to `fileDiscovery.ts`'s hand-rolled `ALL_EXTENSIONS` / `KNOWN_SOURCE_EXTENSIONS`, and `getLanguageFromPath` (`fileDiscovery.ts:172`, "single source of truth" in name only) is a third copy that already drifts — it maps only TS/JS/Go and returns `unknown` for JSON/CSS/SQL, which the adapters *do* claim. Adding a parser today is one file (the adapter) *plus* three edits in `fileDiscovery.ts`. The spec is: each adapter declares its extensions, the registry is the union, discovery derives from the registry (plus the raw/markup sets the adapters don't own), and a registered format with no declared extensions fails to compile. That is what makes Python/Rust affordable later. | `app/src/languages/types.ts:170`, `app/src/languages/LanguageRegistry.ts:37`, `app/src/utils/fileDiscovery.ts:172` | open |
| 9 | **No end-to-end smoke test runs the installed CLI's main commands.** `verify:dist` proves the tarball installs; nothing runs `code-audit changed` against a live daemon — which is how a crash sat undetected in the hook's primary path. The `changed` daemon fast-path returned a `result` with no `summary` (`buildChangedResultFromDiagnostics` returned only `analyzerResults` + `metadata`), so `result.summary.dismissed` threw a TypeError on every `.ts` edit against a ready daemon (exit 1 — a broken hook by the contract's own definition). Fixed and folded into 5.0.0: a guarded read (`result.summary?.dismissed ?? 0`) plus a real summary derived from the served diagnostics (severity/rule/analyzer rollups, measured `dismissed`, non-derivable fields omitted). The gap this row names is the missing gate: start a daemon against a fixture project, run each shipped command the hook and skill actually invoke (`changed --json`, `changed` plain, `audit`, …), assert exit codes and that a real summary comes back. Whether that becomes a 14th gate is Ben's call, not a spec written here. | `app/src/cli.ts:778` (guarded read), `app/src/cli.ts:1002` (`buildChangedResultFromDiagnostics`) | open |

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

| # | Issue | Where known | Status |
|---|-------|-------------|--------|
| 5 | Spec 63 R1–R3 — emitted-field set, seam-conformance class, dead-spot disposition. | `specs/spec-68-phases-and-declared-inputs.md:597` | open |
| 6 | Spec 64 R1–R3 and R5–R7 — Go function index (R1's gate becomes a `needs.formats` declaration). | `specs/spec-68-phases-and-declared-inputs.md:597` | open |
| 7 | Spec 62 Amendment B R4 — reporting-boundary assertion. | `specs/spec-68-phases-and-declared-inputs.md:597` | open |
| 8 | Board §6.1 — 27 emitted-but-untested rules get behaviour fixtures. | `specs/spec-68-phases-and-declared-inputs.md:597` | done |
| 9 | Board §6.2 — 11 rules never through the authenticity ledger. | `specs/spec-68-phases-and-declared-inputs.md:597` | done |
| 10 | Board §7 — cross-file duplicate detection. | `specs/spec-68-phases-and-declared-inputs.md:597` | open |
| 11 | Board §8 — rule precision (`method-complexity`, `pgx`, `sqlc`, `ent`). | `specs/spec-68-phases-and-declared-inputs.md:597` | open |
| 12 | Board §9 — the API contract surface. | `specs/spec-68-phases-and-declared-inputs.md:597` | open |

### §6.1 & §6.2 — the 27 rules now have behaviour fixtures and ledger rows

Board §6.1 ("27 emitted-but-untested rules get behaviour fixtures") is closed.
The 27 are the 16 schema-JSON rules plus the 11 non-schema-JSON rules, and each
of the 11 has a test asserting it **fires** (produces a finding), not merely that
the area is touched:

- **16 schema-JSON rules** — `jsonSchemaLiveness.spec.ts`, via `analyzeJsonSchemas`,
  "every schema-JSON rule fires".

- **6 data-access rules** (`spec68-data-access-rules.spec.ts`, pure
  `dataAccessRules(ctx)` classification unless noted):
  - `sql-injection-risk` — "flags raw unescaped interpolation as critical"
  - `complex-query` — "flags a query referencing more tables than the joined-table threshold"
  - `unfiltered-query` — "flags a filterless UPDATE as an unfiltered write"
  - `missing-org-filter` — "raw-SQL INSERT that omits the tenant column fires (row would be unscoped)"
  - `hardcoded-connection` — `spec68-hardcoded-connection-parity.spec.ts` (fires via `runSecuritySlice`)
  - `loop-query` — `spec68-loop-query-parity.spec.ts` (fires via `runLoopQueriesSlice`)

- **5 schema-code rules**:
  - `dynamic-sql-construction` — `spec68-dynamic-sql-construction-parity.spec.ts` (fires via `runDynamicSqlSlice`)
  - `table-naming-convention` — `spec68-schema-rules.spec.ts` "flags a camelCase table name"
  - `unknown-table` — `spec68-schema-rules.spec.ts` "flags a reference to a name absent from the catalog"
  - `stale-table-reference` — `spec68-stale-table-reference-parity.spec.ts` (fires via `analyzeSchemaRules`)
  - `too-many-queries` — `spec68-too-many-queries-parity.spec.ts` (fires via `runQuerySitesSlice`)

No rule lacked a fires-assertion; none needed writing.

Board §6.2 ("11 rules never through the authenticity ledger") is closed: all 11
carry a row in `specs/rule-authenticity-ledger.md` (running total 115 rows), and
`registry-ledger-membership.test.ts` pins the bidirectional registry ↔ ledger
membership so a silent re-removal would fail the suite.

### 744 propagation — 846 `db`-rooted unproven sites close list-free

The next spec's candidate fix is **verdict propagation**, not a type-annotation
manifest. On recall-protocol there are **846 `db`-rooted unproven sites**; of
these **787 (93%)** have a `handle`-verdict sibling sharing the same root in the
same file, so a verdict already proven at one site (via its SQL argument) can be
carried to the sibling sites — closing the largest unproven population in the
product with **no list, no manifest, and no type names**. The remaining **59**
are type-only (no handle-verdict sibling), small enough that the type-annotation
seam may never need building. This supersedes the type-annotation manifest as the
candidate fix.

### oracle-shortfalls — how the gate went green (a drift ratchet, re-recorded after two real fixes)

`verify:oracle-shortfalls` is a **drift ratchet, not an absolute shortfall check**:
it pins the `files` / `expected` / `actual` aggregate per (fact-kind, corpus)
and fails on any field change (`compareOracleShortfalls` in
`scripts/verify-oracle-shortfalls-core.mjs`). The `residual` (`expected −
actual`) is derived, never pinned — it is the by-design gap the per-kind
`composition` prose explains. So the gate "failed" on the query-sites / schema-usage
numbers because the measured aggregates no longer matched the pinned baseline,
not because a threshold was exceeded. It is green now through **three causes in
sequence**, and the re-record was legitimate only because the fixes landed first:

1. **Oracle fixed (ddl-declarations only).** `countDdlOps`
   (`src/phase/oracles.ts:254`) counted every `ALTER TABLE` header, including
   `ADD/DROP/ALTER COLUMN` (a column change recorded in `tableColumns`, not as an
   op). The oracle now counts only op-producing statements — `CREATE/DROP TABLE`
   and `ALTER TABLE … RENAME TO`. `expected` dropped 376 → 29 on recall-protocol.
2. **Producer recovered facts (the `-candidates` kinds).** The phase-model
   migration made the producer emit the full candidate set it had been
   under-emitting. recall-protocol `actual`: schema-usage ~1,909 → 17,640 (~9×),
   data-access-calls ~1,848 → 31,074 (~17×). These are recoveries, not drops.
3. **Baseline re-recorded (3e05d10) after the populations were stable**, with the
   fact kinds renamed to `-candidates` (Spec 69 R2) — `query-sites`→
   `query-site-candidates`, `schema-usage`→`schema-usage-candidates`,
   `data-access-calls`→`data-access-calls-candidates`, `loop-queries`→
   `loop-query-candidates` — and a `composition` prose entry filled for all 20
   kinds. The directive "don't re-record until populations established" was
   honored: the re-record pinned the corrected populations, not the pre-fix
   under-emission.

The residual that remains is by design: the oracle is a broad upper-bound
superset (e.g. `countQuerySites` counts every `\.\w+\s*\(` member call plus SQL
keyword occurrences, so recall-protocol query-site-candidates pins
`expected` 58,547 vs `actual` 2,699), while the producer emits only what the
receiver-resolution proves. The gate exists to catch the inverse — a producer
emitting *more* than the oracle, or a corpus drifting under the read-only
contract — not to drive `expected ≈ actual`.

A property of that gate worth naming: a ratchet that fails on **any** change gets
re-recorded routinely, and routine re-recording is how `schema-usage` sitting at
zero on two corpora got through earlier. It catches corpus drift well and
producer regression weakly — the `files`/`expected`/`actual` pins would trip on a
corpus edit under the read-only contract, but a producer that silently stops
emitting a fact kind is only visible if someone inspects the re-recorded baseline
against the `composition` prose, which nothing forces.

### `normalizeStructure` — per-block regex work is irreducible, not a per-file win

`normalizeStructure` maps identifiers→`ID` / literals→`LIT` / keywords intact via
9 global regex replaces plus an identifier callback. It runs **once per extracted
code block**: phase `src/phase/codeBlocks.ts:138` (inside `createCodeBlock`, the
per-block loop at `:163`) and legacy
`src/analyzers/universal/UniversalDRYAnalyzer.ts:679` (the per-block
structural-similarity pass, via `normalizeCodeForStructure` at `:548`).

It is **not hoistable to per-file**: it operates on each block's `normalizeCode`
output (whitespace/comment-stripped, non-length-preserving), which is only
derivable per block, and it feeds a per-block `hashCode`. The one genuine
redundancy is that nested blocks re-normalize overlapping text (a function *and*
its inner loops), so total cost is O(nesting × file) — but the unit cost is small:
the phase `code-block` producer is ~5.9 ms of the ~320 ms gate.

The one fixable inefficiency was already half-fixed: the ~70-entry keyword Set is
hoisted to module scope on the phase path (`codeBlocks.ts:35`,
`STRUCTURE_KEYWORDS`, commit 4700b5b) but the legacy
`UniversalDRYAnalyzer.ts:512` still allocates `const keywords = new Set([…])`
*inside* the identifier callback on every match. A mirror hoist is a one-line
change of low value — the legacy DRY visitor is on the decommissioning path
(board 2d).

### plugin hook — the guard is present; the drift is in the source tree, not the install

The `${CLAUDE_PLUGIN_ROOT}` reference in `plugin/hooks/hooks.json` is **not
unguarded**. All three commands carry an `if [ -z "${CLAUDE_PLUGIN_ROOT}" ]`
guard — PostToolUse exits 1 loudly ("CLAUDE_PLUGIN_ROOT is unset; audit hook did
not run"), SessionStart exits 0 silently (a warm-the-cache nicety must never fail
the session) — and the guard precedes the script invocation so a missing root can
never resolve to an absolute `/scripts/hook-audit.sh`. This is pinned by
`src/plugin-manifest.spec.ts` (52 tests) and `src/__tests__/hookResolver.spec.ts`
(8 tests).

The PostToolUse audit hook **did fire** during the release edits:
`CLAUDE_PLUGIN_ROOT` is set in the Claude Code environment, the guard passes,
`resolve_code_audit` resolves a version-matched CLI, and `code-audit changed`
reported benign "Baseline file has schemaVersion 1" notices — no gating findings
on the release commits.

**Correction (2026-10-05) — the drift direction was inverted.** The installed
`hook-audit.sh` is **ahead** of the source tree, not behind: it carries the
source-file extension-scoping block
(`case "${file}" in *.ts|…|*.scss) : ;; *) exit 0 ;; esac`, dated Sep 21, that
`plugin/scripts/hook-audit.sh` (Sep 5) still lacks. Copying source → installed
would have *removed* the scoping and reintroduced the spurious zero-files audit
on every `.md`/`.txt`/`.yml` edit. At the same time the installed `plugin.json`
and `SKILL.md` are **behind** on version (4.1.0, Sep 23) while the source tree is
5.0.0 (Oct 4). The divergence is two-way and silent — filed as board row 7 below.
The fix is to port the scoping block *into* the source tree so the repo is the
single source of truth again, then reinstall; the version divergence resolves on
that same reinstall. (`hooks.json`, `hook-common.sh`, `hook-self-audit.sh`,
`hook-warm.sh` and the three `skills/*` files are byte-identical.)
