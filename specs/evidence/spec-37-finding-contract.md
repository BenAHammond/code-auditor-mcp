# Spec 37 — The Finding Contract — Evidence

Date: 2026-08-15

---

## Criteria

| # | Requirement | Status |
|---|---|---|
| R1 | Findings carry a `resolution`, not just a problem | **Met** |
| R2 | Rule metadata as a contract (`gating`/`resolvable`/`message`/`docs`/`thresholds`) | **Met** |
| R3 | Rules ship with their tests (valid/invalid + near-miss + resolution) | **Met** |

Acceptance:

| # | Acceptance | Status |
|---|---|---|
| 1 | `resolution` on every gating finding + rule-by-rule table | **Met** |
| 2 | Registry fields present; missing field fails the build | **Met** |
| 3 | `gating: true` + `resolvable: false` fails the registry test | **Met** |
| 4 | Every rule has valid/invalid + ≥1 near-miss; missing fails | **Met** |
| 5 | Each invalid sample asserts its resolution | **Met** |
| 6 | Six historical FPs each have a near-miss that fails if the guard is removed | **Met** — `nearMissGuards.spec.ts` executes each through its rule |
| 7 | Recall, knex, primer/css, blitz baselines exact | **Partial** — recall Met; knex/primer/blitz Not-run (corpora absent) |

---

## What changed

The gap that the prior report identified — that acceptance #6 was "structure-checked only, never executed" — is now closed.

- **R1 — resolution field.** `resolution` is a structured field on gating findings (`{ action, summary, symbols?, files?, lines? }`), derived from what the analyzer computed: `class-size` names the extractable member subset, `unknown-table` names the nearest catalog entry by edit distance, `raw-element` names the wrapping design-system component, `sql-injection-risk` names the parameterized form, and so on.
- **R2 — rule metadata contract.** `src/analyzers/ruleRegistry.ts` entries carry `gating`, `resolvable`, `message`, `docs`, `thresholds`, and `samples`. Missing any field is a build failure (not a warning); `gating: true` with `resolvable: false` fails the registry test.
- **R3 — samples adjacent to the rule, with near-miss + resolution.** Every rule declares `valid` and `invalid` samples; at least one `valid` sample is a near-miss (syntactically close, semantically different); each `invalid` sample asserts the produced `resolution`.

### Acceptance #6 — the six historical false positives now execute

`src/__tests__/nearMissGuards.spec.ts` runs each of the six named false positives through the **real analyzer** (not registry metadata), with a control true-positive assertion alongside, so removing the guard fails the test:

| Historical FP | Near-miss guard | Executed? |
|---|---|---|
| `pool.length` read as a DB receiver | `pool.length` valid, `pool.query(...)` invalid | **Yes** |
| `COUNT` / `WHERE` read as receivers | `SELECT COUNT(*)` / `WHERE id = ?` valid, real receiver invalid | **Yes** |
| `createTable` that is not the ORM's | non-ORM `createTable` valid, ORM `createTable` invalid | **Yes** |
| `createElement(Button)` mistaken for raw element | literal `createElement(Button)` valid, raw `<div>` invalid | **Yes** |
| `escapeSql(x)` treated as raw interpolation | `escapeSql(x)` valid, raw template interpolation invalid | **Yes** |
| class defined in a CSS comment | class-in-comment valid, real class invalid | **Yes** |

This test is part of the green suite (997 tests / 64 files). Removing a guard fails it; the prior "samples are never executed" finding is resolved.

---

## Evidence

### Registry contract tests green
```
$ npx vitest run src/__tests__/baseline.test.ts
```
Structural tests enforce: every entry carries all fields (missing → fail); `gating: true` + `resolvable: false` → fail (acceptance 3); every rule has `valid` + `invalid` samples with ≥1 `nearMiss` (acceptance 4); every resolvable rule asserts a `resolution` on its invalid samples (acceptance 5).

### Near-miss guard execution (acceptance #6)
```
$ npx vitest run src/__tests__/nearMissGuards.spec.ts   → pass
```
Each of the six historical FPs runs through its analyzer with a true-positive control; removing the guard fails the assertion.

### Recall baseline — exact (acceptance #7)
```
recall total 5917 (solid 1028, dry 6, data-access 1688 [sql-injection-risk 4],
documentation 2477, schema 10, schema-code 95, styles 119, conventions 116, cross-domain 39) — exact.
```
This spec changes what a finding carries, not what fires — recall stays exact.

---

## Findings

1. **knex / primer/css / blitz baselines unverifiable.** The `knex` and `blitz` directories are empty (only `.code-index`); `primer/css` and `twenty` are absent. Acceptance #7 is therefore only fully verifiable against recall (5,917 exact); the other three are **Not-run**, not Met.

## Not done

- **knex 458 / primer/css 18 / blitz 975 baseline re-verification** — corpora absent/empty on this machine (Finding 1).
