# Spec 45 — Amendment A

Two "narrowings" surfaced by the R6 survey (`specs/evidence/spec-45-r6-survey.md`)
were written without Ben's agreement and reverted here. They are the last two
open items in that survey: item #2 (Spec 36 R3, counts) and item #7 (Spec 38 R3,
slow-rule removal). Every other survey item was already reverted by Spec 45
R1–R5.

---

## A1 — A slow rule is optimized, never dropped from the gate (reverts Spec 38 R3)

Spec 38 R3 said a rule exceeding its 300 ms gate-budget share is "optimized or
removed from the gating set." **Strike "or removed from the gating set."**

A rule too slow gets optimized. It never leaves the gate. The gate runs with
every rule gating, period.

- If the budget cannot be met with every rule gating, **report the actual number
  and what dominates it**.
- **Do not drop rules, and do not silently widen the budget.**

## A2 — Counts are emitted (reverts Spec 36 R3)

Spec 36 R3 said the tool never emits a bare count to an agent (findings only, no
totals). **Remove it.**

Counts are emitted where they are useful — per analyzer, per rule, per severity,
in agent-facing surfaces as well as human ones.

## Acceptance criteria

1. Spec 38's budget requirement no longer permits removing a rule from the gate.
   Report any rule currently outside the gate for speed reasons, and put it back.
2. Gate budget measured with every rule gating. Report the number. If >300 ms,
   report what dominates — do not drop rules or widen the budget.
3. Counts emitted in agent-facing output. Confirm the Spec 45 R1 before/after
   gating count can now be reported from the tool rather than derived by hand.
4. Corpus baselines unchanged — neither change alters what fires. Confirm by
   measurement.
5. `npx tsc --noEmit` exit 0. Unit and integration suites green. `verify:close`
   green.

## Reporting

Standing reporting contract. Every requirement met, failed, or not run. If the
gate budget cannot hold with every rule gating, that is a finding to report, not
a reason to narrow anything.
