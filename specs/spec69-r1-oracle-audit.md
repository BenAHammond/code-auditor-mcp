# Spec 69 R1 — oracle audit

The completeness oracle (Spec 69 R1) has two correctness requirements beyond
"every processor declares one":

1. **Independence** — an oracle must count a *different feature* than its
   producer. R1's prose states it directly: the oracle "is not a framework and
   it is not shared." An oracle that reuses the producer's own regex proves
   `1 = 1` and measures nothing; it can never disagree, so it can never report a
   producer regression.
2. **Honest `none`** — a processor with no statable oracle reports that it has
   none, named, with a reason that is a genuine impossibility (no independent
   counter exists) and not merely an absence of an obvious one.

This document records the audit of both.

---

## Part A — independence audit of the counted oracles

Every counted oracle was audited for whether it shares a predicate with the
producer it shadows. There are **24 count functions** serving 73 processor
declarations; each is one of two mechanisms:

- **Node-type counts** (21) — `countNodeTypes` / `findNodes` / `goNodeCount`
  count raw tree-sitter nodes of a declared type list. This is a *different
  mechanism* than the producer's semantic extraction: the producer walks the
  same AST but projects, folds, dedups, and filters. A raw node count can never
  be the producer's own predicate, and it carries a real residual (methods
  folded into a class symbol, bare callback arrows skipped, duplicate specifiers
  deduped). These are independent by construction.
- **Text-regex counts** (3) — `countSchemaObjects`, `countDdlOps`, and
  `countDynamicSql`. Their producers (`extractSchemaObjects`,
  `extractSchemaCode`, `collectDynamicSqlCandidates`) are themselves
  regex-based, so the oracle's regex must be a *different* feature than the
  producer's regex.

The audit found exactly **two 1 = 1 offenders**, both text-regex oracles that
imported and re-ran the producer's own regex constant:

| oracle | shared predicate | the defect |
|---|---|---|
| `countSchemaObjects` | `ORM_OBJECT_RE` (`schemaObjects.ts`) | counted the producer's own binding regex — `count` and `measured` could never disagree |
| `countDdlOps` | `DDL_RE` (`analyzers/universal/schema/migrations.ts`) | counted the producer's own DDL regex — `count` and `measured` could never disagree |

Both were rewritten to count a **different feature of the same input**:

| oracle | now counts | why it upper-bounds the producer |
|---|---|---|
| `countSchemaObjects` | every `pgTable`/`mysqlTable`/`sqliteTable` **call site** (`ORM_BUILDER_CALL_RE`) | the producer emits one fact per `const <id> = <builder>('name', …)` *binding*; a builder call not bound to a `const` (`export default pgTable(…)`, a table returned from a helper) is a positive residual |
| `countDdlOps` | every CREATE/DROP/ALTER **TABLE header** (`DDL_HEADER_RE`) | the producer emits one op per CREATE/DROP/ALTER-RENAME; an `ALTER TABLE … ADD COLUMN`/`ADD CONSTRAINT` header (recorded in `tableColumns`, not as an op) is a positive residual |

The shared constants were un-exported (`ORM_OBJECT_RE`, `DDL_RE`) so the
`1 = 1` import path is closed at the type boundary — the oracle can no longer
compile against the producer's predicate.

The remaining 15 node-type oracles were already independent (raw node count vs
semantic extraction). One comment was corrected to match the measurement:
`countCssDeclarations` documented itself as "exact," but the producer projects
only `rule_set`-scoped declarations (skipping `@keyframes`/`@font-face`/`@page`),
so it is an upper bound with a real residual — the comment now says so.

---

## Part B — the `none` enumeration and the upper-bound correction

`noOracleProcessors()` enumerates **8** processor declarations that report no
statable oracle, across **3 distinct reasons**. This is the result of a
re-examination that converted 22 of the original 30 `none` declarations to
coarse upper-bound oracles; the 8 that remain are the genuine residue.

### The correction — "no exact counter" is not impossibility

The original audit classified 30 declarations `none`, largely on the ground that
"no exact counter exists." That was the wrong bar. `countCssDeclarations` is the
precedent: it was corrected from "exact" to "upper bound" and kept, because an
oracle that *over-counts* is still an oracle — the aggregate gate pins the
residual (`expected − actual`), and a movement in `actual` is the regression
signal. "Drowned signal" is only true when the residual genuinely swamps any real
movement, and that is a *measurement*, not a judgement.

Re-examining the 30 against the upper-bound bar converted **22**:

| converted reason | processors | new oracle | residual (the over-count) |
|---|---|---|---|
| classified subset with no raw node of the same kind | `secret-candidates` (ts/tsx/js) | `countSecretCandidates` = `string`+`template_string` nodes | strings outside a credential position (the bulk of a file's strings) |
| classified subset | `security-candidates` (ts/tsx/js) | `countSecurityCandidates` = `call_expression`+`template_string` | calls/templates that are not security-relevant |
| classified subset | `data-access-calls` (ts/tsx/js/go) | `countDataAccessCalls` = `call_expression`+`template_string` | non-DB calls/templates |
| classified subset | `loop-queries` (ts/tsx/js) | `countLoopQueries` = loop nodes | loops whose body issues no DB call |
| classified subset | `dynamic-sql` (ts/tsx/js) | `countDynamicSql` = `query(`/`execute(` call sites | safe/parameterized query/execute calls |
| DB-context gate | `function-bodies` (ts/tsx/js) | `countFunctionBodies` = function node types | functions in non-DB-context files (the gate is the producer's, not the count's) |
| DB-context gate | `schema-usage` (ts/tsx/js) | `countSchemaUsage` = `call_expression`+`string`+`template_string` | strings/calls/templates naming no table reference |

Each is independent of its producer's predicate (a raw node-type or source-text
count, never the producer's classifier) and each over-counts by design. The
measured residuals are large but structural — e.g. `data-access-calls` counts
95,724 call/template nodes against 1,848 resolved DB calls on recall-protocol —
and are pinned in `bench/baselines/oracle-shortfalls.json` with a per-kind
`composition` note. A producer regression (any movement in `actual`) still shows,
because the residual is *pinned*, not part of the signal.

### The 8 that remain `none` — and why

The correction is not "everything converts." The 8 remaining are the cases where
the bar is genuinely unmeetable, and each reason now states *which direction* the
cheap count goes wrong:

| # | reason | processors | verdict |
|---|---|---|---|
| 4 | "emits exactly one fragment per file (null-or-value); there is no partial-extraction failure mode to guard, so a count of 1 against 1 is the empty oracle" | `file-header` (ts/tsx/js), `json-document` (json) | genuine — a per-file null-or-value fragment has no countable unit whose movement would signal a partial extraction |
| 3 | "declarations are the expansion of a union of source mechanisms (Tailwind utility classes, inline-style object pairs, CSS-in-JS templates); Tailwind-utility and shorthand expansion make the emitted count exceed any cheap count of source features, so every cheap count under-bounds and would never fire a shortfall" | `style-declarations` (ts/tsx/js) | genuine — the producer *expands* source features (Tailwind `expandUtility`, `expandShorthand`), so every cheap source count is an *under*-bound, not an upper bound: it could never report `actual < expected` and is therefore a dead oracle |
| 1 | "declarations are extracted by regex over markup source with no AST and are the expansion of class/style/block mechanisms; Tailwind-utility and shorthand expansion make the emitted count exceed any cheap count of source features, so every cheap count under-bounds and would never fire a shortfall" | `style-declarations` (markup) | genuine — the same under-bound argument over regex-extracted markup with no AST |

The key distinction: the converted 22 are cases where a cheap count is an
*over*-count (an upper bound — a real shortfall still shows), while the remaining
8 are cases where a cheap count is either an *under*-count (style expansion makes
`actual` exceed any cheap source count, so the oracle can never fire) or an
*empty* oracle (per-file null-or-value with no countable unit). An under-bound
and an empty oracle are genuinely impossible, and the reasons now state which one
each is.

---

## Part C — criterion 4 (aggregate shortfall gate)

The per-(fact-kind, corpus) aggregate residual is pinned and wired:

- `scripts/verify-oracle-shortfalls.ts` — measures per-file `oracleShortfalls`
  from `runPhaseModel`, aggregates per fact kind (merging formats), SKIPs absent
  corpora (exit 0), fails exit 1 on drift. `--record` bootstraps the baseline.
- `scripts/verify-oracle-shortfalls-core.mjs` — the pure `compareOracleShortfalls`
  (failure branch only, so a liveness test exercises it without the corpus).
- `bench/baselines/oracle-shortfalls.json` — the pinned aggregates, each fact
  kind carrying a `composition` note recording what its residual is composed of.
- `src/__tests__/gate-liveness.test.ts` — `verify:oracle-shortfalls — liveness`
  exercises the moved-counter / missing / unexpected branches.
- `package.json` — `verify:oracle-shortfalls` wired into `verify:close`.

The pinned residuals are large and structural by design (e.g. `batch-functions`
counts every function-like node against the ~0–21 functions that actually hold a
`.batch(`/`.transaction(` call). That is not missing input — the `composition`
note says so — it is the gap between a deliberately-dumb upper bound and the
producer it shadows, and it is exactly what a moved number should catch.
