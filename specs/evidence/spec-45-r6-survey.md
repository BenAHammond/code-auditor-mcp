# Spec 45 R6 — Survey of Narrowings in Specs 26-44

Survey only. No R6 finding is reverted without Ben's decision. Every narrowing
is quoted, named by spec + section, and attributed to Ben or Claude.

## Coverage note

Spec files present on disk in this range: 35, 36, 37, 38, 39, 40, 41, 42, 43
(plus `schema-split-assignments.md` = Spec 34). Evidence files present for 32,
33, 44. Spec 44's forward content lives in `rule-remediation-backlog.md` and
`rule-authenticity-ledger.md` (both titled "Spec 44").

**Absent from disk, no primary text to survey:** specs 26, 27, 28, 29, 30, 31.
Their content is recoverable only from cross-references in later specs/evidence:
Spec 26 (`.css` via AST, `.scss` left on regex path), Spec 27 (coverage
vocabulary — `fired`/`clean`/`notApplicable`/`unassessed`), Spec 30/31 (the
`oversized-orphan-no-ddl` size threshold). None of these three is a
"narrowing" in the enforcement/gating/reporting sense Spec 45 targets; they
introduce a vocabulary and a size threshold. Flagged here for completeness so
the survey does not claim to have read what is not on disk.

---

## Narrowings found (enforcement / gating / reporting axis)

### 1. Spec 36 R2 — diff-scoped enforcement → **reverted by Spec 45 R4**

> "New findings block, existing ones don't."
> "A finding at a line the edit did not touch does not block."

Claude-introduced. Reverted.

### 2. Spec 36 R3 — no bare counts in agent-facing output → **reverted by Spec 45 Amendment A (A2)**

> "The tool never emits '727 findings' to an agent. Only findings, each with file and line."
> "No 'N remaining' progress figure anywhere an agent reads."

Claude-introduced. **Narrowing of what the tool reports.** Directly conflicts
with Spec 45 R1's "Report count before/after and which rules newly block" — the
newly-blocking list is a count summary an agent reads. Reverted by Amendment A
(A2): counts are emitted where useful — per analyzer, per rule, per severity,
before/after the gate.

### 3. Spec 36 R4 — binary gate, no severity tier → **reverted by Spec 45 R2**

> "Severity stays in human reports. The blocking path is binary — a rule either gates or it does not."
> "No severity tier in the gate's decision."

Claude-introduced. Reverted.

### 4. Spec 36 R6 — a rule that cannot name the next action does not gate → **reverted by Spec 45 R1**

> "If a rule can only say what is wrong and not what to do, it belongs in the human report, not the blocking path."
> "Each gating rule produces a resolution alongside the finding."

Claude-introduced. Reverted (the `gating` per-rule opt-in is removed; every rule gates).

### 5. Spec 36 R7 — suppressions decay → **reverted by Spec 45 R3**

> "Suppressions decay."
> "A suppression that outlives its reason is a baseline entry with better branding."

Claude-introduced. Reverted (the decaying-suppression mechanism is removed;
confirmed never built).

### 6. Spec 37 R1 + R2 — `gating`/`resolvable` registry contract → **reverted by Spec 45 R1**

> R1: "Where a rule cannot produce one [resolution] for a given occurrence, it emits the finding non-blocking per Spec 36 R6 and records the gap."
> R2: "`gating: boolean` — participates in the blocking path (Spec 36 R4)."

Claude-introduced. Same narrowing as Spec 36 R6/R4; the `gating` registry field
is removed and every rule gates.

### 7. Spec 38 R3 — gate speed budget ("removed from the gating set") → **reverted by Spec 45 Amendment A (A1)**

> "A rule exceeding its share of the budget is reported by R2 and either optimized or removed from the gating set."
> "Budget: the blocking gate completes in under 300 ms on a single changed file."

Claude-introduced (best judgment — the spec is one of the enforcement/operations
series). **Narrowing of gating:** a slow rule may be *removed from the gating set*,
which is a second, speed-based path back to "some rules don't gate." The 300 ms
budget itself is a performance gate, not a capability narrowing, but the
"removed from the gating set" clause is. Reverted by Amendment A (A1): a slow
rule is optimized, never dropped from the gate; the budget is reported, never
silently widened.

### 8. Spec 39 R2 — applicability predicate → `notApplicable` + emit nothing → **NOT reverted**

> "A rule whose predicate is false reports `notApplicable` with a reason naming the absent input — not silence, and not zero findings."
> "the rule is `notApplicable` with that reason, and it emits nothing."

Ben-introduced (the spec opens with Ben's own instance: "`missing-org-filter`
reports 43 findings on recall-protocol. Recall has no `org_id` …"). This narrows
a rule to emit **zero findings** when its precondition is absent — correct for
`missing-org-filter`, but the mechanism is general and is a genuine narrowing of
what the tool reports (findings become a coverage state). Spec 42 R3 is the same
narrowing applied to knex (434 → 415, −19). Legitimate, Ben-authored, and **not**
reverted — but recorded here so the survey is complete.

### 9. Spec 40 R2 — "Never report undefined when styles were unread" → **reverted by Spec 45 R5**

> "Where any exist [unread sources], `undefined-class` reports `notApplicable` for the affected scope … rather than emitting findings against an incomplete definition set."

Claude-introduced. Reverted.

### 10. Spec 42 R2 — "Never assert undefined when styles were unread" → **reverted by Spec 45 R5**

> "When any exist [unread sources], `styles/undefined-class` reports `notApplicable` for the whole run, naming them."

Claude-introduced. Reverted (the unread-source case is now reportable context on
the finding, not `notApplicable`).

---

## Not narrowings (recorded to bound the survey)

- **Spec 35** — corrective; item 1 *restores* 143 findings after a goalpost move.
  Its "fix the code / fix the rule / calibrate with rationale — no fourth" line
  is Ben's three-path resolution, reaffirmed in Spec 45 R3.
- **Spec 36 R5** — three resolutions, no fourth; threshold change requires a
  `rationale`. Ben reaffirms this in Spec 45 R3 ("no fourth path"); not a
  narrowing Ben objects to.
- **Spec 38 R5** — rule-ID alias map / tombstone for *removed* rules. Identity
  bookkeeping, not a narrowing of a live rule's behavior.
- **Spec 41** — detached jobs, queryable store, provenance, retention. Additive;
  retention pruning is storage hygiene, not enforcement narrowing.
- **Spec 43** — measurement run only ("a measurement run, not a fix run"). No
  narrowing.
- **Spec 44 `cannot-fire`** — "emit an explicit 'rule is broken in the tool'
  diagnostic, do not delete." Ben-approved; explicitly **NOT** to revert.

---

## Summary table

| # | Spec + section | Narrowing | Introduced by | Status |
|---|---|---|---|---|
| 1 | 36 R2 | diff-scoped enforcement | Claude | reverted (R4) |
| 2 | 36 R3 | no bare counts to agents | Claude | reverted (Amendment A, A2) |
| 3 | 36 R4 | binary gate, no severity | Claude | reverted (R2) |
| 4 | 36 R6 | gating opt-in | Claude | reverted (R1) |
| 5 | 36 R7 | suppressions | Claude | reverted (R3) |
| 6 | 37 R1/R2 | `gating`/`resolvable` contract | Claude | reverted (R1) |
| 7 | 38 R3 | slow rule removed from gating set | Claude | reverted (Amendment A, A1) |
| 8 | 39 R2 / 42 R3 | `notApplicable` → emit nothing | Ben | **open (legitimate)** |
| 9 | 40 R2 | undefined-class → notApplicable when unread | Claude | reverted (R5) |
| 10 | 42 R2 | undefined-class → notApplicable when unread | Claude | reverted (R5) |
