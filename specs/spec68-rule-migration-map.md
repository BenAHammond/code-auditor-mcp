# Spec 68 — rule migration map

The plan for migrating all 100 rules onto `analyze(ctx)` over facts. This file
holds the **planned** vocabulary; `FactShapes` (in `src/phase/types.ts`) holds
only what **works today** — a fact kind does not enter the type until it has a
producer that returns real data.

Reversal (post-Amendment-3 correction): a fact kind with no working producer is
**absent** from `FactShapes` and from `PRODUCERS`, not represented by a stub
producer that throws "not yet migrated". Residue check #2 (every produced kind
is consumed) is therefore satisfied by reality, and the producer-liveness meter
is green continuously — not once at the end. This file is where the not-yet-real
kinds live until their producer lands.

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

These are **not yet fully migrated**: the old analyzer path is still live and no
test asserts finding parity against the pre-migration output. A rule counts as
migrated only when all four hold — `analyze(ctx)`, all facts live, old path
deleted, parity test pinned. Today that count is **0**.

## Planned vocabulary (not yet in `FactShapes`)

New fact kinds the 39 RENEW rules require, to be added one at a time as their
producers land (a kind enters the type only then):

1. `react-component` — name/file/line/componentType/complexity/hooks[]/props[]/jsxElements[]/jsxElementDetails[]/hasErrorBoundary/isExported (react 7).
2. `string-literals` — value + file + line + column (hardcoded-secret, hardcoded-connection, duplicate-string-literal).
3. `imports` (TS/JS) — source/form/line/localNames (duplicate-import, conventions/import-form).
4. `code-block` — text + hash + structuralSkeleton + span + nodeType (DRY duplicate / structural-similarity / similar-expression).
5. `export-form` — default/named/module.exports (conventions/export-shape).
6. `mined-conventions` — antecedent/consequent/directory/pattern/confidence/exemplar_file/line/export_kind (conventions 5).
7. `file-imports` (module facts) — imports/hasExports/unresolvedDynamicImports (unreferenced-module).
8. `migration-history` — dropped table + migrationFile + createdInSameMigration (stale-table-reference).
9. coverage / hotspot / call-graph facts (cross-domain multi-table-write, no-validator-reachable, uncovered-risk) — §8.
10. Go facts — interface/struct/switch/panic + return-count (switch-size, function-size, struct-size, liskov-substitution, interface-size) — §9.
11. file-level header-comment fact (file-documentation).

Enrichments to existing shapes: `file-symbols` (jsDoc text, returnType, method
visibility, shouldSkipFunction signals), `schema-json` → validation tuples,
`go-*` (tier, dropped-error signals, channel identity, goroutine↔channel
cross-ref), `style-declarations` (definedClasses catalog), `Entity` (drop the
dead `calls`/`calledBy` — `metadata.callees` is the load-bearing edge).

## Disposition by analyzer

- **SOLID (13)**: 8 CLEAN (migrated) + 5 Go-arm RENEW (interface-size, switch-size, function-size, struct-size, liskov-substitution-go).
- **Go binary (5)**: import-style CLEAN; import-organization / error-handling / concurrency / channel-deadlock ENRICH (§9).
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
