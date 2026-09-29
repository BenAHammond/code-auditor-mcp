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
producer it shadows. There are **17 distinct count functions** serving 51
processor declarations; each is one of two mechanisms:

- **Node-type counts** (15) — `countNodeTypes` / `findNodes` / `goNodeCount`
  count raw tree-sitter nodes of a declared type list. This is a *different
  mechanism* than the producer's semantic extraction: the producer walks the
  same AST but projects, folds, dedups, and filters. A raw node count can never
  be the producer's own predicate, and it carries a real residual (methods
  folded into a class symbol, bare callback arrows skipped, duplicate specifiers
  deduped). These are independent by construction.
- **Text-regex counts** (2) — `countSchemaObjects` and `countDdlOps`. Their
  producers (`extractSchemaObjects`, `extractSchemaCode`) are themselves
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

## Part B — the `none` enumeration

`noOracleProcessors()` enumerates **30** processor declarations that report no
statable oracle, across **5 distinct reasons**. Each reason is quoted verbatim,
then classified against the bar: a reason is *genuine* when no independent
counter exists that would not either (a) re-run the producer's own predicate
(`1 = 1`) or (b) count a raw superset whose residual would drown the break
signal.

| # | reason (verbatim) | processors | verdict |
|---|---|---|---|
| 16 | "the fragments are a classified subset with no raw node of the same kind; counting the raw superset would make the residual ~the whole file and drown the break signal, so the only count of the unit is the producer's own classifier" | `secret-candidates` (ts/tsx/js), `security-candidates` (ts/tsx/js), `data-access-calls` (ts/tsx/js/go), `loop-queries` (ts/tsx/js), `dynamic-sql` (ts/tsx/js) | genuine — the unit is defined by a classifier with no raw-node counterpart; a raw-superset count is a `1 = 1`-adjacent dud (residual ≈ whole file) |
| 6 | "the emitted set is gated by a DB-context provenance walk (passesFileGate); a raw node count would record a false shortfall on every non-DB file, and the only count that respects the gate is the producer's own provenance analysis" | `function-bodies` (ts/tsx/js), `schema-usage` (ts/tsx/js) | genuine — the count depends on a provenance *gate*, not a node; the only counter that respects the gate is the producer's own walk |
| 4 | "emits exactly one fragment per file (null-or-value); a count of 1 against 1 proves nothing and there is no countable unit inside the fragment" | `file-header` (ts/tsx/js), `json-document` (json) | genuine — a per-file null-or-value fragment has no countable unit; `1 vs 1` is the empty oracle |
| 3 | "declarations derive from a union of mechanisms (CSS-in-JS objects, inline styles, Tailwind classes) with no single countable node that corresponds to the emitted declaration" | `style-declarations` (ts/tsx/js) | genuine — the emitted declaration is a union over three source mechanisms with no one node to count |
| 1 | "declarations are extracted by regex over markup source with no AST; there is no countable input feature that corresponds to the emitted declaration" | `style-declarations` (markup) | genuine — markup has no AST at all; the extraction is regex-over-text with no countable node |

**No conversion.** All five reasons survive the bar: the `none` set is exactly
the residue of processors whose unit is defined by a classifier, a provenance
gate, a per-file null-or-value, or a union over source mechanisms — none of
which has an independent counter that is not a `1 = 1` dud or a drowned signal.
The silent-unprovable failure mode is closed not by an oracle but by the
enumeration itself: the run names each `none` processor with its reason, so a
future one added without a reason is a compile/type failure, and one added with
a *bad* reason is visible in this list.

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
