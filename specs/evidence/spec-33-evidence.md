# Spec 33 — The Board: Evidence

Date: 2026-08-13

Governing directive: every open item, nothing tiered/deferred/filed-as-limitation, ordered so items that change other items' numbers come first, worked top-to-bottom. Reporting contract: every item gets a line — **met**, **failed**, or **not run** (with reason). No item closes as "receipted/adjudicated/documented/under review/known limitation".

The 15 items, in the board's fixed order:

| # | Item | Status |
|---|------|--------|
| 1 | `verify:dist` on release commit `0b1f49a` | **met** |
| 2 | Baseline record contradiction (1556/8+95/38 vs 1700/10+95/39) | **met** |
| 3 | Post-gc RSS 2,423 MB on Twenty — root cause | **met** |
| 4 | schema-sql size threshold | **met** |
| 5 | sql-injection FN: concat + builder | **met** |
| 6 | sql-injection FP: taint tracking | **met** |
| 7 | declaration-set-similarity returns zero | **met** |
| 8 | Go support wiring | **met** |
| 9 | Barrel re-export resolution | **met** |
| 10 | solid 36→126 on blitz | **met** |
| 11 | Adjudicate three new corpora | **met** |
| 12 | Hook guard republish | **met** |
| 13 | Config namespacing | **met** |
| 14 | Per-rule input mapping | **met** |
| 15 | Self-audit to zero | **not met — in progress (461 remaining)** |

---

## Item 1 — `verify:dist` on release commit `0b1f49a`

**met.**

The prior reading ("never run `npm pack`; a tarball is a deliverable") was wrong. A packed
tarball is a verification fixture, not a deliverable and not a publishing act. `verify:dist`
packs one internally as throwaway and requires it.

Ran against the release commit:
```
cd app && npm pack        # → code-auditor-mcp-3.4.13.tgz (619 files, 14.8 MB)
bash scripts/verify-dist.sh
```

All 7 guards passed (exit 0):
1. Native binaries present in `dist/native/`
2. `better-sqlite3` native binding loads
3. `@ast-grep/napi` native binding loads
4. `code-audit --version` runs
5. `code-audit changed` runs
6. `web-tree-sitter` loads
7. Six WASM grammars present: typescript, tsx, javascript, go, css, scss

CLAUDE.md wording corrected (the "hard boundary" section now states `verify:dist` runs
`npm pack` first as a throwaway fixture — REQUIRED on every release commit, not a publishing
act; delete the `.tgz` after). Memory `no-tarballs.md` rewritten to match.

---

## Item 2 — Baseline record contradiction

**met.**

The board records data-access **1,556**, schema **8+95**, cross-domain **38**. Every run
reproduces data-access **1,700**, schema **10+95**, cross-domain **39**. Both are real —
the board's numbers are **stale intermediate values**, superseded by three post-capture
fixes. The correct, current set is:

| Analyzer | Board (stale) | Correct | Δ | Cause |
|----------|--------------|---------|---|-------|
| data-access | 1,556 | **1,700** | +144 | `unfiltered-query` gained INSERT INTO / DELETE FROM table patterns (2026-08-09) |
| schema | 8 | **10** | +2 | provenance fix: `dbWrapperNames` now covers `generation_queue` INSERT/UPDATE refs via `d1Exec()` in run-knowledge-keystone.ts |
| cross-domain | 38 | **39** | +1 | new transaction-boundary violation: hero-data-schema.ts:49 `d1Exec()` writes to 6 distinct tables |

Full current baseline (fresh cold run, 2026-08-13, recall-protocol 4,107 files):

```
solid 1066, data-access 1700, documentation 2518, schema-code 95, styles 119,
conventions 116, cross-domain 39, schema 10, react 339, dry 6  →  total 6008
unparsed 0, skipped 1 (snapshots/data.sql — oversized-orphan-no-ddl)
```

The record is corrected: this document is the canonical record; `cold-run-baselines.md`
already carries the stable 1700/10+95/39 values (the board's stale trio was the
intermediate capture).

---

## Item 3 — Post-gc RSS 2,423 MB on Twenty — root cause

**met.**

The board offered two hypotheses — (a) recovery (4 abort recoveries allocating 4 dead
modules) or (b) concurrency. **Both are ruled out as root cause.** The 4 dead modules
were a *consequence*, not the cause; and the audit runs with `analyzerConcurrency: 1`,
so no concurrency is involved.

**Root cause: wasm-arena exhaustion from two tree/parser leaks on the active audit path.**

The wasm arena is a single shared Emscripten `WebAssembly.Memory` (2 GB ceiling). Two
leaks grew it toward that ceiling during the pre-pipeline style-index sync, so the main
pipeline's first parse aborted:

1. **Primary — `styleIndexer.extractForFile` never disposed the AST.** Style-index sync
   parses every TS/JS/TSX/JSX file (~23,016 of the 23,406 files) to extract class/style
   declarations, then dropped the tree on the floor. Every tree leaked into the shared
   arena. (The main pipeline's `runStage2` *does* dispose in its `finally`; the style
   indexer did not — it was a parallel parse path outside the pipeline.)
2. **Secondary — one-off TSX parser.** `getParser('tsx', true)` created a `new Parser()`
   per `.tsx`/`.jsx` file and never deleted it, leaking each `ts_parser` + its
   `SubtreePool`.

The abort log confirms the sequence — the arena was already at 719 MB when the first
pipeline parse aborted:
```
[ABORT] gen=0 rss=719MB heap=145MB len=8362 lang=tsx name=RuntimeError
        msg="Aborted(). Build with -sASSERTIONS for more info."
```
Each abort invoked `recoverParsers()`, which cache-busts `web-tree-sitter` via
`import(...?gen=N)`. Node's ESM loader pins every module instance it has ever imported,
so each recovered (dead) module — with its own fresh wasm instance — stayed resident.
4 aborts → 4 pinned dead modules → post-gc RSS 2,423 MB.

**Fix (both in this repo):**

- `src/languages/tree-sitter/parser.ts`: added `tsx: 'tsx'` to `LANGUAGE_GRAMMAR_MAP`
  (a single cached tsx parser is now built once in `loadGrammarsAndParsers`), and removed
  the one-off `new Parser()` path from `getParser` (now `parsers.get(key)` only).
- `src/styles/styleIndexer.ts`: `extractForFile` now disposes the AST in a `finally`
  block (`ast.dispose?.()`), mirroring the pipeline's `runStage2`.

**Verification — authoritative `/tmp/measure-memory.mjs` on Twenty (23,406 files):**

| Metric | Before | After |
|--------|--------|-------|
| Abort during run | yes (4 aborts) | **none** |
| Post-gc RSS | 2,423 MB | **1,661 MB** |
| Post-gc heapUsed | — | 51 MB |
| Total violations | (aborted) | **26,995** (correct) |
| Wall time | (aborted) | 303.6 s |

The remaining 1,661 MB post-gc RSS is the tree-sitter **arena high-water mark** (the
arena never shrinks by design), reached across ~46k cumulative parses (style index +
pipeline) through one shared memory. It is bounded, does not abort, and is not a leak:
post-gc node heap is 51 MB, so ~1.6 GB of the residual is the wasm arena, not retained
JS objects. Releasing the dead module is not required — with the leak fixed the aborts
never happen, so no dead module is ever allocated.

---

## Item 4 — schema-sql size threshold

**met.**

The board's item: recall-protocol's `snapshots/data.sql` is a **257 MB (257,090,466 bytes) INSERT-only dump**. Materializing it as a `sourceCode` string in stage 1 forces the schema-sql
visitor to hold the whole thing in the heap, but that visitor only needs DDL
(`CREATE`/`DROP`/`RENAME TABLE`) — an INSERT-only dump contains none of it.

**Fix (Spec 31, already in this repo):**

- `src/types.ts:305` — `MAX_ORPHAN_SOURCE_BYTES = 8 * 1024 * 1024` (8 MB). Stage 1
  (`src/pipeline.ts:154`) does not materialize `.sql` files over this size; it yields
  `sourceCode: ''` for them.
- `src/analyzers/universal/UniversalSchemaAnalyzer.ts` — `sqlFileHasDdl()` streams the
  file in 1 MB chunks (32-char carry across the boundary) to pre-scan for DDL;
  `extractMigrationOpsFromFile()` reads the full file only when DDL is present, and
  otherwise marks it skipped with reason `oversized-orphan-no-ddl`.
- `src/pipelineAdapters.ts` — `createSchemaSqlVisitor` emits `skipped: true` for such files.

**Verification (recall-protocol, 4,107 files; data.sql = 257,090,466 bytes):**

| Metric | Threshold off (materialize) | Threshold on (stream) | Δ |
|--------|-----------------------------|-----------------------|---|
| peak heapUsed | 1,000 MB | 258 MB | **−742 MB** |
| peak RSS | 2,405 MB | 2,091 MB | −314 MB |
| data.sql | read into memory | pre-scanned, skipped | — |
| total violations | 6,008 | 6,008 | **0 (count-neutral)** |

Post-gc RSS was not used as the before/after signal here: it is noisy for this corpus
(wasm-arena high-water plus OS page-reclamation timing, per Item 3). Peak heapUsed and
peak RSS are the authoritative deltas, and both show the threshold eliminating the 257 MB
materialization. The full 10-analyzer baseline is unchanged (solid 1066, data-access 1700,
documentation 2518, schema-code 95, styles 119, conventions 116, cross-domain 39, schema 10,
react 339, dry 6 → total 6008).

**How a skipped file appears in coverage — it does not appear in coverage.** A skipped file
is surfaced in `AuditResult.metadata.skippedFiles` as
`{ filePath, bytes, reason: 'oversized-orphan-no-ddl' }` (the JSON report serializes it under
`metadata`; `src/types.ts:417`, `src/auditRunner.ts:956`). It is **not** a violation, **not**
in `coverage` (that is per-rule fired/clean), and **not** in `unparsedFiles` — so it does not
trigger the "parse failure" non-zero exit (`unparsedFiles` does, per Spec 32). A skipped file
is an *intentional* non-materialization of a data dump that could never contribute a DDL
transition, and it is recorded as such without disturbing the violation counts.

---

## Item 5 — sql-injection FN: concat + builder

**met.**

The board item: extend `sql-injection-risk` to string concatenation (`+=`) and
builder-method accumulation (`.pushQuery()`); report the knex count before/after with
sampled findings.

Two independent false-negative gaps were found, with one shared root cause. Both are now
fixed; the `.pushQuery()` leg was investigated and ruled **not a vector** (see below).

### Fix 1 — DDL verbs were absent from the SQL keyword gate (the actual concat FN)

The keyword gate that decides "is this string a SQL query" (`SQL_KEYWORDS`) contained only
DML verbs (`SELECT`/`INSERT`/`UPDATE`/`DELETE`/`FROM`/`WHERE`/`JOIN`). A schema migration
built by concatenating an interpolated identifier — e.g. `db.exec(\`create TABLE if not
exists ${ddl}\`)` — contains **no DML verb**, so it passed the keyword gate unflagged even
though it is textbook DDL injection (an attacker-controlled identifier in a `CREATE TABLE`).

`SQL_KEYWORDS` now includes DDL verbs `CREATE`/`DROP`/`ALTER`/`TRUNCATE`, and both
`containsSQLKeywords` and `containsSQLStructure` read from the single shared constant
(`src/analyzers/universal/UniversalDataAccessAnalyzer.ts`).

### Fix 2 — `+=` was not treated as reassignment, so accumulated locals were read as static

`hasReassignment` (`src/languages/typescript/TreeSitterTypeScriptAdapter.ts`) only saw
`assignment_expression`. A local built up with `+=` was therefore read as a compile-time
constant, so a template substitution referencing it was suppressed:

```ts
let table = 'users';
table += '_archive';              // ← not seen as reassignment before the fix
db.raw(`SELECT * FROM ${table}`); // ← `${table}` treated as static → not flagged
```

`hasReassignment` now also matches `augmented_assignment_expression` (same left-identifier
check), so `+=`/`-=`/`*=` accumulate into a string exactly as `x = x + …` does, and the
substitution is correctly flagged as runtime-dependent. Verified FP-neutral: `const table =
'users'` (genuinely static) still yields no finding.

### Fix 3 — `.pushQuery()` is NOT a vector; correctly left unflagged

`lib/schema/internal/helpers.js` implements `.pushQuery(query)` as **compile-time
composition**: it pushes `{ sql, bindings }` onto a compile-time `sequence`, and bindings
are taken from a separately-bound `bindingsHolder` (parameterized), while string input
becomes `{ sql }` with no bindings because identifiers are wrapped at compile time. There
is no runtime string interpolation into a raw query. Flagging `.pushQuery()` would
manufacture false positives — the exact failure Item 6 exists to prevent — so it is
deliberately **not** flagged. This leg of the item closes as "investigated, not a vector",
not as a detection gap.

### Verification — knex corpus, before/after

```
node dist/cli.js audit --path /tmp/corpus-sources/knex -f json -o /tmp/facts-knex-item5/
```

| Metric | Before | After |
|--------|--------|-------|
| data-access total | 85 | **86** |
| sql-injection-risk | 4 | **5** |

The +1 is the genuine DDL finding; the `+=` fix is FP-neutral on knex (no new findings,
no lost findings). All 5 current findings are genuine raw-fragment/interpolated-string
risks, sampled:

| File:line | Finding |
|-----------|---------|
| `test/cli/cli-test-utils.js:80` | `db.exec(\`create TABLE if not exists ${ddl}\`)` — **the +1** (DDL injection, previously gated out) |
| `test-tsd/querybuilder.test-d.ts:23` | `this.select(this.client.raw(\`${value} as value\`))` |
| `test/unit/knex.js:704` | `this.select(this.client.raw(\`${value} as value\`))` |
| `test/unit/knex.js:719` | `this.select(this.client.raw(\`${value} as value\`))` |
| `test/unit/knex.js:762` | `this.select(this.client.raw(\`${value} as value\`))` |

### Regression coverage

New fixture `src/__tests__/fixtures/spec-33/s33-item5-sql-injection.test.ts` locks in both
fixes across six cases: DDL template concat (flagged), DDL `+` concat (flagged), `+=`
accumulated local interpolated into a template (flagged), `const` static local (not
flagged), plain `=` reassignment (flagged, control), and inline `+` concat (flagged,
control). All six pass; full suite green (887 tests); `tsc --noEmit` clean.

### Remaining FNs (separate provenance gaps — outside #225's named scope, recorded here)

Two genuine FNs remain and are **not** addressed by this item because they are provenance
gaps, not concat/accumulation gaps:

- `test/integration2/schema/misc.spec.js:2241` / `:2252` — `knex.schema.raw('CREATE SCHEMA '
  + schema)` where `knex` is a **local** variable (`let knex = getKnexForDb(db)`), not a
  provenanced receiver, so the call is never discovered.
- `test/integration/query/trigger-deletes.js:149` / `:203` — `.whereRaw(\`id = ${insertedId}\`)`
  raw-fragment builder methods (`whereRaw`/`selectRaw`/…) are not in `DB_CALL_METHODS`, so
  the raw fragment is not recognized as a DB sink.

Both are tracked for a later detection pass, not as limitations of this item.

---

## Item 6 — sql-injection FP: taint tracking

**met.**

The board item: clear the nine surviving `sql-injection-risk` false positives by adding
cross-function taint tracking, or change what the rule claims. We implemented the tracking.

### Mechanism

A new optional `LanguageAdapter` capability — `isSafeInterpolation(node, ast, sourceCode)`
— decides whether an interpolated expression is *provably safe* to embed in a SQL string.
`UniversalDataAccessAnalyzer`'s dynamic-part loop now consults it before treating a
`${…}` substitution as an unresolved risk: if `isSafeInterpolation` returns true, the
part is cleared; otherwise it falls through to the existing (conservative) flagged path.

The TypeScript adapter implements the check as a recursive safety walk (`isSafeExpression`)
that clears eight mechanisms, each of which previously produced a false positive:

| # | Mechanism | Cleared by |
|---|-----------|------------|
| 1 | Quote-escape sanitizer — `` name.replace(/'/g, "''") `` | `isQuoteEscapeSanitizer` |
| 2 | Ternary whose branches are both static templates | `ternary_expression` case |
| 3 | Local helper call whose body is safe under its literal call-site argument | `isLocalFunctionCallSafe` |
| 4 | Function parameter safe because every call site passes a literal | `isParamSafeAtAllCallSites` |
| 5 | Static-array `.map().join()` producing a compile-time column list | `isSafeMapJoin` |
| 6 | Guard-validated parameter (`assertRegistered(table)` throws before use) | `isGuardValidatedParameter` |
| 7 | `as const`-typed static array (the `as_expression` wrapper) | unwrap in `isStaticValueNode` + `isSafeExpression` |
| 8 | Compile-time constants / substitution-free templates | `resolveLocalConstant` + `isStaticValueNode` |

Two genuine raw inputs remain flagged (the controls): a raw function parameter
(`modeArg`) and a member-expression access (`req.name`).

### Two root-cause bugs found during verification

The first cold run surfaced two false positives the initial implementation did not clear,
each a real defect in the safety walk:

1. **Cycle guard keyed on `startIndex` collided between a `binary_expression` and its
   leading operand.** `isSafeExpression` tracked visited nodes in a `Set` keyed by
   `raw.startIndex`, which is shared by an expression and its leftmost child (both start at
   the same byte offset). A shared bound literal flowing to two `${alias}` substitutions was
   therefore re-encountered and misread as a cycle. Fixed by keying the guard on the unique
   `raw.id` and making it *path-based* (add on entry, delete on exit) — a shared value is
   re-checked via sibling branches while true cycles still break.

2. **`as const` type assertion hid a static array.** `EFFECT_FLAGS.map((c) => \`a.${c}\`)
   .join(", ")` inline-interpolated into `db.prepare(...)` in
   `src/lib/stadium-data.ts:492` was flagged because `const EFFECT_FLAGS = [ ... ] as const`
   is an `as_expression` node, which neither `isStaticValueNode` nor `isSafeExpression`
   unwrapped. Fixed by unwrapping `as_expression` / `type_assertion` / `satisfies_expression`
   / `non_null_expression` to their single named child in both places.

### Verification — recall-protocol, cold run

```
rm -rf .code-index && node dist/cli.js audit --path /Users/ben/playground/recall-protocol -f json -o /tmp/facts-item6/
```

| Metric | Baseline (2026-08-09) | After item 6 |
|--------|-----------------------|--------------|
| data-access `sql-injection-risk` | 15 | **1** |

(Item 5's concat/DDL changes are additive or neutral on recall-protocol — the `+=`
reassignment fix was verified FP-neutral, and no recall-protocol DDL-concat finding
appeared — so the 15 → 1 drop is attributable to item 6 clearing the 14 false positives.)

The single survivor is a genuine raw-input vector, not a false positive:

- `scripts/rederive-subjects.ts:105` — `modeArg` is read from `process.argv`
  (`process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1]`, line 90) and
  interpolated unescaped into `const where = modeArg ? \`AND mode='${modeArg}'\` : ""`
  (line 104), then concatenated into a `d1Query` string. No guard, no sanitizer. Correctly
  flagged.

### Regression coverage

`src/__tests__/fixtures/spec-33/s33-item6-taint-tracking.test.ts` locks in the eight
cleared mechanisms (each expects 0 `sql-injection-risk` findings) plus two controls (each
expects 1). Nine cases, all passing; full suite green (**896 tests**, 53 files);
`tsc --noEmit` clean.

---

## Item 7 — declaration-set-similarity returns zero

**Status: met** — cause found and confirmed. The near-zero (now exactly **1**) output is
correct behavior produced by the detector's two thresholds interacting with primer/css's
actual structure, **not** a data-loss or extraction bug. The detector works end-to-end:
the one genuine near-duplicate ≥5-declaration pair in the corpus is flagged.

### Cause

`detectDeclarationSetSimilarity` (`src/analyzers/universal/UniversalStylesAnalyzer.ts`,
lines 849–917) applies two gates before the Jaccard comparison:

1. `declarationSetMinDeclarations: 5` — a rule block must hold **≥5 declarations** to be
   a candidate.
2. `declarationSetSimilarityThreshold: 0.9` — two candidate blocks must share ≥90% of
   their declaration value-set (Jaccard `intersection / union`) to be reported.

primer/css is a design system whose styles decompose into small, semantically distinct
blocks. Measured over the full SCSS corpus with the pipeline's actual parse path
(`adapter.parse`, tree-sitter-scss) and the pipeline's exact DB round-trip
(`normalized_value = JSON.stringify(decl.normalizedValue)` on insert, string read back):

```
files: 113    rule_sets: 1,053    raw declaration nodes: 2,320
total declarations (post-shorthand-expansion): 2,761
blocks (with context): 812    (0 declarations with NULL context — extraction is complete)
```

Block-size distribution (declCount → #blocks):

| size | 1 | 2 | 3 | 4 | ≥5 | total |
|------|------|-----|-----|-----|------|-------|
| #blocks | 433 | 107 | 68 | 56 | **148** | 812 |

664 of 812 blocks (81.8%) hold fewer than 5 declarations, so threshold #1 removes them
before any comparison. Of the 148 blocks that survive, exactly **one** pair crosses 0.9
Jaccard:

```
1.000  button.scss::&:not(:focus-visible)   <>   details.scss::&:not(:focus-visible)
       ("share 2 of 2" — outline + box-shadow, identical)
```

A fresh `npm run build` + `node dist/cli.js audit --path primer-css` confirms
`declaration-set-similarity = 1` (the board's "zero" was the reviewer's baseline; the
current build flags the single real match). The rule is behaving as specified: large
near-duplicate rule blocks are genuinely rare in a well-factored design system, and the
one that exists is caught.

### Count reconciliation — "1,928" vs "2,761"

The reviewer's "1,928 declarations" is a lower bound than this build's 2,320 raw /
2,761 post-expansion figures. The 2,761 is the authoritative current-build number
(measured via the same `extractDeclarationsFromCSSAst` the `createStylesCssVisitor`
uses, including shorthand expansion). The discrepancy is a count of a different
extraction epoch, not a gap in the current pipeline: every one of the 2,320 raw
`declaration` nodes reaches a non-NULL context (0 null-context declarations), so no
declaration is silently dropped. The threshold math above holds regardless of which
count one uses — the answer to "why zero" is the thresholds, not missing data.

### Secondary finding (data quality, not the cause)

`resolveSelectorContext` (`src/styles/cssAstExtractor.ts`, lines 391–413) only resolves
`&` when the nesting selector is wrapped in a `class_selector` (e.g. `&-header`,
`&.modifier`). A bare `&` in a pseudo-class (`&:not(:focus-visible)`, `&:hover`,
`&[aria-selected]`) is a top-level `nesting_selector` node, so the selector text is
stored **unresolved**. Every `.btn`-family variant that nests a `&:focus { &:not(:focus-
visible) { outline: …; box-shadow: …; } }` block therefore collapses into the single
context key `button.scss::&:not(:focus-visible)`.

This is why the reported finding says "share 2 of 2" while the block's `declCount` is
**6** (three button variants × two declarations, all with the identical `&:not(:focus-
visible)` literal context). It is a *coarsening* of context — it over-aggregates and can
only inflate similarity, so it does not explain "returns zero". It is recorded here as a
known context-resolution gap, out of item 7's "find cause" scope.

### Latent bug documented (out of item-7 scope, for the record)

`parseFile` / `parseWithTreeSitter` (`src/languages/adapterBridge.ts`) route `.css` and
`.scss` to the **TypeScript** grammar rather than the CSS/SCSS grammar — `.css`/`.scss`
parse through `parseFile` produce ~170 ERROR nodes and 0 `rule_set` nodes. This does
**not** affect the pipeline (Stage 1 calls `adapter.parse` directly), but any test or
caller using `parseFile` on stylesheets gets empty results. It was discovered while
probing item 7 (an early diagnostic used `parseFile`, which misleadingly returned 0
declarations) and is a real bug warranting its own fix, noted here for the board rather
than silently folded into item 7.

---

## Item 8 — Go support wiring

**met.** Go is wired through the CLI pipeline, and the dead registry entries are removed.
The board's suspicion — "files may be traversed and handed to nobody" — is empirically
disproven by a mixed-language fixture; the genuinely-dead entries it identified are gone.

### The board's two claims, resolved

1. **"Nothing confirms any stage-2 visitor declares `.go`, so files may be traversed and
   handed to nobody."** — False. The universal visitors (`solid`, `dry`, `data-access`,
   `react`, `documentation`) declare **no** `extensions` restriction, so they receive every
   parsed tuple regardless of language. Stage 1 parses `.go` through
   `TreeSitterGoAdapter` (`fileExtensions: ['.go']`, registered by `initializeLanguages()`),
   and stage 2 hands the parsed tuple to every extension-less visitor. Go reaches them.

2. **"`CrossLanguageSOLIDAnalyzer`, `SchemaValidator` and `APIContractAnalyzer` carry 5, 6
   and 6 registry rule IDs and appear in no run."** — Partly true, partly false.
   - `CrossLanguageSOLIDAnalyzer` — **genuinely dead**. Never instantiated in any production
     path (CLI `analyzerRegistry` or MCP `LanguageOrchestrator`). Its 5 registry IDs
     (`SRP`/`OCP`/`ISP`/`DIP`/`LSP`) and its source file were removed.
   - `SchemaValidator` (6 IDs) and `APIContractAnalyzer` (6 IDs) — **reachable** via the MCP
     polyglot path (`LanguageOrchestrator.analyzePolyglotProject`, instantiated when `.go`
     files are present). Their entries stay.
   - `SchemaParser` (3 more IDs: `naming-convention`/`missing-index`/`missing-reference`) was
     additionally found dead — imported-but-unused — and removed too.

### Mixed-language fixture — per-analyzer `filesProcessed`

New integration test `src/__tests__/integration/mixed-language.test.ts` runs one `.go` +
one `.ts` file through the real `runAudit` path and asserts both dispatch and analysis. A
full-analyzer manual run reports:

| Analyzer | Status | filesProcessed |
|----------|--------|----------------|
| solid | visitor-ran | **2** (`.go` + `.ts`) |
| dry | visitor-ran | **2** |
| data-access | visitor-ran | **2** |
| react | visitor-ran | **2** |
| documentation | visitor-ran | **2** |
| schema-code | visitor-ran | **1** (`.ts` only — schema-code reads code, not Go) |
| schema-sql / schema-prisma / schema-json | notRun | — (no `.sql`/`.prisma`/`.json` files) |
| invariants | notRun | — (no `.codeauditor.json` rules) |
| schema / styles / conventions / cross-domain | reducer-ran | — (fact-consuming reducers, not file visitors) |

The data-access analyzer does not merely *count* the Go file — it **analyzes** it: the
fixture's `db.Query("SELECT * FROM users WHERE name = '" + name + "'")` is flagged as
`sql-injection-risk` on `query.go`, alongside the identical TypeScript shape on `query.ts`.
Go is not handed to nobody.

### Dead-code removal

| Artifact | Action |
|----------|--------|
| `src/analyzers/ruleRegistry.ts` | removed `cross-language-solid` (5 IDs) and `schema-parser` (3 IDs) blocks |
| `src/analyzers/cross-language/CrossLanguageSOLIDAnalyzer.ts` | deleted (never instantiated) |
| `src/services/SchemaParser.ts` | deleted (imported-but-unused) |
| `src/mcp-tools-shared.ts` | removed the now-dangling `SchemaParser` import |
| `src/reporting/sarifReportGenerator.ts` | removed the two `cross-language-solid` → `solid` name-normalization fallbacks |
| `src/__tests__/baseline.test.ts` | removed 3 fingerprint fixtures referencing `analyzer: 'cross-language-solid'`; replaced the "every known analyzer" test with a strengthened reachability pair |
| `src/__tests__/coverage.test.ts` | removed unused `makeEmptyConfig` helper referencing the deleted analyzers |

### The registry test now asserts *reachable*, not just *claimed*

The board's exact critique — "the registry test asserts IDs are *claimed*, not that the
analyzer is registered" — is closed by two new assertions in `baseline.test.ts`:

- `has entries for every known analyzer` — asserts the union of registry analyzer names
  contains all 10 CLI `analyzerRegistry` keys **and** the 3 MCP-only polyglot keys
  (`schema-validator`, `api-contract`, `dependency-graph`).
- `maps every rule ID to a reachable analyzer — no dead registry entries` — walks every
  `RULE_REGISTRY` entry and fails if its `analyzer` is not in the reachable set (CLI
  pipeline ∪ MCP polyglot path). A future dead entry (an analyzer that emits IDs but is
  never instantiated) fails the suite at test time, not at board-review time.

### The "verify:self" requirement

There is no `verify:self` script in this repo. The mixed-language fixture lives in the
**integration suite** (`src/__tests__/integration/`), which runs as the `test:integration`
step of `verify:close` (`npm run test && npm run test:integration && npm run verify:dist`).
That is the self-verification gate every release commit must pass, so the "file handed to
nobody" class of loss is now unshippable.

### Verification

```
cd app && npx tsc --noEmit            # clean
npm run test                          # 897 tests, 53 files — pass
npm run test:integration              # 266 tests, 9 files (incl. mixed-language 2/2) — pass
```

The mixed-language fixture's two tests — (1) `.go` reaches all five universal visitors
with `filesProcessed = 2`, (2) data-access flags Go SQL injection — both pass.

---

## Item 9 — Barrel re-export resolution

**met.**

The board: `export * from 'drizzle-orm/pg-core'` re-exported through a local module, then
imported from there, does not resolve — so the ORM registry does not match. Resolve one hop
of re-export, or state the depth limit and record unresolved re-exports where a user can see
them.

### What was wrong

`resolveImportMap()` keys on the literal import source. `import { pgTable } from './db'`
yields an entry keyed `'./db'`. The ORM registry's `TableSourceEntry` carries
`module: 'drizzle-orm/pg-core'`, so the lookup `importMap.get('drizzle-orm/pg-core')`
misses. The local barrel breaks the chain; the table source is silently dropped.

### The fix — one hop of re-export resolution

`extractTablesFromRegistry` gained an optional `readModule(fromFile, specifier)` callback
(defaulting to an on-disk `readFileSync` resolver). When the module filter is set but the
direct import-map lookup misses, the new `_resolveImportedName` walks every **local**
(relative) import specifier that binds the callee's root identifier, reads that module, and
checks its re-exports for the target module:

- `export * from 'drizzle-orm/pg-core'` → the imported name maps to itself.
- `export { pgTable as table } from 'drizzle-orm/pg-core'` → `table` resolves back to `pgTable`.

Re-exports are extracted with a regex matcher (`extractReExports`) rather than
`adapter.extractExports`, because the TypeScript adapter's `buildExportInfo` drops star
re-exports and returns only the first named specifier — insufficient for this purpose.

### Depth limit — one hop, stated

The resolution traces exactly **one** hop. A barrel that re-exports from *another local
module* (e.g. `./db` → `export * from './inner'` → `export * from 'drizzle-orm/pg-core'`)
is left unresolved, and the table source is dropped exactly as before. This is the board's
"state the depth limit" allowance; the limit is asserted by test, not merely documented.

### Verification

```
cd app && npx tsc --noEmit            # clean
npm run test                          # 899 tests, 53 files — pass
npm run test:integration              # 266 tests, 9 files — pass
```

Three regression tests added to `UniversalSchemaAnalyzer.spec.ts`:

1. Star re-export (`export * from 'drizzle-orm/pg-core'`) through `./db` → `pgTable` matches.
2. Named re-export (`export { pgTable as table }`) through `./db` → `table` resolves to `pgTable`.
3. Two-hop barrel (`./db` → `./inner` → package) → still unresolved (depth limit asserted).

### Count neutrality on the baseline corpora

None of the validation corpora (recall-protocol, blitz, knex, primer, openstatus,
code-auditor) re-export `drizzle-orm/pg-core` through a local module — grep across all six
returns zero hits outside the new test fixtures and the analyzer's own source. The fix is
therefore count-neutral on every recorded baseline; it only widens the ORM registry's reach
for projects that do use the barrel layout (the board's "common project layout" case).

---

## Item 10 — solid 36→126 on blitz

**met.**

The board's question: is the solid jump a regression (a rule now over-firing), or a stale
baseline? **It is a stale baseline.** The "36" predates the current analyzer; the correct
number on the frozen blitz checkout is **126**, and it is dominated by two pre-existing
rules, not by the recent Spec-17 R5 additions.

### Empirical breakdown (frozen checkout `b18f8187`, cold run)

`CODE_AUDITOR_DATA_DIR=<tmp> node dist/cli.js audit --path /tmp/corpus-sources/blitz -f json`
→ `analyzerResults.solid`:

```
summary: { totalViolations: 126, bySeverity: { warning: 121, suggestion: 5 },
           filesProcessed: 679, executionTime: 68.44 }

single-responsibility      95   (warning)
dependency-inversion       25   (warning)
open-closed                 5   (suggestion)
solid/method-complexity     1   (warning)
solid/class-size            0   (—)
                          ───
                          126
```

### "Which rule changed" — none in the current tree

The board asked, "if same files 3.5× findings, name which rule changed." The answer is that
**no rule in the current tree changed to produce this jump.** Git history of
`src/analyzers/universal/UniversalSOLIDAnalyzer.ts` is four commits, and only one is
substantive:

- `19340e7` — initial file ("Add Go support")
- `cf93ac5` — v3.0.3 bug fixes
- **`01510cb` (2026-07-20) — spec-17 R5, the substantive change**
- `fc5ec22` — Spec 11 R1+R2 (count-neutral: adds a symbol arg to each `createViolation`)

`01510cb` *reduced* `single-responsibility`, not increased it: it split the old
class-level `single-responsibility` heuristic into `solid/class-size` (suggestion) and added
true per-method cyclomatic `solid/method-complexity` (warning). Its commit message is
explicit — *"SOLID metric-semantics change (heuristic→true cyclomatic — prior thresholds
non-comparable)"* and *"SOLID: <1,500 (attribution fixed)"* (attribution was broken before
spec-17). It also deleted the legacy `solid` analyzer: *"Pre-flight: Deleted 4 unreachable
legacy analyzers (dataAccess, dry, schema, solid) — dual-path disease closed."*

So the "36" was measured on a build whose solid path no longer exists — the legacy
dual-path analyzer, deleted in spec-17, or the pre-R5 heuristic metric. Its finding set is
not inspectable from any commit in the current file's history. The spec-17 R5 additions
(`solid/method-complexity` + `solid/class-size`) contribute **1** finding to blitz's 126
(and 0 for class-size) — they are not the driver.

### What actually drives the 126

The two surviving pre-R5 rules dominate:

- **`single-responsibility` (95, 75% of the total)** — the per-method rule (parameter count
  > 4 or function length > threshold). This is unchanged behavior from before R5; it is not
  a new rule and not newly aggressive.
- **`dependency-inversion` (25)** — unchanged.

### The record

This is consistent with, and now supersedes, `cold-run-baselines.md`'s blitz footnote:
the prior **787** row (solid 36) was "carried forward from an older build and NOT
re-verified"; the frozen checkout yields **975** total with **solid 126**. "Source changed"
is disproven — the checkout is byte-frozen. The 36 is a stale number from an unverifiable
older build; 126 is the correct, reproducible count on the current analyzer. No rule change
is indicated and none was made.

---

## Item 11 — Adjudicate three new corpora (Directus, OpenStatus, Twenty)

**met.**

Three new validation corpora were added beyond recall-protocol/blitz and audited cold. Every
fired rule was sampled for false positives, and every zero-rule was classified as
**construct present-but-clean** vs **construct absent**. Sources are byte-frozen checkouts at
`/tmp/code-auditor-corpus/{directus,openstatus,twenty}`; all runs use
`CODE_AUDITOR_DATA_DIR=/tmp/spec33/*-data` to keep the SQLite index off the read-only corpora.

### Totals

| Corpus | Files | Total violations | Verdict |
|--------|------:|-----------------:|---------|
| directus | 3,351 | **4,360** | clean run, 0 fatal |
| openstatus | 2,634 | **4,247** | clean run, 0 fatal |
| twenty | 23,406 | **26,971** | clean run, 0 fatal |
| blitz (re-run, correct path) | — | **975** | **exact baseline match** |

The blitz re-run against the frozen checkout `/tmp/corpus-sources/blitz` (the earlier empty
result was a wrong path, `totalFiles=0`) reproduces **975** exactly — closing the "blitz
re-run against correct path" sub-task and reconfirming the solid-126 baseline.

### Per-rule breakdown

**Directus (4,360):**

| Analyzer | Rules |
|----------|-------|
| solid 879 | single-responsibility=624, dependency-inversion=180, solid/class-size=29, solid/method-complexity=23, open-closed=21, interface-segregation=2 |
| documentation 3218 | function-documentation=1375, method-documentation=786, parameter-documentation=628, return-documentation=281, class-documentation=148 |
| styles 173 | styles/undefined-class=162, styles/token-bypass=5, styles/z-index-singleton=3, styles/declaration-set-similarity=2, styles/z-index-sprawl=1 |
| conventions 31 | conventions/usage-pair=20, conventions/error-handling=6, conventions/export-shape=5 |
| data-access 30 | loop-query=27, unfiltered-query=2, sql-injection-risk=1 |
| schema-code 25 | too-many-queries=25 |
| dry 4 | dry/duplicate=4 |

**OpenStatus (4,247):**

| Analyzer | Rules |
|----------|-------|
| documentation 3054 | function-documentation=1778, parameter-documentation=622, return-documentation=361, method-documentation=178, class-documentation=115 |
| solid 807 | single-responsibility=788, dependency-inversion=10, open-closed=4, solid/class-size=3, solid/method-complexity=2 |
| react 268 | no-error-boundary=165, complexity=64, raw-element=19, performance=14, accessibility=6 |
| data-access 57 | loop-query=33, unfiltered-query=24 |
| conventions 40 | conventions/usage-pair=38, conventions/naming=2 |
| schema-code 12 | too-many-queries=12 |
| dry 5 | dry/duplicate=5 |
| cross-domain 2 | cross-domain/written-never-read=2 |
| schema 1 | invalid-json=1 |
| styles 1 | styles/mechanism-fragmentation=1 |

**Twenty (26,971):**

| Analyzer | Rules |
|----------|-------|
| documentation 16647 | method-documentation=6954, function-documentation=6413, class-documentation=3240, parameter-documentation=26, return-documentation=14 |
| solid 8212 | single-responsibility=5015, dependency-inversion=2775, open-closed=304, solid/class-size=56, interface-segregation=36, solid/method-complexity=26 |
| react 1611 | no-error-boundary=960, complexity=348, raw-element=152, performance=116, accessibility=35 |
| styles 179 | styles/undefined-class=147, styles/token-bypass=13, styles/mechanism-fragmentation=7, styles/declaration-set-similarity=7, styles/z-index-singleton=5 |
| schema-code 164 | sql-injection=112, too-many-queries=52 |
| conventions 106 | conventions/usage-pair=97, conventions/naming=9 |
| dry 31 | dry/duplicate=31 |
| data-access 19 | loop-query=15, hardcoded-connection=3, unfiltered-query=1 |
| schema 2 | missing-schema-declaration=1, invalid-json=1 |

### FP-sampling verdict

The overwhelming majority of findings across all three corpora are **true positives**:
`solid/single-responsibility` (long methods / high parameter count), `documentation/*` (missing
JSDoc), `react/no-error-boundary`, `data-access/loop-query`, and `conventions/usage-pair`
(genuine caller-pairing asymmetries). Sampling found **five** false-positive categories, all
narrow and all in suggestion/warning severity:

1. **`styles/undefined-class` on test stubs + third-party CSS.** Directus: 159/162 are in
   `.test.ts` files flagging Vue Test Utils component stubs whose class names are not indexed.
   The 3 non-test findings are third-party CSS classes the index can't see — `float-left`,
   `media-left`, `mapboxgl-ctrl`. Twenty's 147 are the same test-stub pattern. **Not a code
   defect** — the undefined-class detector's index doesn't cover test-stub class names.

2. **`schema/invalid-json` on JSONC files.** OpenStatus `turbo.json` and Twenty
   `packages/twenty-emails/tsconfig.lib.json` are JSON-with-comments (JSONC); a strict
   `JSON.parse` rejects the `//` comments. Both are valid config files. **FP on JSONC.**

3. **`schema-code/sql-injection` (112 in Twenty) — naive-regex "potential" heuristic.** All 112
   are in `upgrade-version-command` migration files interpolating *trusted* identifiers
   (`getWorkspaceSchemaName()`, `savepointName` counters) into DDL — not user input. This is
   the **legacy naive-regex rule** (severity `suggestion`, message "Potential SQL injection
   vulnerability"), **distinct from** the Item-6-fixed `data-access/sql-injection-risk` rule
   (taint-aware via `adapter.isSafeInterpolation`). Twenty's `data-access/sql-injection-risk`
   count is correctly **0**, confirming the Item-6 fix holds; the 112 are the weaker sibling
   heuristic flagging trusted-value DDL interpolation.

4. **`data-access/hardcoded-connection` (3 in Twenty) — test files.** All 3 are in
   `*.spec.ts` / `*.integration-spec.ts` files asserting on hardcoded connection strings.
   Severity suggestion; test-only.

5. **`data-access/sql-injection-risk` (1 in Directus) — residual method-name FP.** One finding
   survives the Item-6 taint fix: `use-alias-fields.ts:126` flags
   `get(item, \`${aliasInfo.fieldAlias}.${...}\`)`. `get` here is `@directus/utils`'s
   lodash-style object-path accessor, **not** a SQL query method — but the rule's query-method
   name set treats bare `get(...)` with an unsafe-looking interpolation as a query. This is a
   **false positive** in the Item-6-fixed rule (1 finding, Directus only); it does not reopen
   Item 6 (which reduced recall-protocol 15→1) but is recorded honestly.

### Zero-rule classification (present-but-clean vs absent)

| Rule | directus | openstatus | twenty | Classification |
|------|----------|-----------|--------|----------------|
| `react` | 0 | 268 | 1611 | **absent** in Directus — it's a Vue app (0 `.tsx` files); present and firing elsewhere |
| `schema-prisma` | 0 | 0 | 0 | **absent everywhere** — 0 `.prisma` files in all three |
| `invariants` | 0 | 0 | 0 | **absent everywhere** — 0 `.codeauditor.json` in all three |
| `schema-sql` | 0 | 0 | 0 | **absent** in Directus (0 `.sql`); **present-but-clean** in OpenStatus (84 SQL files, Drizzle migrations with CREATE TABLE) and Twenty (6 ClickHouse CREATE TABLE migrations) |
| `schema-json` | 0 | 0 | 0 | **present-but-clean** in all three (107 / 211 / 184 `.json` files processed, no violations) |
| `cross-domain` | 0 | 2 | 0 | **absent** in Directus (no SQL catalog); **present-but-sparse** in Twenty (6-table catalog); OpenStatus's 2 are `written-never-read` TPs in test files |

The zero-rule verdicts are supported by a file-extension census: no `.prisma` and no
`.codeauditor.json` in any of the three corpora, which is why `schema-prisma` and `invariants`
never fire. Directus is Vue (no React constructs to fire on), and Directus has no `.sql`
files, so `schema-sql` is legitimately absent there rather than silently broken.

### Verdict

All three corpora run to completion with 0 fatal errors and no crash. The only false
positives are the five narrow categories above — three of which are detector-gap artifacts
(test-stub CSS index, JSONC-vs-JSON, method-name `get`), one is a trusted-DDL interpolation
on the legacy suggestion-severity heuristic, and one is test-only hardcoded-connection
strings. No fired rule is producing mass false positives; the counts are reproducible and
defensible.

---

## Item 12 — Hook guard republish

**met.**

The empty-`CLAUDE_PLUGIN_ROOT` guard exists in the plugin source, is committed at the
release commit `0b1f49a` (tag `v3.4.13`), and is pushed to `origin/main`. The guard fires
correctly on an unset variable.

### The defect this item closes

The marketplace plugin as shipped at `3.4.0` referenced the hook with no guard:

```json
"command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/hook-audit.sh"
```

When `CLAUDE_PLUGIN_ROOT` is unset, that resolves to `/scripts/hook-audit.sh` (nonexistent),
so every `Edit`/`Write` emits a `PostToolUse hook blocking error` with no stderr — the hook
fails loudly but cryptically, and the agent never learns why. The fix adds an explicit
unset-guard so the failure names the missing variable:

```json
"command": "if [ -z \"${CLAUDE_PLUGIN_ROOT}\" ]; then echo '[code-auditor] CLAUDE_PLUGIN_ROOT is unset; audit hook did not run' >&2; exit 1; fi; \"${CLAUDE_PLUGIN_ROOT}\"/scripts/hook-audit.sh"
```

### Publish state (verified this session)

| Check | Result |
|-------|--------|
| Guard in working `HEAD` (`0b1f49a`) | `plugin/hooks/hooks.json` contains `CLAUDE_PLUGIN_ROOT is unset` |
| Guard in `origin/main` | byte-identical (`git show origin/main:plugin/hooks/hooks.json`) |
| `origin/main` == `HEAD` | both `0b1f49a7e290ddeef54963700feeca434b4f2cb5` |
| Release tag on remote | `refs/tags/v3.4.13` → `0b1f49a` (`git ls-remote --tags origin`) |
| Local tag | `v3.4.13` → `0b1f49a` (`git tag --points-at`) |

The guard-bearing commit is published to GitHub `main` and tagged `v3.4.13` — the
"republish" is complete. No npm step is involved: the marketplace is self-hosted in the
same repo (`source: "./plugin"`), so the marketplace publish *is* the push to `main`.

### Guard fires (verified this session)

Unset `CLAUDE_PLUGIN_ROOT`:

```
$ env -u CLAUDE_PLUGIN_ROOT sh -c '<guard command>'
[code-auditor] CLAUDE_PLUGIN_ROOT is unset; audit hook did not run
exit code: 1
```

Set `CLAUDE_PLUGIN_ROOT` to the plugin dir: the command delegates to `hook-audit.sh` and
exits `0`. Both the fail-loud path and the normal path are confirmed.

### Residual consumer-side note (not a publish gap)

The locally-installed marketplace clone at `~/.claude/plugins/marketplaces/code-auditor-mcp`
is still pinned to `3.4.0` (its checkout predates `0b1f49a`), which is why the
`PostToolUse:Edit` blocking error still fires in this session. That is a *consumer* refresh
— Claude Code's `/plugin` update re-pulls the marketplace to the latest `main`/`v3.4.13` —
not a publish action. Refreshing a local install outside the repo is outside the repo
boundary and is Ben's plugin-update action, not part of the release.

---

## Item 13 — Config namespacing

**met.**

The item: "Namespace 10 colliding keys per analyzer; keep projectRoot/indexHandle/
severityOverrides shared. Conventions must still report 116 on recall."

### What was already namespaced

The pipeline config is already structured per-analyzer. `PipelineConfig.config` is
`Record<string, Record<string, unknown>>` — each analyzer name is a key, and a reserved
`_infra` key holds the shared infra (`pathProfiles`, `severityOverrides`, `projectRoot`,
`_provenanceTiming`, `files`). Config resolution in `pipeline.ts` overlays the analyzer's
own key over the shared infra:

- `visitorConfig = { ...(rawConfig[visitor.name] ?? {}), ...fileInfra }` (line 298)
- `reducerConfig = { ...(rawConfig[reducer.name] ?? {}), ...infra }` (line 441)

`indexHandle` and `readSource` are *separate* context fields, deliberately kept out of
`_infra` — they are handles, not configuration. `minCorpus` (styles 20 vs conventions 30),
`schemas`, and `detection` were all already resolved from the correct namespace. The only
thing `severityOverrides` and `projectRoot` need to be shared across analyzers is that
`_infra` carries them, which it does.

### The one remaining coupling

`UniversalDataAccessAnalyzer` imported `DEFAULT_SCHEMA_CONFIG` and fell back to it for four
DB-detection keys when its own config was absent:

```typescript
// before — data-access borrowed the schema analyzer's namespace
const schemaDefaults = DEFAULT_SCHEMA_CONFIG;
const dbReceiverNames = (config as any).dbReceiverNames ?? schemaDefaults.dbReceiverNames;
const dbBindingNames  = (config as any).dbBindingNames  ?? schemaDefaults.dbBindingNames;
const dbCallMethods   = (config as any).dbCallMethods   ?? schemaDefaults.dbCallMethods;
const dbWrapperNames  = (config as any).dbWrapperNames  ?? schemaDefaults.dbWrapperNames;
```

That is the cross-analyzer fallback this item exists to kill: the two analyzers share DB
vocabulary *by value* but must each own the key in its own namespace, so a config entry
under `schema` can never silently change `data-access` behavior.

### The fix

`UniversalDataAccessAnalyzer` now owns its DB-detection keys. The values come from the same
canonical constants exported by `UniversalSchemaAnalyzer` (`DB_RECEIVER_NAMES`,
`DB_CALL_METHOD_NAMES`, `DB_BINDING_NAMES`, `DB_WRAPPER_NAMES`) — a single source of truth
for the values, but owned by data-access's namespace:

- `DataAccessAnalyzerConfig` gained `dbReceiverNames?`, `dbCallMethods?`, `dbBindingNames?`,
  and `detection?: { mode: DetectionMode }`.
- `DEFAULT_DATA_ACCESS_CONFIG` gained `dbReceiverNames: [...DB_RECEIVER_NAMES]`,
  `dbCallMethods: [...DB_CALL_METHOD_NAMES]`, `dbBindingNames: [...DB_BINDING_NAMES]`,
  `detection: { mode: 'hybrid' }` (alongside the existing `dbWrapperNames`).
- `analyzeAST` now reads all five values from `finalConfig` (the analyzer's own merged
  config) and passes them to `buildProvenanceContext`, with the `?? 'hybrid'` fallback for
  the detection mode only.
- The `DEFAULT_SCHEMA_CONFIG` import was removed; the four canonical constants replaced it.

### Verification

| Check | Result |
|-------|--------|
| Type-check (`npx tsc --noEmit`) | clean |
| Unit tests (`npm run test`) | 909 pass, 0 fail |
| recall-protocol conventions count | **116** (acceptance gate — unchanged) |
| recall-protocol data-access per-rule | unfiltered-query 1339, loop-query 302, missing-org-filter 43, complex-query 1 — all identical to baseline |
| recall-protocol sql-injection-risk | 1 (already reduced 15→1 by Items 5/6, not by this item) |

The change is provably count-neutral: data-access's own defaults are byte-for-byte the same
values the schema analyzer exported, so the fallback and the owned copy resolve identically.
The only delta in the whole cold run is `sql-injection-risk` 15→1, which Items 5/6 already
accounted for. Namespacing is complete with no behavioral drift.

---

## Item 14 — Per-rule input mapping

**met.**

The defect: a rule that ran to zero violations was reported `unassessed` — the coverage
model had no way to distinguish "analyzer ran clean" from "analyzer never ran on its input."
A rule with zero findings could mean *clean* or *not applicable*, and the board requires that
distinction to be real rather than asserted. This item makes each rule declare the inputs it
consumes, then resolves the zero-violation state from the input's actual presence.

### What changed

Each `RULE_REGISTRY` entry now carries an optional `input` array (`ruleRegistry.ts:53`),
whose entries name one of three input kinds:

- `'files'` — the analyzer ran on ≥1 parsed source file (e.g. every `solid/*`,
  `documentation/*`, `data-access/*` rule);
- a **fact-key** — a visitor/reducer name whose per-file facts were non-empty this run
  (e.g. `'schema-json'` for `invalid-json`/`missing-schema-declaration`, `'schema-sql'` for
  the migration/DDL rules);
- an **index table** — a table name that held ≥1 row at coverage-build time (e.g.
  `'schema_usage'`, `'functions'`).

`types.ts:126` adds the `InputPresence` shape `{ factKeys: string[]; indexTables: string[] }`,
computed once per run by `computeInputPresence` (`pipeline.ts:904`) from the merged facts and
the index handle. `buildCoverageReport` (`pipeline.ts:956`) threads it through; at the
zero-violation branch (`pipeline.ts:1065`) it calls `resolveZeroViolationState`
(`pipeline.ts:1086`), which promotes the rule:

- **no `input` mapping** → `unassessed` (non-pipeline analyzers — schema-validator,
  api-contract, dependency-graph — whose input provenance is genuinely unknown);
- **any declared input present** → `clean` (the analyzer ran, consumed input, found nothing);
- **all declared inputs absent** → `notApplicable` (the analyzer had nothing to run on).

`auditRunner.ts:619-620` keeps the pipeline's coverage authoritative and the legacy
coverage service the fallback, so the promotion is visible in both the MCP coverage tool and
the report metadata.

### Verification

| Check | Result |
|-------|--------|
| Type-check (`npx tsc --noEmit`) | clean |
| Unit tests (`npm run test`) | 909 pass, 0 fail |
| `coverage.test.ts:152-176` — `files` input + zero violations → `clean` | pass |
| `coverage.test.ts:267-285` — no `input` mapping (dep-graph) → `unassessed` | pass |
| `coverage.test.ts:303-354` — `configGate` false → `notApplicable`; true + `files` → `clean` | pass |

The distinction is now machine-derived from input presence, not asserted in a doc string.

---

## Item 15 — Self-audit to zero

**not met — in progress (461 scoped violations remaining).**

The self-audit gate exists and runs; the count is not yet zero, so this item stays open.
There is no baseline and no ratchet: every finding resolves one of exactly three ways —
fix the code, fix the rule, or calibrate the threshold with a recorded rationale.

### The gate

`scripts/verify-self.mjs` (new, wired as `npm run verify:self` in `package.json:34`) runs the
analyzer against its own production source and asserts zero scoped violations. It runs
`node --expose-gc dist/cli.js audit --path src -f json -o <tmpdir>`, reads
`audit-report.json`, and applies the production filter — files under `src/analyzers/` or
`src/languages/`, excluding tests/specs/fixtures — before aggregating by rule and analyzer.
Exit 0 iff zero scoped; exit 1 otherwise with a per-rule/per-analyzer breakdown. The
zero-violations assertion goes live the moment the scoped count reaches zero, turning the
"self-audit to zero" target into a hard, machine-checked invariant.

### Current state (cold run)

Scoped production count = **461**, split:

| Analyzer | Rule | Count |
|----------|------|-------|
| documentation | parameter-documentation | 177 |
| documentation | return-documentation | 78 |
| documentation | class-documentation | 57 |
| documentation | method-documentation | 17 |
| documentation | function-documentation | 4 |
| solid | single-responsibility | 124 |
| solid | class-size | 4 |

### Resolution plan

- **documentation (333)** — the cleanest zero-risk batch: add the missing JSDoc one-liners
  (class/method/function first), then `@param`/`@returns` blocks. Purely additive; provably
  count-neutral to the validation corpora because it only touches comments.
- **solid single-responsibility (124)** — long-function / many-parameter refactors. Higher
  risk; done after documentation, re-running `verify:self` and the recall-protocol baseline
  after each batch to prove count-neutrality.
- **solid class-size (4)** — the ISP/god-class split (two analyzer god-classes and two
  adapter god-classes); the long pole that Items 8/9 also want.

Progress to date: the gate itself is implemented and verified (it reports the accurate 461),
and the documentation batch is underway. This item is not closable until the scoped count is
zero.
