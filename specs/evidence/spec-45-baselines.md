# Spec 45 — Corpus Baseline Re-pin (post-revert)

Spec 45 (Revert Unauthorized Narrowings) reverts five restrictions written into
earlier specs without Ben's agreement. Only one of the five touches *what fires*
on real code — R5 (`styles/undefined-class` reports instead of going silent).
R1/R2/R4 change the **gating decision**, not the finding set; R3 removes a
suppression mechanism that was never built. So the expected finding-count delta
across every corpus is zero, except where a corpus carries an unread stylesheet
dialect (`.sass`/`.less`/`.styl`), which is the one case R5 changes.

This re-pins the six validation corpora and attributes every delta to the named
cause. Measurement is read-only: `runAuditDispatch` (the same entry point the CLI
uses) with `CODE_AUDITOR_DATA_DIR` pointed at `/tmp/code-auditor-corpus*`, so no
index DB, ledger, or report lands in any corpus. No `.codeauditor.baseline.json`
is written into any reference repo (see *Boundary* at the end).

## Why the expectation is "zero delta" (per requirement)

- **R1 (every rule gates)** — removes the `gating` per-rule opt-in. The rule
  still produces the same findings; only the *blocking path* membership changes.
  Finding counts are untouched.
- **R2 (severity gates)** — restores severity to the gating decision. Again a
  `computeGatingDecision` concern, not a finding-emission concern.
- **R3 (remove suppressions)** — the decaying-suppression mechanism was never
  built (confirmed: `src/enforcement/suppressions.ts` deleted, no other producer).
  Removing dead code emits no findings.
- **R4 (enforcement not diff-scoped)** — removes diff-scoping from the *gate*.
  The edit-time hook still runs on the changed file (a performance property);
  the full-audit finding set is unchanged.
- **R5 (undefined-class reports with context)** — the one count-affecting change.
  Previously a single unread stylesheet made the whole rule report `notApplicable`
  (zero findings). Now the rule fires and carries the unread-source list as
  `details.incompleteDefinitions`. **This changes counts only when a corpus has
  `.sass`/`.less`/`.styl` files.**

## Headline — totals

| corpus | stack | Spec 44 baseline | Spec 45 (post-revert) | Δ |
|---|---|---|---|---|
| recall-protocol | TS + SQL | 5,042 | **5,042** | 0 |
| knex | TS/SQL builder | 397 | **397** | 0 |
| primer/css | plain CSS | 18 | **18** | 0 |
| blitz | Next.js/TS/React | 898 | **898** | 0 |
| gin | Go | 29 | **29** | 0 |
| svelte-realworld | SvelteKit | 23 | **23** | 0 |

## Delta attribution

Every corpus is **0**. The named cause: none of the six corpora carries an
unread stylesheet dialect. Verified per corpus (`.sass`/`.less`/`.styl` files,
`node_modules` excluded): recall-protocol 0, knex 0, primer/css 0, blitz 0,
gin 0, svelte-realworld 0. Because R5 is the only requirement that changes what
fires, and it is gated on exactly those unread-dialect files, its delta here is
0 by construction — and confirmed by measurement, not assumed.

The `styles/undefined-class` per-rule counts are therefore unchanged from
Spec 44: recall-protocol 47, blitz 15, svelte-realworld 14, knex/primer/gin 0.
The `incompleteDefinitions` context R5 adds is carried on the finding object but
does not change how many findings exist.

R1/R2/R4/R3 are count-neutral on every corpus by construction (gating and
dead-code only), and the measurement confirms it: per-analyzer and per-rule
breakdowns are byte-identical to the Spec 44 baseline tables recorded in
`spec-44-corpus-baselines.md`, so they are not duplicated here.

## Per-corpus verification (reproduced)

```
recall-protocol  → advisory findings: 5042   (Spec 44: 5042)
knex             → advisory findings:  397   (Spec 44:  397)
primer/css       → advisory findings:   18   (Spec 44:   18)
blitz            → advisory findings:  898   (Spec 44:  898)
gin              → advisory findings:   29   (Spec 44:   29)
svelte-realworld → advisory findings:   23   (Spec 44:   23)
```

## Boundary

Per the repository-boundary constraint, no `.codeauditor.baseline.json` was
written into any corpus — recall-protocol, knex, primer/css, blitz, and the two
`bench/real/` clones are read-only reference. This file is the re-pinned record.

The one corpus whose *committed* baseline file remains stale is unchanged from
Spec 44's note: `recall-protocol/.codeauditor.baseline.json` (toolVersion 3.4.18,
total 4,589) still does not reflect the tool's current 5,042. Re-pinning that
file into recall-protocol requires Ben's authorization (the same rule as
publishing); it is deliberately left untouched here.
