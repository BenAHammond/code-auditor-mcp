# Spec 44 — Corpus Baseline Re-pin (post-remediation)

The rule rework (buckets 1–7 of `rule-remediation-backlog.md`) changes what fires
on real code, so the committed per-corpus baselines are stale. This records the
post-remediation counts for the six validation corpora, attributes every delta to
the named rule change that caused it, and carries the gin/svelte adjudication.

Measurement is read-only: `runAuditDispatch` (the same entry point the CLI uses)
with `CODE_AUDITOR_DATA_DIR` pointed at `/tmp/code-auditor-corpus`, so no index
DB, ledger, or report lands in any corpus. No `.codeauditor.baseline.json` is
written into any reference repo (see *Boundary* at the end).

## Headline — totals

| corpus | stack | pre-remediation | post-remediation | Δ |
|---|---|---|---|---|
| recall-protocol | TS + SQL | 4,589 | **5,042** | +453 |
| knex | TS/SQL builder | 458 | **397** | −61 |
| primer/css | plain CSS | 18 | **18** | 0 |
| blitz | Next.js/TS/React | 975 | **898** | −77 |
| gin | Go | *(no prior baseline)* | **29** | new |
| svelte-realworld | SvelteKit | *(no prior baseline)* | **23** | new |

Pre-remediation values for recall are the committed baseline metadata
(`recall-protocol/.codeauditor.baseline.json`, toolVersion 3.4.18); knex /
primer/css / blitz are the Spec 35 acceptance numbers ("knex 458, primer/css 18,
blitz 975"), which recorded totals only, not per-analyzer.

---

## recall-protocol — 5,042 (was 4,589, +453)

Per-analyzer:

| analyzer | pre | post | Δ |
|---|---|---|---|
| documentation | 2,444 | 2,444 | 0 |
| solid | 1,032 | 1,032 | 0 |
| styles | 157 | 560 | **+403** |
| react | 338 | 388 | **+50** |
| data-access | 339 | 339 | 0 |
| conventions | 125 | 125 | 0 |
| schema-code | 95 | 95 | 0 |
| cross-domain | 39 | 39 | 0 |
| schema | 10 | 10 | 0 |
| dry | 6 | 6 | 0 |
| dependency-graph | 4 | 4 | 0 |

Per-rule:

```
documentation::parameter-documentation   1024
solid::solid/single-responsibility        991
documentation::function-documentation     768
documentation::return-documentation       551
styles::styles/token-bypass               423
data-access::loop-query                   301
react::raw-element                        111
react::no-error-boundary                  103
react::performance                         95
schema-code::too-many-queries              95
documentation::method-documentation        83
react::complexity                          66
conventions::conventions/usage-pair        60
styles::styles/mechanism-fragmentation     52
conventions::conventions/error-handling    49
styles::styles/undefined-class             47
data-access::unfiltered-query              33
solid::solid/method-complexity             33
cross-domain::cross-domain/read-never-written   21
styles::styles/declaration-set-similarity  21
documentation::class-documentation         18
react::accessibility                       13
conventions::conventions/naming            10
cross-domain::cross-domain/transaction-boundary  10
schema::unknown-table                      10
styles::styles/mechanism-mixing             9
cross-domain::cross-domain/written-never-read     8
styles::styles/z-index-singleton            7
dry::dry/duplicate                          6
conventions::conventions/import-form        5
data-access::sql-injection-risk             4
solid::solid/dependency-inversion           3
solid::solid/class-size                     3
solid::solid/interface-segregation          2
conventions::conventions/export-shape       1
data-access::complex-query                  1
dependency-graph::circular-dependency       1
dependency-graph::tight-coupling            1
dependency-graph::hub-nodes                 1
dependency-graph::orphaned-nodes            1
styles::styles/z-index-sprawl               1
```

**Delta attribution (recall), named causes:**

- **styles +403** → bucket 5 `logic` (`styles/token-bypass`): removed the
  `valueType !== 'color'` gate. The rule now fires on *non-color* token
  bypasses (length/spacing/…), not just color tokens. `token-bypass` is 423 of
  the new 560; the other seven styles rules moved from 157 to 137 (net −20, a
  second-order effect of the same gate).
- **react +50** → bucket 7 `decide` (`react/accessibility` +
  `react/performance` rebuilt to per-element JSX detection against the full
  component body): `accessibility` 13, `performance` 95.
- **everything else 0** — the reword (bucket 3), rename (bucket 6), and render
  (bucket 4) changes are message/rendering-only and do not move counts; the
  `missing-org-filter` reimplementation (bucket 1) is count-neutral here because
  recall's queries are all already org-filtered (0 findings before and after),
  and the `solid/liskov-substitution` (TS) rebuild (bucket 7) is count-neutral on
  recall's class hierarchy.

---

## knex — 397 (was 458, −61)

Per-analyzer:

```
schema-code    182
solid          137
data-access     41
schema          17
dry             10
cross-domain     5
dependency-graph  4
documentation    1
```

Per-rule:

```
schema-code::too-many-queries          181
solid::solid/single-responsibility      66
solid::solid/class-size                 31
solid::solid/dependency-inversion       20
schema::unknown-table                   17
data-access::hardcoded-connection       16
data-access::unfiltered-query           14
solid::solid/open-closed                12
dry::dry/duplicate                      10
solid::solid/interface-segregation       8
data-access::loop-query                  6
data-access::sql-injection-risk          5
cross-domain::cross-domain/read-never-written  4
cross-domain::cross-domain/written-never-read  1
dependency-graph::circular-dependency    1
dependency-graph::tight-coupling         1
dependency-graph::hub-nodes              1
dependency-graph::orphaned-nodes         1
documentation::parameter-documentation   1
schema-code::table-naming-convention     1
```

**Delta attribution (knex, −61):** the pre-remediation 458 is a total only
(Spec 35), so this is directional, not per-rule. The movement is explained by the
two rules that changed *what fires* on a TS/SQL corpus: `schema/table-naming-convention`
(bucket 6 logic change — uppercase-proxy → explicit `/^[a-z][a-z0-9_]*$/`) and
`missing-org-filter` (bucket 1 rework — schema-derived tenancy replaces the
hardcoded English `fallbackOrgTables` list). Both remove false positives that the
proxies manufactured on knex's query layer.

---

## primer/css — 18 (was 18, 0)

Per-analyzer:

```
styles            12
solid              3
dependency-graph   2
documentation      1
```

Per-rule:

```
styles::styles/z-index-singleton    11
solid::solid/single-responsibility   3
dependency-graph::tight-coupling     1
dependency-graph::orphaned-nodes     1
documentation::function-documentation 1
styles::styles/z-index-sprawl        1
```

No delta — a plain-CSS corpus is untouched by the Go rework, the TS
`missing-org-filter` rework, and the React rebuilds.

---

## blitz — 898 (was 975, −77)

Per-analyzer:

```
documentation    465
styles           192
solid            112
react             82
data-access       32
dependency-graph   4
schema             4
schema-code        4
conventions        3
```

Per-rule:

```
documentation::function-documentation          250
documentation::method-documentation            162
styles::styles/declaration-set-similarity      161
solid::solid/single-responsibility              97
react::raw-element                              54
documentation::class-documentation              34
data-access::unfiltered-query                   30
react::no-error-boundary                        16
styles::styles/token-bypass                     16
styles::styles/undefined-class                  15
documentation::parameter-documentation          14
solid::solid/dependency-inversion               12
react::performance                               9
documentation::return-documentation              5
schema::unknown-table                            4
schema-code::reserved-word                       4
react::complexity                                3
conventions::conventions/naming                  2
data-access::loop-query                          2
solid::solid/open-closed                         2
conventions::conventions/export-shape            1
dependency-graph::circular-dependency            1
dependency-graph::tight-coupling                 1
dependency-graph::hub-nodes                      1
dependency-graph::orphaned-nodes                 1
solid::solid/method-complexity                   1
```

**Delta attribution (blitz, −77):** total-only pre-remediation value (Spec 35);
directional. The `react/accessibility` + `react/performance` rebuild (bucket 7),
the `missing-org-filter` rework (bucket 1), and the `schema/table-naming-convention`
logic change (bucket 6) are the moving parts on a Next.js React + TS corpus. The
`styles/token-bypass` gate removal (bucket 5) adds here too, but blitz's token
surface is small (16), so the net effect is dominated by the false-positive
removals rather than the addition.

---

## gin — 29 (new corpus; first baseline)

Routed through the Go subprocess. Per-analyzer / per-rule:

```
solid::liskov-substitution    11
solid::open-closed             6
solid::dependency-inversion    6
imports::import-organization   4
solid::interface-segregation   2
```

**Adjudication: 0 false, 29 true-but-useless.** Every finding is idiomatic Go,
not a defect a maintainer would act on:

- `solid/liskov-substitution` (11) — methods genuinely call `panic()` (gin's
  recovery middleware, `MustBindWith`, internal request-abort). The new
  body-walk correctly finds them; the panic/recover pattern is how gin routes
  handler errors, so "fixing" it would break the framework.
- `solid/open-closed` (6) — large `switch` statements (content-type/render
  dispatch); idiomatic.
- `solid/dependency-inversion` (6) — structs holding concrete-typed fields;
  idiomatic.
- `imports/import-organization` (4) — files with >10 imports; idiomatic.
- `solid/interface-segregation` (2) — wide interfaces; idiomatic.

This is the first time gin has run under the reimplemented Go rules. It is the
near-miss guard's positive control at corpus scale: the old name-substring proxies
would have produced a different set; the reimplemented predicates produce the
real panic/switch/concrete-field/import shapes above.

---

## svelte-realworld — 23 (new corpus; first baseline)

Per-analyzer / per-rule:

```
styles::styles/undefined-class           14
documentation::function-documentation     3
styles::styles/z-index-singleton           3
styles::styles/declaration-set-similarity  2
styles::styles/token-bypass                1
```

**Adjudication: 1 true, 8 true-but-useless, 14 false.**

- **TRUE (1)** — `styles/token-bypass`: a hardcoded `max-width: 720px` where the
  design token `--content-width: 720px` exists. A maintainer would act on this.
- **true-but-useless (8)** — 3 `documentation/function-documentation`
  (undocumented helpers), 3 `z-index-singleton`, 2 `declaration-set-similarity`;
  technically correct, no reasonable action follows.
- **false (14)** — all `styles/undefined-class`: 11 `ion-*` classes are the Ionic
  framework's own tokens (not project CSS), 2 are intentional no-style hooks
  (`auth-page`, `settings-page`), and 1 is a `:` ternary mis-parse from
  `class="… {x ? 'a' : 'b'}"`. None is a missing class in project CSS.

This is spec 42's `.svelte` extraction on its first real SvelteKit input; the
51 fabricated-Tailwind-default false positives are gone (see the
token-bypass/bundled-defaults fix), leaving a 1/23 judged-true rate.

---

## The one bug this surfaced (fixed)

`runAuditDispatch`'s `hasFilesWithExtension` walked the target recursively
*without* excluding `node_modules`. Recall carries a single `.go` file inside a
dependency (`flatted`'s golang port), so the router sent a pure-TS project through
the Go polyglot orchestrator — which dropped every non-Go analyzer and collapsed
recall to 3,819 findings across four analyzers. Fixed in `auditRouter.ts`: the walk
now skips `DEFAULT_EXCLUDED_ANY_DEPTH_DIRS` (the same set discovery uses), so the
Go routing decision matches discovery's own view of "are there source `.go` files".

## Boundary

Per the repository-boundary constraint, no `.codeauditor.baseline.json` was
written into recall-protocol, knex, primer/css, blitz, or the two `bench/real/`
clones — they are read-only reference. This file is the re-pinned record.

The one corpus whose *committed* baseline file is now stale is
`recall-protocol/.codeauditor.baseline.json` (toolVersion 3.4.18, total 4,589).
The tool now reports 5,042; until that file is re-snapshotted, a full recall audit
will headline "+453 new" — the token-bypass gate widening and the React rebuild,
not genuinely new debt. Re-pinning that file into recall-protocol requires Ben's
authorization (the same rule as publishing); it is deliberately left untouched
here.
