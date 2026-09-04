# Spec 39 — Applicability

## The instance

`missing-org-filter` reports 43 findings on recall-protocol. Recall has no `org_id`, `tenant_id` or `organization_id` — not in any migration, not in any source file. The rule assumes multi-tenancy; the corpus is single-tenant.

Those 43 findings assert something structurally impossible. The rule is not miscalibrated and its threshold is not wrong. Its precondition is absent, and it fired anyway.

## The class

`missing-org-filter` is one rule. The shape is general: **a rule whose precondition is a fact about the codebase, firing on a codebase where that fact is false.**

Spec 27's coverage work established the vocabulary — `fired`, `clean`, `notApplicable`, `unassessed` — and Spec 33 item 14 mapped each rule to the facts or index tables it consumes. What has never been done is checking, across real corpora, whether any rule reports `fired` while its input is absent. `missing-org-filter` is the first one anyone looked at, and it was found by a consumer reading a report, not by the tool.

This matters more now than it did during internal use. A first-time user pointing this at their codebase gets a wall of findings for a rule that cannot apply to them, with nothing in the output saying so. That is the failure that costs a user permanently.

---

## R1 — Enumerate before fixing

Do not fix `missing-org-filter` first. Establish the size of the class.

For every rule in the registry, using the Spec 33 item 14 input mapping: run each available corpus and record, per rule, whether its declared input is present in that corpus and what state the rule reported.

Corpora: recall-protocol, knex, primer/css, blitz, OpenStatus, Directus, Twenty.

Report a matrix — rule × corpus × (input present? state reported? finding count). The cell that matters is **input absent, state `fired`**. Every one of those is this bug.

Also report **input present, state `notApplicable`** — the inverse error, where a rule silently skipped work it could have done.

Where a rule's input mapping is missing or wrong, that is itself a finding. Spec 33 item 14 declared the mapping; this is the first check of whether it is accurate.

## R2 — Applicability is derived, not configured

The obvious fix for `missing-org-filter` is a config flag to disable tenant-scoping rules on single-tenant projects. Reject it.

A flag requires the user to know the rule exists, know it does not apply to them, and find the setting — after they have already seen 43 wrong findings. It moves the work to the person least equipped to do it.

Applicability derives from what the analyzer already computed. `missing-org-filter` needs a tenant-scoping column in the table catalog. The catalog exists. The check is: does any table carry a column matching the configured tenant-column names? If not, the rule is `notApplicable` with that reason, and it emits nothing.

Requirements:

- Each rule's applicability is a predicate over its declared inputs, evaluated before the rule runs.
- A rule whose predicate is false reports `notApplicable` with a reason naming the absent input — not silence, and not zero findings.
- The reason is specific: "no tenant-scoping column found in table catalog", not "input missing".
- No config flag is introduced to suppress a rule that should have derived its own inapplicability. Where a user genuinely wants a rule off despite it applying, that is the existing disable mechanism and is unrelated.

## R3 — Fix every cell R1 finds

Not just `missing-org-filter`. Each rule reporting `fired` with its input absent gets a predicate.

Report per rule: the predicate, the input it reads, and the corpus that exposed it.

Where a predicate cannot be expressed from existing inputs, say so and name what would be needed. That is a real answer; inventing a config flag is not.

## R4 — The inverse: rules that skip when they could run

R1's second cell — input present, `notApplicable` — is the more dangerous direction, because it is silence where a finding belonged. Every dark-analyzer failure in this project's history is that shape.

Each one gets the same treatment: why did the predicate say no when the input was there.

---

## Acceptance

1. The full matrix from R1, posted as data — rule × corpus × input presence × reported state × count. Not a summary.
2. Every `fired`-with-absent-input cell fixed, with its predicate reported.
3. Every `notApplicable`-with-present-input cell explained or fixed.
4. `missing-org-filter` on recall reports `notApplicable`, reason naming the absent tenant column. Recall's data-access total drops by 43 to 1,645; every other analyzer exact.
5. New baselines for every corpus, per-analyzer and per-rule, with each delta attributed to a named predicate.
6. A fixture per predicate: a corpus fragment where the input is present (rule fires) and one where it is absent (rule reports `notApplicable`). The absent case is the regression guard.
7. Any rule whose Spec 33 item 14 input mapping was found wrong is reported, with the correction.
8. `npx tsc --noEmit` exit 0. Suite and integration suite green.

## Reporting

Standing reporting contract. Every requirement met, failed, or not run.

R1's matrix is posted in full. A summary of it is not the matrix — the individual cells are the finding.
