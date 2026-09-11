# Severity Assignment Ledger

Spec 54 — "Severity as Urgency, Not Permission." Append-only. One analyzer per
session; commit per analyzer. Never rewrite earlier rows — this file is the
audit trail that the reassignment is real, not a mechanical rename.

## Running total (recompute at the top of every session's commit)

- **Assigned:** 14 / 106
- **critical:** 1
- **severe:** 2
- **high:** 11

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
