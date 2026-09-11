# Severity Assignment Ledger

Spec 54 — "Severity as Urgency, Not Permission." Append-only. One analyzer per
session; commit per analyzer. Never rewrite earlier rows — this file is the
audit trail that the reassignment is real, not a mechanical rename.

## Running total (recompute at the top of every session's commit)

- **Assigned:** 96 / 106
- **critical:** 7
- **severe:** 35
- **high:** 54

## Inventory note (reconciles to 106, not the spec's 105)

The spec calls for 105 rules. The accurate inventory is **106** rules, which
decompose into **96 live** (have an emission site) plus **10 `cannot-fire`**
(registered but structurally unreachable — see `CANNOT_FIRE_RULES` in
`src/analyzers/applicability.ts`).

- **102** in `RULE_REGISTRY`, plus **4 unregistered live** emit sites —
  `dry/diverging-clone` (`auditRunner.ts`), `missing-schemas`
  (`UniversalSchemaAnalyzer.ts`), `reserved-word` and `too-many-queries`
  (`schema/codeAnalysis.ts`).
- Of the 102 registered, **10 `cannot-fire`**: all six `api-contract` rules,
  `schema/file-error`, and three `schema-validator` rules (`field-mismatch`,
  `constraint-mismatch`, `version-mismatch`).

Every live rule gets a severity row. `cannot-fire` rules are accounted for with a
note and **no** severity — there is nothing to gate until an emission site exists.

Per-analyzer counts (live / cannot-fire): solid 13/0, secrets 1/0, data-access 6/0,
dry 6/0, documentation 6/0, react 7/0, schema 23/1, schema-validator 3/3,
api-contract 0/6, dependency-graph 9/0, invariants 2/0, styles 10/0,
conventions 5/0, cross-domain 5/0.

## Measuring stick for the "Disagrees" column

The spec forbids *using* mechanical remap as the assignment method. It does not
forbid using it as the *baseline against which departures are visible*. A row's
**Disagrees** column is `yes` when the new level differs from the straight 1:1
remap of its current (effective) severity — `critical→critical`, `warning→severe`,
`suggestion→high`. A `yes` flags a deliberate judgment call for human review; a
`no` means the reassignment landed where the mechanical baseline would have anyway.

"Current severity" is the **effective** severity = `severityOverrides[rule] ??
emit-site severity`, because that is what the tool actually reports today.

## R3 decisions (recorded up front; implementation follows in later sessions)

1. **`gateSeverities` → remove** (not "default all three"). With three defect
   levels and nothing below `high`, the gate is always the full set — the field
   has no remaining knob and is deleted from config. The gate survives internally
   as a fixed set `{critical, severe, high}`; `--fail-on` and path-profile
   `excludeFromGate` remain (they are about *scope*, not *level*).
2. **`DEFAULT_BLOCKING_SEVERITIES` → remove**, replaced by the fixed all-three
   constant.
3. **`severityOverrides` → remove** (config key + `SeverityOverrides` type).
   Per-rule severity tuning disappears because every rule is now assigned on the
   urgency axis; a team that disagrees with a level escalates via
   `excludeFromGate` (scope) or edits/removes the rule — never by re-labeling
   severity.
4. **Path-profile severity capping → remove**; `excludeFromGate` /
   `excludeFromAnalysis` stay. Capping softens a reading in place; the honest
   mechanism is to scope the file out of the gate, never to relabel its readings.

---

## Session 1 — solid (13 rules)

Emit-site severities come from `UniversalSOLIDAnalyzer.ts` (TS rules) and
`src/languages/go/analyzer-src/solid.go` (Go rules). Effective severities fold in
`severityOverrides` (`solid/class-size`→warning, `solid/dependency-inversion`→warning).

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `solid/class-size` | warning | high | "Too big to reason about" is off-scale size — a defect that has not bitten. | yes |
| `solid/method-complexity` | warning | high | Cyclomatic complexity predicts bugs but has not surfaced one yet. | yes |
| `solid/open-closed` | suggestion | high | Closed-for-extension is a design smell that has not bitten. | no |
| `solid/single-responsibility` | warning | high | Doing too much is a maintenance defect that has not surfaced. | yes |
| `function-length` | warning | high | Length is off-scale size — anchored high in the spec. | yes |
| `parameter-count` | warning | high | Too many parameters is off-scale — anchored high. | yes |
| `interface-size` | warning | high | Oversized interface is off-scale — anchored high. | yes |
| `solid/liskov-substitution` | suggestion | severe | Override throws where the base does not — a contract break that surfaces at runtime. | yes |
| `solid/dependency-inversion` | warning | high | High-level coupling to a low-level detail is architectural debt that has not bitten. | yes |
| `switch-size` | suggestion | high | Oversized switch is off-scale — anchored high. | no |
| `function-size` | warning | high | Go function off-scale size — anchored high. | yes |
| `struct-size` | warning | high | Go struct off-scale size — anchored high. | yes |
| `liskov-substitution` (bare Go) | warning | severe | Method calls `panic()` — a runtime crash that surfaces when the method runs. | no |

---

## Session 2 — secrets (1 rule)

Emit site: `UniversalSecretsAnalyzer.ts` (`hardcoded-secret`, `severity: 'critical'`).

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `hardcoded-secret` | critical | critical | A credential value embedded in source is exploitable now — no runtime needed. | no |

---

## Session 3 — data-access (6 rules)

Emit sites: `UniversalDataAccessAnalyzer.ts`. Effective severities fold in
`severityOverrides` (`missing-org-filter`→suggestion).

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `sql-injection-risk` | warning | critical | String-concatenated SQL from input is exploitable now. | yes |
| `missing-org-filter` | suggestion | severe | A query on tenant tables without an org filter leaks across tenants — it surfaces as a data-isolation breach. | yes |
| `complex-query` | warning | high | Subqueries and many-table joins are a performance smell that has not bitten. | yes |
| `unfiltered-query` | suggestion | high | A no-filter query is a smell (possible full-table read) that has not bitten. | no |
| `hardcoded-connection` | suggestion | critical | A connection string with credentials embedded in source is a leaked secret — exploitable now. | yes |
| `loop-query` | warning | severe | A query inside a loop is N+1 — it surfaces under load (anchored). | no |

---

## Session 4 — dry (6 rules)

Emit sites: `UniversalDRYAnalyzer.ts` (5 registered) and `auditRunner.ts`
(`dry/diverging-clone`, unregistered).

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `dry/duplicate` | warning | high | A duplicated block is maintainability debt that has not bitten. | yes |
| `dry/structural-similarity` | suggestion | high | Structurally similar blocks are a DRY smell that has not bitten. | no |
| `dry/similar-expression` | suggestion | high | Near-identical expressions are a DRY smell that has not bitten. | no |
| `duplicate-string-literal` | suggestion | high | Repeated literals are a maintainability smell that has not bitten. | no |
| `duplicate-import` | warning | high | A redundant import is noise that has not bitten. | yes |
| `dry/diverging-clone` | suggestion | severe | A clone that has already drifted means a fix landed in one copy and not the other — inconsistent behavior that surfaces when the stale copy runs. | yes |

---

## Session 5 — documentation (6 rules)

Emit sites: `UniversalDocumentationAnalyzer.ts`. The whole family is a
maintainability/readability gap — anchored high in the spec.

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `file-documentation` | warning | high | A missing file doc comment is a readability gap that has not bitten. | yes |
| `function-documentation` | warning | high | A missing function doc comment is a readability gap. | yes |
| `parameter-documentation` | warning | high | A missing @param tag is a readability gap. | yes |
| `return-documentation` | warning | high | A missing @returns tag is a readability gap. | yes |
| `class-documentation` | warning | high | A missing class doc comment is a readability gap. | yes |
| `method-documentation` | warning | high | A missing method doc comment is a readability gap. | yes |

---

## Session 6 — react (7 rules)

Emit sites: `reactAnalyzer.ts`. `performance` carries one `suggestion` sub-path
and `raw-element` is dynamic (`warning` when `componentMap` is set, else
`suggestion`); both are recorded at their dominant/configured severity.

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `hooks-naming` | warning | high | A hook outside the `use*` convention is a naming smell that has not bitten. | yes |
| `complexity` | warning | high | An over-complex component is off-scale complexity that has not bitten. | yes |
| `missing-props` | warning | high | Missing prop-types is a type-safety smell that has not bitten. | yes |
| `no-error-boundary` | warning | severe | A tree without an error boundary crashes the whole app on one throw — anchored severe. | no |
| `performance` | warning | high | Missing memoization causes re-renders, a performance smell that has not bitten. | yes |
| `accessibility` | warning | severe | An inaccessible component fails WCAG — a defect that surfaces for assistive-tech users. | yes |
| `raw-element` | warning | high | A raw element where the project uses a wrapper is a convention smell. | yes |

---

## Session 7 — schema (23 live + 1 cannot-fire)

Emit sites: `jsonSchema.ts` (JSON validation), `codeAnalysis.ts` (SQL/table
rules), `UniversalSchemaAnalyzer.ts` (`missing-schemas`). `file-error` is
`cannot-fire` (routed to `state.errors`), so it gets no severity.

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `missing-schema-declaration` | suggestion | high | A missing `$schema` declaration is a convention gap that has not bitten. | no |
| `invalid-json` | warning | critical | The file cannot be parsed at all — broken now. | yes |
| `undefined-required-field` | warning | severe | A required field is not defined in `properties` — the schema is wrong and surfaces. | no |
| `invalid-type` | warning | severe | A declared type is not a valid JSON-Schema type — the schema is wrong. | no |
| `invalid-range` | warning | severe | `minimum > maximum` is a contradictory constraint — the schema is wrong. | no |
| `type-mismatch` | warning | severe | Data does not match the declared field type — surfaces on validation. | no |
| `string-too-short` | warning | severe | Data violates `minLength` — surfaces on validation. | no |
| `string-too-long` | warning | severe | Data violates `maxLength` — surfaces on validation. | no |
| `pattern-mismatch` | warning | severe | Data fails the declared pattern — surfaces on validation. | no |
| `invalid-format` | warning | severe | Data fails the declared format — surfaces on validation. | no |
| `below-minimum` | warning | severe | Data is below the declared minimum — surfaces on validation. | no |
| `above-maximum` | warning | severe | Data is above the declared maximum — surfaces on validation. | no |
| `too-few-items` | warning | severe | Array is below `minItems` — surfaces on validation. | no |
| `too-many-items` | warning | severe | Array is above `maxItems` — surfaces on validation. | no |
| `missing-required-field` | warning | severe | A required field is absent — surfaces on validation. | no |
| `unexpected-property` | warning | severe | An undeclared property is present — surfaces on validation. | no |
| `enum-mismatch` | warning | severe | Value is not in the declared enum — surfaces on validation. | no |
| `dynamic-sql-construction` | suggestion | critical | User-controlled SQL built by interpolation is injectable now — anchored critical. | yes |
| `table-naming-convention` | suggestion | high | A table name off the naming convention is a style smell that has not bitten. | no |
| `unknown-table` | suggestion | critical | A query against a table that does not exist fails when it runs — anchored critical. | yes |
| `missing-schemas` | warning | severe | Schema validation is configured but no schemas exist — the guard you think is up is down. | no |
| `reserved-word` | warning | severe | A reserved word as a table name breaks when the SQL runs. | no |
| `too-many-queries` | warning | high | A function issuing many queries is a chatty-perf smell that has not bitten. | yes |

`cannot-fire` (no severity): `file-error`.

---

## Session 8 — schema-validator (3 live + 3 cannot-fire)

Emit sites: `SchemaValidator.ts`. `field-mismatch`, `constraint-mismatch`, and
`version-mismatch` are `cannot-fire` (legacy alias / unpopulated extractor
fields), so they get no severity.

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `schema-field-mismatch` | warning | severe | Declared field type-name strings differ across schemas — anchored severe. | no |
| `missing-field` | warning | severe | A field is present in one schema but absent in the other — surfaces on integration. | no |
| `extra-field` | warning | severe | A field is present where the schema does not declare it — surfaces on integration. | no |

`cannot-fire` (no severity): `field-mismatch`, `constraint-mismatch`, `version-mismatch`.

---

## Session 9 — api-contract (0 live + 6 cannot-fire)

`APIContractAnalyzer` has **no emission site** for any of its six rules. All six
are `cannot-fire`: `extractEndpoints`/`extractAPICalls` never populate the fields
these rules read, or the rule has no producing code at all (per
`CANNOT_FIRE_RULES`). No severity is assigned — there is nothing to gate until
extraction lands. This is a standing finding about the analyzer, not a project
verdict.

`cannot-fire` (no severity): `api-type-mismatch`, `missing-endpoint`,
`api-extra-field`, `api-missing-field`, `method-mismatch`, `auth-mismatch`.

---

## Session 10 — dependency-graph (9 rules)

Emit sites: `DependencyGraphBuilder.ts` (issue/suggestion pairs) and the
Stage-4 reducer in `pipelineAdapters.ts` (`unreferenced-module`). The four
`*Type` "resolution" rules pair one-to-one with their issue — same underlying
finding, same level.

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `circular-dependency` | warning | severe | A module cycle breaks initialization order — it surfaces (anchored). | no |
| `break-cycles` | warning | severe | The action form of `circular-dependency`; same finding. | no |
| `tight-coupling` | warning | high | Tight coupling is design debt that has not bitten. | yes |
| `reduce-coupling` | warning | high | The action form of `tight-coupling`; same finding. | yes |
| `hub-nodes` | warning | high | A hub node is a maintainability smell that has not bitten. | yes |
| `split-responsibilities` | warning | high | The action form of `hub-nodes`; same finding. | yes |
| `orphaned-nodes` | suggestion | severe | A node nothing connects to is dead code — same class as `unreferenced-module`. | yes |
| `review-orphans` | suggestion | severe | The action form of `orphaned-nodes`; same finding. | yes |
| `unreferenced-module` | warning | severe | A module nothing imports is dead code — anchored severe. | no |

---

## Session 11 — invariants (2 rules)

Emit sites: `invariantsAnalyzer.ts`. These are the two *fixed* internal IDs;
user-defined invariant rule IDs vary per project and are not in scope here.

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `config-error` | critical | critical | A malformed `.codeauditor.json` means declared laws are not enforced — broken now. | no |
| `engine-error` | warning | severe | The rule engine threw on a rule — a defect that surfaces as an unenforced law. | no |

---

## Session 12 — styles (10 rules)

Emit sites: `UniversalStylesAnalyzer.ts`. The whole family is design-system
consistency; the spec anchors `styles/off-scale` and `styles/undefined-class` to
high, so the rest of the family follows.

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `styles/value-drift` | warning | high | A color drifting off the token is a design-consistency smell that has not bitten. | yes |
| `styles/off-scale` | warning | high | A value off the spacing scale is a design smell — anchored high. | yes |
| `styles/undefined-class` | warning | high | A class with no definition is a styling gap — anchored high. | yes |
| `styles/undefined-class-disabled` | suggestion | high | Detector-availability notice, not a code defect — still a gap, not a bite. | no |
| `styles/token-bypass` | warning | high | A raw value where a token belongs is a design smell that has not bitten. | yes |
| `styles/mechanism-fragmentation` | warning | high | Many styling mechanisms is a maintainability smell that has not bitten. | yes |
| `styles/mechanism-mixing` | suggestion | high | Mixed mechanisms in one file is a maintainability smell. | no |
| `styles/declaration-set-similarity` | suggestion | high | Similar declaration sets are a DRY smell that has not bitten. | no |
| `styles/z-index-sprawl` | warning | high | Z-index sprawl is a maintainability smell that has not bitten. | yes |
| `styles/z-index-singleton` | suggestion | high | A one-off z-index value is a maintainability smell. | no |

---

## Session 13 — conventions (5 rules)

Emit site: `UniversalConventionsAnalyzer.ts`. All five domains ship at
`suggestion`. They are mined-deviation smells — a minority import style or wrong
casing is a consistency smell that has not bitten. The spec places the
documentation family at high; convention deviation is the same class of
consistency gap.

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `conventions/usage-pair` | suggestion | high | A function missing its co-occurring call is a convention gap that has not bitten. | no |
| `conventions/import-form` | suggestion | high | A minority import style is a consistency gap that has not bitten. | no |
| `conventions/error-handling` | suggestion | high | An off-pattern error-handling shape is a consistency gap that has not bitten. | no |
| `conventions/export-shape` | suggestion | high | A minority export style is a consistency gap that has not bitten. | no |
| `conventions/naming` | suggestion | high | Wrong casing is a consistency gap that has not bitten. | no |

---

## Session 14 — cross-domain (5 rules)

Emit site: `CrossDomainAnalyzer.ts` (entry rule: all findings at `suggestion`).
Two rules describe data-flow defects that surface when the read or the write
actually happens, so they rise above the mechanical baseline; the rest are
smells.

| Rule | Current (effective) | New level | Reason | Disagrees |
|---|---|---|---|---|
| `cross-domain/written-never-read` | suggestion | high | A table written but never read is a dead-write smell that has not bitten. | no |
| `cross-domain/read-never-written` | suggestion | severe | A table read but never written means every read fails — it surfaces on the first read. | yes |
| `cross-domain/multi-table-write` | suggestion | high | A function writing too many tables is a coupling smell that has not bitten. | no |
| `cross-domain/no-validator-reachable` | suggestion | severe | A writer that reaches no validator means unvalidated data enters the system — it surfaces as corrupt state. | yes |
| `cross-domain/uncovered-risk` | suggestion | high | A top-risk function with no test coverage is a coverage smell that has not bitten. | no |

---

## Sweep complete

All 106 rules accounted for: 96 live assigned across 14 analyzer sessions
(`critical` 7, `severe` 35, `high` 54) plus 10 `cannot-fire` rules noted with no
severity. Every row above records current (effective) severity, new level,
reason, and whether it departs from the mechanical remap baseline.
