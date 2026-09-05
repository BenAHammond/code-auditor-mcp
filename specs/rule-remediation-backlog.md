# Spec 44 — Rule Remediation Backlog

The forward spec that the 105 rules should have had before they existed. Derived one-to-one from the authenticity ledger (`specs/rule-authenticity-ledger.md`): every `gap` cell here is that document's `gap` pulled forward as an acceptance criterion. The ledger says what each rule *does*; this says what to *do about it*.

## Decision criterion (the one judgment call, stated up front)

For a rule whose honest version needs new machinery (`decide` bucket), **build it iff both** hold:

1. **It would catch a defect a human reviewer would act on** — a real bug or a real architectural invariant, not a stylistic nit.
2. **The honest inputs are tractable** — either the pipeline already produces them or they can be added without a new subsystem (type checker, taint engine, cohesion graph).

**Cut or keep-as-renamed otherwise.** A heuristic that fires on legitimate code is a false-positive generator, not a guard — `missing-org-filter` (the one dishonest TS rule, which produced 43 false positives on recall) is the reference case: its proxy wasn't a rough version of the truth, it was a *different claim wearing the same name*. Any `decide` rule that behaves that way is cut, not kept.

This axis is vetoable. Pick a different one and the `decide` column re-sorts; nothing else in this document changes.

## Cost classes

| class | what it means | count |
|---|---|---|
| `rework` | dishonest — build the real predicate; the proxy is a different claim | 4 |
| `report` | cannot-fire — emit an explicit "rule is broken in the tool" diagnostic, do not delete | 10 |
| `reword` | overclaim — claim less; predicate is already sound | 7 applied, 9 already-honest |
| `render` | overclaim — emit data that is computed then discarded | 9 |
| `logic` | small logic change, not a reword — separate commit + attribution | 1 |
| `rename` | crude — rename to what is actually measured (always, cheap) | ~14 |
| `decide` | crude — invest in the real implementation or cut (criterion above) | ~11 |

## Vocabulary: `cannot-fire` ≠ `notApplicable`

These must not share a bucket.

- **`notApplicable`** — "this corpus has no input for me." Correct, expected, varies by project. (e.g. no Go files → Go rules report notApplicable.)
- **`cannot-fire`** — "this rule is broken in the tool." Same on every project, every run. It is a standing finding about the analyzer, and it must read that way rather than disappearing into a per-project "nothing to see here."

Reporting (not removing) preserves the record that a rule was written against extraction that never existed — the exact record whose absence let the Go analyzer ship name-substring checks as "done."

---

## Bucket 1 — `rework` (4 dishonest)

Build the predicate the ID claims. All four are bridgeable per the ledger; the Go three are directly available in `go/ast`.

| rule | current proxy | real predicate |
|---|---|---|
| `solid/liskov-substitution` (Go) | `"panic"` in function name/doc-comment | walk body for `*ast.CallExpr` to `panic`; only fire when the method overrides an interface/embedding |
| `errors/error-handling` (Go) | name contains `handle`/`check`/`validate`/`verify` | errcheck-style walk: `x, err := …` where `err` is unchecked |
| `goroutines/concurrency` (Go) | name contains `go`/`async`/`concurrent` | `*ast.GoStmt` present, and no `sync.WaitGroup`/channel handoff |
| `missing-org-filter` (TS) | English `fallbackOrgTables` list + org-column substring | schema tenancy knowledge + parse the WHERE predicate; delete `fallbackOrgTables` |

Acceptance for each: the old proxy no longer exists, and a near-miss test (`panic` helper *named* `panic` but not panicking, a `go` variable, `handleX` that drops an error, a table named `users` that is legitimately un-tenanted) produces no finding.

## Bucket 2 — `report` (10 cannot-fire)

Wire each to an explicit `cannot-fire` diagnostic naming *why*: the specific extractor and the specific field it never populates. Not `notApplicable`; not deleted.

| rule | reason it cannot fire |
|---|---|
| `api-type-mismatch` | `extractEndpoints` never populates `responseSchema`/`expectedResponseType`/`deprecated` |
| `missing-endpoint` | gated via `FABRICATED_API_CONTRACT_RULES` — name-proxy URL/method |
| `api-extra-field` | no emission site |
| `api-missing-field` | no emission site |
| `method-mismatch` | gated via `FABRICATED_API_CONTRACT_RULES` — name-proxy verb |
| `auth-mismatch` | `extractEndpoints` never sets `authentication` |
| `file-error` (schema) | no emission site; errors routed to `state.errors`, not a violation |
| `field-mismatch` (schema-validator) | legacy alias — renamed to `schema-field-mismatch` |
| `constraint-mismatch` | no extractor assigns `constraints` |
| `version-mismatch` | no extractor assigns `version` |

The two gated ones (`missing-endpoint`, `method-mismatch`) read as **"gated: computation is a name proxy"** — that's the honest reason, and it stays as a standing warning, not a quiet skip.

## Bucket 3 — `reword` (overclaim: claim less)

Predicate is sound; the sentence over it asserts more than was computed. Change the message, not the computation. **Applied 2026-09-04** (commit `fdd8c81`): 7 messages reworded.

| rule | says | should say |
|---|---|---|
| `solid/class-size` (TS) | "split responsibilities" | "split into smaller classes" ✅ |
| `solid/open-closed` (TS) | "frequently modified" | "uses `instanceof` against a user-defined type" ✅ |
| `solid/liskov-substitution` (TS) | "violate parent class contract" | "Ensure callers handle it" ✅ |
| `imports/import-organization` (Go) | "reducing dependencies" | "reducing import count" ✅ |
| `channels/concurrency` (Go) | "review for potential deadlocks" | "review for proper synchronization" ✅ |
| `react/accessibility` | "onClick on non-interactive `<X>`" | "may have onClick … (contains `<X>`)" ✅ |
| `documentation/file-documentation` | "proper documentation header" | "leading documentation comment" ✅ |

**Already honest on inspection — no change needed** (the ledger's `[overclaim]` flag was against an ID/doc-comment claim, not the emitted message): `solid/dependency-inversion` (TS — message already says "directly instantiates a concrete dependency"), `solid/open-closed` (Go — already "large switch … consider"), `styles/value-drift` (already "dominant value"), `styles/off-scale` (already "inferred Npx scale step"), `schema/invalid-format` (already "Invalid email/UUID format"), `schema/sql-injection` (message is "Potential SQL injection vulnerability", no interpolation claim), `cross-domain/transaction-boundary` (already "may indicate … risk"), `cross-domain/validation-bypass` (already "BFS depth ≤ N" in the message), `react/performance` (message is "Consider memoizing", a suggestion not an assertion).

## Bucket 4 — `render` (overclaim: emit what's already computed)

The signal exists and is thrown away. Don't drop the claim — render it.

| rule | discarded data |
|---|---|
| `circular-dependency` | `cycles[].nodes` (the path) — flattened to "Found N" |
| `break-cycles` | `cycleNodes` per cycle |
| `tight-coupling` | cluster node ids + `coupling` value |
| `reduce-coupling` | cluster node ids |
| `hub-nodes` | out-degree value (discarded by `findHubNodes`) + node name |
| `split-responsibilities` | hub node ids |
| `orphaned-nodes` | orphan node ids |
| `review-orphans` | orphan node ids |
| `dry/structural-similarity` | `computeJaccardSimilarity` + `similarityThreshold` exist, never wired into the violation |

The `dependency-graph` eight also restore the Spec 37 finding-contract: `{cycle}`/`{node}`/`{a}`/`{b}` resolution data is what a consumer needs to act.

## Bucket 5 — `logic` (small logic change — separate attribution)

Not a reword. It changes what fires, so it moves counts on recall and everywhere else; it gets its own commit and a changelog line like any rule change.

| rule | change |
|---|---|
| `styles/token-bypass` | remove the `tokenInfo.valueType !== 'color'` gate — non-color (length/spacing) token bypasses currently never fire |

## Bucket 6 — `rename` (crude: rename to what's measured — always, cheap)

The proxy measures a real, named, cheap thing (size/count/presence); only the label reaches for intent. No new machinery.

| rule | measures | rename to |
|---|---|---|
| `solid/single-responsibility` (Go func) | param + return + complexity count | "function has many parameters/returns/complexity" |
| `solid/single-responsibility` (Go struct) | field count + type diversity | "struct has many fields" |
| `solid/interface-segregation` (Go/TS) | method/member count | "interface has many members" |
| `solid/dependency-inversion` (Go) | concrete-typed field count | "struct has many concrete-typed fields" |
| `solid/single-responsibility` (TS) | param count / line count | "function has many parameters / is long" |
| `data-access/complex-query` | table count | "query references many tables" |
| `data-access/unfiltered-query` | no WHERE/HAVING/LIMIT keyword | "query has no filter" |
| `conventions/error-handling` | regex shape match | "error-handling shape differs from directory convention" |
| `schema/table-naming-convention` | uppercase-proxy | replace with `/^[a-z][a-z0-9_]*$/` + a `Table`-suffix policy |
| `schema-validator/schema-field-mismatch` | type-name string equality | "type-name strings differ" |
| `documentation/*` (4) | `jsDoc.length < N` | "missing a doc comment ≥ N chars" |
| `dry/duplicate-import` | same-source count | "module imported N times" |

**Applied 2026-09-04** (commits `7c39259` + `13dd2cb`): Go (func/struct SRP, interface-segregation, dependency-inversion), data-access (complex-query, unfiltered-query), schema-validator (schema-field-mismatch), documentation (function/class/method) messages renamed to state what is computed; registry templates updated to match. `schema/table-naming-convention` was a **logic** change (uppercase-proxy → explicit `/^[a-z][a-z0-9_]*$/` + `Table`-suffix), committed separately. TS `single-responsibility`/`interface-segregation`, `conventions/error-handling`, and `dry/duplicate-import` messages already described the proxy and were left as-is (`duplicate-import`'s fabricated `{line:1,column:1}` location is a render fix, tracked separately).

## Bucket 7 — `decide` (crude: invest or cut)

The honest version needs inputs the pipeline doesn't currently produce. Score each against the criterion; build the ones that pass, cut/keep-as-renamed the rest.

| rule | honest version needs | first-pass read |
|---|---|---|
| `solid/single-responsibility` | cohesion analysis (LCOM / concern clustering) | **cut-keep-as-renamed** — cohesion graph out of scope |
| `solid/interface-segregation` | client-usage sets (which callers use which methods) | **cut-keep-as-renamed** |
| `solid/liskov-substitution` (TS) | parent type resolution + signature comparison | **build** — type resolution already partial |
| `channels/concurrency` (Go) | channel send/recv blocking analysis | **cut-keep-as-renamed** |
| `schema/sql-injection` | taint/dataflow provenance | **build** — `isSafeDynamicParts` already resolves locals |
| `cross-domain/transaction-boundary` | transaction-scope parsing (BEGIN/COMMIT) | **build** — Go/TS call-graph already present |
| `cross-domain/validation-bypass` | data-path validation (does a validator gate the write) | **cut-keep-as-renamed** — full dataflow |
| `react/accessibility` | per-attribute JSX AST (which element has which prop) | **build** — `jsxElements` already AST nodes |
| `react/performance` (inline-props/keys) | element-attribute scoping | **build** — same AST source |
| `schema-validator/missing-field` | real Go requiredness (pointer-vs-value / proto labels) | **decide** — extractor has neither |
| `schema-validator/schema-field-mismatch` | cross-language type lattice | **cut-keep-as-renamed** — string equality is honest |

## Cross-cutting: the near-miss executor

`nearMiss: true` on ~94 registry rules is a *declaration*; only a handful are *executed* (`UniversalStylesAnalyzer.spec.ts`, `UniversalSchemaAnalyzer.spec.ts`, `solid/dependency-inversion`, and the 6 historical-FP guards). A declared-but-unexecuted sample is a guard that cannot fail. Build one executor that runs **every declared near-miss sample through its real analyzer** and asserts zero findings. This is what makes every future rule change falsifiable, and it's the same shape as the coverage-input-mapping defect the audit already caught (declared, never checked).

## Order of work (cost-to-value)

1. `render` — `dependency-graph` (data exists; highest trust payoff; restores finding-contract).
2. `reword` — the message-only batch.
3. `logic` — `token-bypass` gate (separate commit, attributable).
4. `report` — the 10 cannot-fire diagnostics (with the `cannot-fire`/`notApplicable` split).
5. `rename` — the crude size-proxies.
6. `rework` — the 4 dishonest (Go three + `missing-org-filter`), each with a near-miss test.
7. `decide` — build the passing rows; cut/rename the rest.
8. near-miss executor (unblocks 6's tests and all future work).
