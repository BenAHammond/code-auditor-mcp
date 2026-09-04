# Spec 37 — The Finding Contract

## Why

Spec 36 R6 says a rule that cannot name the next action does not gate. This spec defines what naming an action means, and the rule metadata that makes it enforceable.

The linter ecosystem's biggest lever is autofix — most findings repair themselves, so there is nothing to negotiate with. That lever is unavailable here: code-auditor does not generate code.

What transfers is the property underneath it. A finding should arrive with enough structure that acting on it requires no judgement about *what* to do. The consumer is an LLM and can perform the edit. It should not have to invent the plan, because inventing the plan is where it wanders — and where 727 findings became a number.

---

## R1 — Findings carry a resolution, not just a problem

Every gating finding includes a `resolution`: the specific next action for this occurrence, derived from what the analyzer already computed.

The difference:

- *"Class has 44 methods, over the limit of 15."* The consumer must decide how to split, which methods go where, and whether that is even the right response.
- *"Class has 44 methods, over the limit of 15. These 12 reference only migration state and no other class member: `processMigrationSource`, `applyMigrationOps`, …"* The consumer performs an extraction.

The second requires no judgement about what to do. This is where the cross-file index earns its place — ESLint can say a function is complex; only something holding the call graph can say which members cluster.

Requirements:

- `resolution` is a structured field, not prose appended to the message. Consumers route on it.
- It names concrete symbols, files or lines wherever the analyzer has them.
- Where a rule cannot produce one for a given occurrence, it emits the finding non-blocking per Spec 36 R6 and records the gap.

Rules where the resolution is derivable today, and from what:

| Rule | Resolution derived from |
|---|---|
| `class-size` | member reference graph — which methods touch only a shared subset of state |
| `single-responsibility` | the largest contiguous block with no external references |
| `unknown-table` | nearest catalog entry by edit distance, plus the migration that dropped it |
| `undefined-class` | nearest defined class by edit distance, and which stylesheet defines it |
| `raw-element` | the design-system component that already wraps this element, from the import graph |
| `sql-injection-risk` | the parameterized form for this driver — `.bind()`, `$1`, `?` |
| `usage-pair` | the companion function the rest of the directory calls |
| `duplicate` | the other occurrence, and the nearest shared module both could import from |

Report which rules can produce a resolution and which cannot. A gating rule that cannot is a defect to fix, not a limitation to record.

## R2 — Rule metadata as a contract

ESLint rules declare `docs`, `fixable`, `schema`, `messages` and `type`. That contract is why thousands of community rules did not rot the core: every consumer knows what it can rely on without reading rule source.

`ruleRegistry` currently carries `analyzer`, `field`, `configGate` and `input`. Extend it:

- `gating: boolean` — participates in the blocking path (Spec 36 R4).
- `resolvable: boolean` — can produce a `resolution` (R1 above). A rule with `gating: true` and `resolvable: false` is a contract violation and fails the registry test.
- `message` — a template, not a string built at the emit site. One place per rule where wording lives.
- `docs` — a stable identifier for the rule's explanation. Not a URL the agent must fetch; the guidance travels inline per R1. This is for humans reading reports.
- `thresholds` — which config keys tune this rule, so Spec 36 R5's threshold reporting can name them and Spec 38's `--print-config` can resolve them.

Requirements:

- Every registry entry carries all fields. Missing any is a build failure, not a warning.
- The existing completeness tests extend to the new fields: every gating rule resolvable, every rule with thresholds naming real config keys.

## R3 — Rules ship with their tests

ESLint's `RuleTester` requires `valid` and `invalid` samples inline with the rule. A rule without them does not merge. That is why the ecosystem scaled.

The entry law here already says plan, spec and fixtures — but fixtures live in separate integration files, written by whoever remembered, which is why the near-miss negatives that catch shape-matching are inconsistent.

A near-miss negative is the case that catches a rule matching on syntax rather than semantics. Every recurring false positive in this project is one that was missing: `pool.length` read as a DB receiver, `COUNT` and `WHERE` read as receivers, `createTable` that is not the ORM's, `createElement(Button)` mistaken for a raw element, `escapeSql(x)` treated as raw interpolation, a class defined in a CSS comment.

Requirements:

- A rule declares `valid` and `invalid` samples adjacent to its implementation.
- At least one `valid` sample is a near-miss — syntactically close to the `invalid` case and semantically different.
- A rule without both fails the registry test. The near-miss becomes automatic instead of remembered.
- Each `invalid` sample asserts the `resolution` produced, not only that a finding fired. That is what keeps R1 honest as rules change.

Existing fixture corpora stay. They test the pipeline end to end; these test the rule in isolation, and the two catch different failures — the reducer treating class definitions as usages passed every extractor unit test.

---

## Acceptance

1. `resolution` on every gating finding. Report the rule-by-rule table: produces one, or cannot and why.
2. Registry entries carry `gating`, `resolvable`, `message`, `docs` and `thresholds`. A missing field fails the build — forced-failure transcript.
3. `gating: true` with `resolvable: false` fails the registry test — transcript.
4. Every rule has `valid` and `invalid` samples with at least one near-miss. A rule missing them fails — transcript.
5. Each `invalid` sample asserts its resolution.
6. The six historical false positives above each have a near-miss sample that fails if the guard is removed. Remove one guard, confirm the test fails, restore it.
7. Recall, knex, primer/css and blitz baselines exact. This spec changes what a finding carries, not what fires.

## Reporting

Standing reporting contract. Every requirement met, failed, or not run.
