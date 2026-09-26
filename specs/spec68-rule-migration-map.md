# Spec 68 — rule migration map

The plan for migrating all 100 rules onto `analyze(ctx)` over facts. This file
holds the **planned** vocabulary; `FactShapes` (in `src/phase/types.ts`) holds
only what **works today** — a fact kind does not enter the type until it has a
producer that returns real data.

Reversal (post-Amendment-3 correction): a fact kind with no working producer is
**absent** from `FactShapes` and from `PRODUCERS`, not represented by a stub
producer that throws "not yet migrated". The producer-liveness meter is green
continuously — not once at the end — because every declared producer returns real
data. Residue check #2 (every produced kind is consumed) is the one red meter:
it stays red until the rules that read each kind land in `MIGRATED_RULES`
(spec68-consumed-coverage.spec.ts). This file is where the not-yet-real kinds
live until their producer lands.

## Live vocabulary (8 kinds, all with real producers)

| fact kind | producer | consumers |
|---|---|---|
| `file-symbols` | `extractFileSymbols` | 36 rules (solid, DRY, documentation, react, security, secrets) |
| `function-index` | `extractFunctionIndex` | 5 conventions rules + 5 cross-domain rules |
| `ddl-declarations` | `extractSchemaCode` | 5 schema rules |
| `schema-usage` | `extractSchemaUsage` | 5 schema rules + 5 cross-domain rules |
| `style-declarations` | `extractStylesCss` | 9 styles rules |
| `cross-language-entities` | `extractCrossLanguageEntities` | 12 dependency-graph / schema-validator rules |
| `data-access-calls` | `extractDataAccessCalls` | 5 data-access rules |
| `table-catalog` | corpus processor over `ddl-declarations` | `missing-org-filter` |

## Tally (from the Amendment-3 per-rule body read)

**77 of 100** registry `needs.facts` declarations were wrong as written; 23 were
correct. Dispositions: **23 CLEAN**, **38 ENRICH** (right kind, shape missing
fields), **39 RENEW** (wrong kind — the body reads fields no declared fact
carries).

- **CLEAN** — migratable now over the declared fact.
- **ENRICH** — re-declare the same kind, but the shape must gain fields first.
- **RENEW** — re-declare against a different (usually new) fact kind.

## Migrated today (14 rules, `analyze(ctx)` + live facts)

`solid/class-size`, `solid/method-complexity`, `solid/open-closed`,
`solid/single-responsibility`, `function-length`, `parameter-count`,
`interface-size`, `solid/liskov-substitution`, `solid/dependency-inversion`
(9, `file-symbols`); `sql-injection-risk`, `complex-query`, `unfiltered-query`
(3, `data-access-calls`); `unknown-table`, `table-naming-convention`
(2, `schema-usage` + `table-catalog`).

These 14 have `analyze(ctx)` written over live facts, but they are **not fully
migrated**: the old analyzer path is still live and no test asserts finding
parity against the pre-migration output. A rule counts as migrated only when all
four hold — `analyze(ctx)`, all facts live, old path deleted, parity test
pinned. The authoritative registry is `MIGRATED_RULES`
(`src/phase/rules/registry.ts`): **0 of 100 today**, and it goes green only when
every rule satisfies all four. The single failing assertion that drives the
migration is `spec68-registry-size.spec.ts` (expects `MIGRATED_RULES.length` to
reach 100).

## Planned vocabulary (not yet in `FactShapes`)

New fact kinds the 39 RENEW rules require, to be added one at a time as their
producers land (a kind enters the type only then):

1. `react-component` — name/file/line/componentType/complexity/hooks[]/props[]/jsxElements[]/jsxElementDetails[]/hasErrorBoundary/isExported (react 7).
2. `string-literals` — value + file + line + column (hardcoded-secret, hardcoded-connection, duplicate-string-literal).
3. `imports` — source/form/line/localNames, supplied by TS/JS *and* Go producers (duplicate-import, conventions/import-form, import-organization, import-style). The concept, not the language.
4. `code-block` — text + hash + structuralSkeleton + span + nodeType (DRY duplicate / structural-similarity / similar-expression).
5. `export-form` — default/named/module.exports (conventions/export-shape).
6. `mined-conventions` — antecedent/consequent/directory/pattern/confidence/exemplar_file/line/export_kind (conventions 5).
7. `file-imports` (module facts) — imports/hasExports/unresolvedDynamicImports (unreferenced-module).
8. `migration-history` — dropped table + migrationFile + createdInSameMigration (stale-table-reference).
9. coverage / hotspot / call-graph facts (cross-domain multi-table-write, no-validator-reachable, uncovered-risk) — §8.
10. Go concept facts — `type-declarations` (struct/interface; `struct-size` and `interface-size` collapse into one rule over it), `error-bindings` (error-handling), `concurrency-primitives` (concurrency), `channel-operations` (channel-deadlock) — §9. Each is a *concept* kind supplied by a Go producer plus (where the concept crosses languages) other formats. Remaining Go-specific facts: switch/panic + return-count (switch-size, function-size, liskov-substitution).
11. file-level header-comment fact (file-documentation).

Enrichments to existing shapes: `file-symbols` (jsDoc text, returnType, method
visibility, shouldSkipFunction signals), `schema-json` → validation tuples,
`imports` / `error-bindings` / `concurrency-primitives` / `channel-operations` /
`type-declarations` (tier, dropped-error signals, channel identity,
goroutine↔channel cross-ref, struct/interface member counts),
`style-declarations` (definedClasses catalog), `Entity` (drop the
dead `calls`/`calledBy` — `metadata.callees` is the load-bearing edge).

## Fact-kind rename (concept, not language)

The five fact kinds that were once prefixed `go-` are concepts, supplied by a
Go producer plus — where the concept crosses languages — other formats (§3.1
one-producer-per-(kind, format)):

| old name | new name |
|---|---|
| `go-imports` | `imports` |
| `go-error-bindings` | `error-bindings` |
| `go-goroutines` | `concurrency-primitives` |
| `go-channels` | `channel-operations` |
| `go-structures` | `type-declarations` |

## Disposition by analyzer

- **SOLID (13)**: 8 CLEAN (migrated) + 5 Go-arm RENEW (switch-size, function-size, liskov-substitution-go; `struct-size` + `interface-size` collapse into one rule over `type-declarations`).
- **Go binary (5)**: all concept rules, not Go rules — `import-style` / `import-organization` over `imports`, `error-handling` over `error-bindings`, `concurrency` over `concurrency-primitives`, `channel-deadlock` over `channel-operations` (§9).
- **DRY (6)**: all RENEW (code-block / structural-skeleton / expression-shape / clone-pair-history / string-literals / imports).
- **data-access (6)**: sql-injection-risk, complex-query, unfiltered-query, missing-org-filter CLEAN; hardcoded-connection, loop-query RENEW.
- **documentation (6) + secrets (1)**: 5 ENRICH (jsDoc text etc.) + file-documentation / hardcoded-secret RENEW.
- **schema-json (17)**: all ENRICH (validation-tuple shape, position from the JSON adapter).
- **schema-code (5)**: all RENEW (schema-usage / table-catalog / dynamic-sql / function-index.body / migration-history).
- **react (7) + schema-validator (3)**: react 7 RENEW (react-component); schema-validator 3 ENRICH (Entity flat fields).
- **dependency-graph (9)**: 8 CLEAN (Entity.id/name/file/type/… via `metadata.callees`); unreferenced-module RENEW (file-imports).
- **styles (9)**: all ENRICH (snake_case index rows + normalized-value string-vs-object + definedClasses for undefined-class).
- **conventions (5) + cross-domain (5)**: conventions 5 RENEW (mined-conventions etc.); cross-domain written-never-read / read-never-written CLEAN, the other 3 RENEW.
- **security (3)**: all RENEW (call-site/expression fact or enriched function-index with body text).

## Unregistered emissions (board 6.3 — Ben's call)

- `reserved-word` — fires on a declared snake_case table name colliding with a SQL reserved keyword; no registry entry. To be real: its own entry (`schema-usage` tableName + origin).
- `missing-schemas` — fires when `config.requiredSchemas` is set but none load; a config/deployment signal, not a code defect. To be real: a config-only entry.
