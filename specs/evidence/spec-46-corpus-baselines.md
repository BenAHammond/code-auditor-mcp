# Spec 46 — Corpus Baseline Re-pin (post-3.6.0 analyzer hardening)

Five commits after the 3.6.0 release change *what fires* on real code, so the
Spec 45 baseline is stale:

- `064b013` — post-3.6.0 analyzer hardening: `solid/single-responsibility`
  split into `function-length` + `parameter-count` (#131); `dry/similar-expression`
  default-on (#133); dependency-graph `orphaned-nodes`/`unreferenced-module`
  detection expanded (#124/#125).
- `49eb545` — `secrets` analyzer: `secrets/hardcoded-secret` (critical) (#134).
- `b6c777b` — documentation noise reduction: param/return tag completeness off by
  default, UI-component / Next.js-framework files exempt (#135).
- `c7db3d5` — dependency-graph orphan fix: receiver-dispatched methods (class +
  object-literal) are no longer flagged orphaned. This reverses most of the
  #124/#125 orphan flood; see *Adjudication note*.
- `4e52d20` — dry floor fix: fluent library chains (query/schema builders, Zod,
  commander, promises, DOM/stdlib methods) and language-agnostic test files are
  excluded from `similar-expression`; see *Dry adjudication note*.

This re-pins the six validation corpora and attributes every delta to the named
cause. Measurement is read-only: `runAuditDispatch` (the same entry point the CLI
uses) with `CODE_AUDITOR_DATA_DIR` pointed at `/tmp/ca-corpus-*`, so no index DB,
ledger, or report lands in any corpus. No `.codeauditor.baseline.json` is written
into any reference repo (see *Boundary* at the end).

## Headline — totals

| corpus | stack | Spec 45 baseline | Spec 46 (now) | Δ |
|---|---|---|---|---|
| recall-protocol | TS + SQL | 5,042 | **3,516** | −1,526 |
| knex | TS/SQL builder | 397 | **404** | +7 |
| primer/css | plain CSS | 18 | **23** | +5 |
| blitz | Next.js/TS/React | 898 | **867** | −31 |
| gin | Go | 29 | **29** | 0 |
| svelte-realworld | SvelteKit | 23 | **36** | +13 |

## Named causes

| cause | item | analyzer::rule affected | direction |
|---|---|---|---|
| single-responsibility split | #131 | `solid/single-responsibility` → `function-length` + `parameter-count` | **0** (rename/split only) |
| similar-expression default-on | #133 | `dry/dry/similar-expression` | **+** (new rule fires) |
| similar-expression fluent-chain + test-file exclusion | #133 | `dry/dry/similar-expression` | **−** (fluent API surface + test fixtures excluded) |
| orphan + unreferenced-module | #124/#125 | `dependency-graph/orphaned-nodes`, `dependency-graph/unreferenced-module` | **+** (detection expanded) |
| secrets analyzer | #134 | `secrets/hardcoded-secret` | **+** (new analyzer) |
| documentation noise cut | #135 | `documentation/*` | **−** (param/return off; `.tsx`/`.jsx`/framework exempt) |

The single-responsibility split is count-neutral by construction: `function-length`
(line-count proxy) + `parameter-count` (arity proxy) partition the old
`single-responsibility` findings, so the `solid` analyzer total is unchanged and
only the rule-ID axis moves.

---

## recall-protocol — 3,516 (was 5,042, −1,526)

Per-analyzer:

| analyzer | Spec 45 | now | Δ |
|---|---|---|---|
| solid | 1,032 | 1,032 | 0 |
| documentation | 2,444 | 670 | **−1,774** |
| styles | 560 | 560 | 0 |
| react | 388 | 388 | 0 |
| data-access | 339 | 339 | 0 |
| dry | 6 | 27 | **+21** |
| dependency-graph | 4 | 231 | **+227** |
| conventions | 125 | 125 | 0 |
| schema-code | 95 | 95 | 0 |
| cross-domain | 39 | 39 | 0 |
| schema | 10 | 10 | 0 |

Per-rule (current):

```
solid::function-length                         902
documentation::function-documentation          574
styles::styles/token-bypass                    423
dry::dry/similar-expression                     21
data-access::loop-query                        301
dependency-graph::orphaned-nodes               104
dependency-graph::unreferenced-module          124
react::raw-element                             111
react::no-error-boundary                       103
react::performance                              95
schema-code::too-many-queries                   95
solid::parameter-count                          89
documentation::method-documentation             80
react::complexity                               66
conventions::conventions/usage-pair             60
styles::styles/mechanism-fragmentation          52
conventions::conventions/error-handling         49
styles::styles/undefined-class                  47
data-access::unfiltered-query                   33
solid::solid/method-complexity                  33
cross-domain::cross-domain/read-never-written   21
styles::styles/declaration-set-similarity       21
documentation::class-documentation              16
react::accessibility                            13
conventions::conventions/naming                 10
cross-domain::cross-domain/transaction-boundary 10
schema::unknown-table                           10
styles::styles/mechanism-mixing                  9
cross-domain::cross-domain/written-never-read    8
styles::styles/z-index-singleton                  7
dry::dry/duplicate                               6
conventions::conventions/import-form             5
data-access::sql-injection-risk                  4
solid::solid/dependency-inversion                3
solid::solid/class-size                          3
solid::solid/interface-segregation               2
conventions::conventions/export-shape            1
data-access::complex-query                       1
dependency-graph::tight-coupling                 1
dependency-graph::circular-dependency            1
dependency-graph::hub-nodes                      1
styles::styles/z-index-sprawl                    1
```

**Delta attribution (recall):**

- **documentation −1,774** (#135). `parameter-documentation` 1,024 → 0 and
  `return-documentation` 551 → 0 (tag completeness off by default);
  `function-documentation` 768 → 574 (−194), `method-documentation` 83 → 80 (−3),
  `class-documentation` 18 → 16 (−2) from the `.tsx`/`.jsx`/framework-file
  exemption. A user no longer sees "missing an exhaustive `@param`" or "undocumented
  React component" as a defect; what remains is undocumented *logic* in `.ts`
  service/repo/utility files.
- **dry +21** (#133, re-measured after `4e52d20`). `dry/similar-expression`
  0 → 21 (near-identical clone detection, default-on). The pre-fix count of 303
  was fluent-library noise — Zod validator chains (`string,trim,min,max` ×121,
  `number,int,nullable,default` ×62, …) and stdlib method chains — excluded by
  the fluent-chain guard; see *Dry adjudication note*. All 21 remaining are
  genuine "object built twice" signals (`terminalOutcome` 5-field outcome object,
  `frame` in the build-editor reducer, …). `dry/duplicate` unchanged at 6.
- **dependency-graph +227** (#124/#125, re-measured after `c7db3d5`).
  `orphaned-nodes` 1 → 104 (+103) — down from the pre-fix 139 after receiver-
  dispatched methods stopped being flagged; `unreferenced-module` 0 → 124 (+124).
  The three graph-shape rules (`circular-dependency`, `tight-coupling`,
  `hub-nodes`) are unchanged at 1 each.
- **solid 0** (#131) — `single-responsibility` 991 re-emerges as `function-length`
  902 + `parameter-count` 89. Total unchanged.
- everything else 0.

---

## knex — 404 (was 397, +7)

Per-analyzer:

| analyzer | Spec 45 | now | Δ |
|---|---|---|---|
| dependency-graph | 4 | 20 | **+16** |
| dry | 10 | 1 | **−9** |
| schema-code | 182 | 182 | 0 |
| solid | 137 | 137 | 0 |
| data-access | 41 | 41 | 0 |
| schema | 17 | 17 | 0 |
| cross-domain | 5 | 5 | 0 |
| secrets | — | 1 | **+1** |
| documentation | 1 | 0 | **−1** |

Per-rule (current):

```
dependency-graph::orphaned-nodes         17
schema-code::too-many-queries            181
solid::function-length                    60
solid::solid/class-size                   31
solid::solid/dependency-inversion         20
schema::unknown-table                     17
data-access::hardcoded-connection         16
data-access::unfiltered-query             14
solid::solid/open-closed                  12
solid::solid/interface-segregation         8
data-access::loop-query                    6
solid::parameter-count                     6
data-access::sql-injection-risk            5
cross-domain::cross-domain/read-never-written   4
cross-domain::cross-domain/written-never-read   1
dry::dry/similar-expression                1
dependency-graph::hub-nodes               1
dependency-graph::circular-dependency     1
dependency-graph::tight-coupling          1
schema-code::table-naming-convention      1
secrets::hardcoded-secret                 1
```

**Delta attribution (knex):**

- **dependency-graph +16** (#124/#125, re-measured after `c7db3d5`) —
  `orphaned-nodes` 1 → 17. The pre-fix count of 885 was a receiver-dispatch
  false-positive flood (857 class methods + 11 object-literal mixin methods), not
  a genuine finding about knex's structure; see *Adjudication note*. The three
  graph-shape rules (`circular-dependency`, `tight-coupling`, `hub-nodes`) are
  unchanged at 1 each.
- **dry −9** (#133, re-measured after `4e52d20`) — `similar-expression` 245 → 1
  and `duplicate` 10 → 0. The 245 pre-fix were fluent-library noise (commander
  `command,option,description,action`, promise `then,then,catch`, knex
  query/schema-builder chains) plus 132 expected-output fixtures in
  `test/unit/schema-builder/*.js` that the TS-only test-file patterns missed; the
  fluent-chain guard and language-agnostic test-file exclusion close both. The
  one remaining finding is a genuine production object (`analytic` built twice in
  `lib/query/querybuilder.js`).
- **secrets +1** (#134) — one hardcoded credential flagged in a test/example.
- **documentation −1** (#135) — `parameter-documentation` 1 → 0.
- **solid 0** (#131) — `single-responsibility` 66 → `function-length` 60 +
  `parameter-count` 6.
- everything else 0.

---

## primer/css — 23 (was 18, +5)

Per-analyzer / per-rule (current):

```
styles::styles/z-index-singleton        11
dependency-graph::orphaned-nodes         5
solid::function-length                   3
dependency-graph::tight-coupling         1
dependency-graph::unreferenced-module    1
documentation::function-documentation    1
styles::styles/z-index-sprawl            1
```

**Delta attribution (+5):** `orphaned-nodes` 1 → 5 (+4) and `unreferenced-module`
0 → 1 (+1), both #124/#125 (orphaned re-measured after `c7db3d5`).
`solid/single-responsibility` 3 → `function-length` 3
(#131). `documentation/function-documentation` unchanged at 1 (a `.js` docs-site
helper, not a UI component or framework file).

---

## blitz — 867 (was 898, −31)

Per-analyzer:

| analyzer | Spec 45 | now | Δ |
|---|---|---|---|
| documentation | 465 | 385 | **−80** |
| styles | 192 | 192 | 0 |
| solid | 112 | 112 | 0 |
| react | 82 | 82 | 0 |
| dependency-graph | 4 | 50 | **+46** |
| data-access | 32 | 32 | 0 |
| schema | 4 | 4 | 0 |
| schema-code | 4 | 4 | 0 |
| conventions | 3 | 3 | 0 |
| secrets | — | 3 | **+3** |

Per-rule (current):

```
documentation::function-documentation          190
documentation::method-documentation            161
styles::styles/declaration-set-similarity      161
solid::function-length                          88
dependency-graph::orphaned-nodes                47
react::raw-element                              54
documentation::class-documentation              34
data-access::unfiltered-query                   30
react::no-error-boundary                        16
styles::styles/token-bypass                     16
styles::styles/undefined-class                  15
solid::solid/dependency-inversion               12
react::performance                               9
solid::parameter-count                           9
schema::unknown-table                            4
schema-code::reserved-word                       4
react::complexity                                3
secrets::hardcoded-secret                        3
conventions::conventions/naming                  2
data-access::loop-query                          2
solid::solid/open-closed                         2
conventions::conventions/export-shape            1
dependency-graph::tight-coupling                 1
dependency-graph::circular-dependency            1
dependency-graph::hub-nodes                      1
solid::solid/method-complexity                   1
```

**Delta attribution (blitz, −23):**

- **documentation −80** (#135) — `function-documentation` 250 → 190 (−60),
  `method-documentation` 162 → 161 (−1), `parameter-documentation` 14 → 0 (−14),
  `return-documentation` 5 → 0 (−5); `class-documentation` unchanged at 34.
- **dependency-graph +46** (#124/#125, re-measured after `c7db3d5`) —
  `orphaned-nodes` 1 → 47.
- **secrets +3** (#134).
- **solid 0** (#131) — `single-responsibility` 97 → `function-length` 88 +
  `parameter-count` 9.
- everything else 0.

---

## gin — 29 (was 29, 0)

Routed through the Go subprocess. Unchanged from Spec 44/45:

```
solid::liskov-substitution    11
solid::open-closed             6
solid::dependency-inversion    6
imports::import-organization   4
solid::interface-segregation   2
```

The four post-3.6.0 commits touch the TypeScript universal analyzers and the
dependency-graph index only; the Go analyzer is a separate binary and produces an
identical set. No delta.

---

## svelte-realworld — 36 (was 23, +13)

Per-analyzer / per-rule (current):

```
styles::styles/undefined-class           14
dependency-graph::unreferenced-module    13
documentation::function-documentation     3
styles::styles/z-index-singleton           3
styles::styles/declaration-set-similarity  2
styles::styles/token-bypass                1
```

**Delta attribution (+13):** `unreferenced-module` 0 → 13 (#124/#125). Everything
else unchanged — `styles/undefined-class` 14, `documentation/function-documentation`
3 (`.ts` helpers, not UI components), and the three z-index/declaration/token styles
findings are byte-identical to Spec 44.

---

## Adjudication note — orphaned-nodes at corpus scale

The `+884` knex orphan jump was the largest single movement of this re-pin and was
sampled finding-by-finding before accepting it. It is **not** a genuine finding
about knex's structure — it is the orphan predicate misfiring on receiver dispatch.
The rule treats "no call edges in the name-only call graph" as evidence of dead
code, but a name-only call graph cannot model `this.`/receiver/prototype dispatch:
the reference resolver matches a bare callee (`formatter`) against the full entity
name (`Client.formatter`) and never resolves it, so every unexported method satisfies
the orphan predicate. Concretely, 857 of knex's 885 orphans were class-prefixed
methods (`Client.formatter`, `TableCompiler_SQLite3.output`, …) and a further 11
were object-literal mixin methods (`{ renameColumn() {} }` merged onto a prototype) —
all dispatched dynamically and all live.

`c7db3d5` fixes this by marking `method_definition` entities `isMethod` and skipping
them (class-prefixed names, which also cover Go receiver methods, are skipped by the
`.` guard). Orphaned-nodes after the fix: knex 885 → **17**, recall 139 → **104**,
blitz 55 → **47**, primer 8 → **5**, svelte unchanged.

The residual orphans are the *same* root cause — the name-only call graph is
incomplete — in three further reference forms the rule still cannot model, and are
recorded as a known near-miss (reported faithfully, not suppressed):

1. **CommonJS exports** (knex's remaining 17): `module.exports = { isUndefined, … }`,
   prototype assignment (`SchemaCompiler.prototype.build = build`), and `new` /
   callback references. Every one is verified exported or referenced — knex has no
   dead code, and the rule's true signal on this corpus is nil. Fixing this is
   entangled with CJS `require` import tracking (a partial fix would newly flag
   every CJS file as an unreferenced module).
2. **Top-level script invocation** (recall): `main`, `shutdown`, `dump` entry points
   invoked at module top level or via `package.json` scripts, invisible to a call
   graph keyed on intra-function callees.
3. **JSX component usage** (recall/blitz): `<FieldInput />` is not a call
   expression, so same-file subcomponents (`FieldInput`, `StatPill`, `Sparkline`)
   are flagged orphaned despite being rendered.

The honest conclusion: the orphan rule is a name-only-call-graph *completeness*
heuristic, and its false positives are the reference forms that graph cannot see —
not evidence of dead code. After `c7db3d5` the receiver-dispatch class (the
dominant source) is closed; the remaining categories are documented here rather
than silently suppressed.

---

## Dry adjudication note — similar-expression at corpus scale

`dry/similar-expression` shipped default-on at floor 4 with only read-query
chains (`select`/`selectDistinct`) excluded, on the theory that *mutation* chains
(`update().set().where().returning()`) are the duplication signal. The corpus
measurement disproved that theory: the chains that actually fire are library
fluent APIs, not duplicated domain logic.

- **recall (303)** — Zod validator chains dominate: `string,trim,min,max` ×121,
  `number,int,nullable,default` ×62, `string,min,max,describe` ×20, … plus a few
  stdlib method chains (`split,map,filter,slice`, `replace,replace,replace,trim`).
- **knex (245)** — commander registrations (`command,option,description,action`),
  promise flows (`transaction,then,then,then,then,catch`), knex query/schema-builder
  chains (`insert,onConflict,ignore,testSql`, `integer,unsigned,references,inTable`,
  `where,orderBy,forUpdate,first`), and 132 expected-output fixtures in
  `test/unit/schema-builder/*.js`.

`4e52d20` closes both. The read-query exclusion becomes a fluent-chain guard: any
chain built from a known fluent API verb (query/schema builders, Zod/Valibot,
commander, promises, DOM traversal, stdlib array/string methods) is excluded as
"structurally similar by design". Test-file exclusion is broadened from TS-only to
language-agnostic (`.test.*`/`.spec.*` across TS/TSX/JS/JSX plus `test/`/`tests/`
directories) — knex is a JS library whose tests are `.js` under `test/`, which the
TS-only patterns missed. `__tests__/` is deliberately *not* excluded: this repo
keeps analyzable source fixtures under `__tests__/fixtures/`, and Jest's
`__tests__` files are still `.test.*`/`.spec.*` named.

What survives is the rule's intended signal — a *specific* object literal built
twice for the same target:

- recall's 21: `terminalOutcome` (the 5-field outcome object), `frame` (the
  build-editor reducer's 11-field frame), `gameplayMetrics`, `payload`, `log`, …
- knex's 1: the `analytic` object in `lib/query/querybuilder.js`.

The honest conclusion: the chain half of `similar-expression` fires on fluent API
surface by default, so it is excluded; the object-literal half is where the real
"built twice" signal lives and remains default-on.

---

## Supplementary corpora (not part of the six pinned baselines)

**hhra-org** — tracked specifically for #135 (documentation is the user's stated
concern). `documentation` 1,044 → **159** (−885); total 2,136 → **1,213** (−923).
The −923 is documentation −885 offset by `dry/similar-expression` +5 (#133, after
`4e52d20` cut the fluent-chain noise) and the dependency-graph expansion
(#124/#125); hhra-org has no per-rule "before" record in Spec 44/45, so only the
documentation delta is precisely attributable.

**job-search** — the #134 reference corpus. `secrets/hardcoded-secret` **1** (the
hardcoded `page.type('#password', 'vyy8AUVvish34Fq')`), plus `dependency-graph`
4 (`orphaned-nodes` 3, `tight-coupling` 1). The secrets analyzer flags the known
reference credential as `critical`; the near-miss guard's placeholder/env/fixture
classes stay silent.

## Boundary

Per the repository-boundary constraint, no `.codeauditor.baseline.json` was
written into recall-protocol, knex, primer/css, blitz, the two `bench/real/`
clones, hhra-org, or job-search — they are read-only reference. This file is the
re-pinned record.

The one corpus whose *committed* baseline file remains stale is unchanged from
Spec 44/45's note: `recall-protocol/.codeauditor.baseline.json` (toolVersion
3.4.18, total 4,589) still does not reflect the tool's current 3,516. Re-pinning
that file into recall-protocol requires Ben's authorization (the same rule as
publishing); it is deliberately left untouched here.
