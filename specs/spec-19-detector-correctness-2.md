# Spec 19 — Detector Correctness, Round 2

**Ships as:** next minor version, assigned at release time in publish order (tag `spec-19`)
**Sequencing:** after Spec 18. Revised forward order: 17 → 18 → 19 → 11 → 10 → 12 → 13 → 14 → 15.
**Source data:** the 27-sample warning-tier triage of the post-17 recall corpus (committed verbatim, unedited, to `bench/diagnostics/2026-07-recall-warning-triage.md` with a hash-assertion test, same pattern as the first diagnostic). Sample verdicts: 9 true / 8 false / 10 useless. Every requirement cites sample items by number.

## Context

The triage converts four presumed-calibration questions into identified defects. Most serious: `solid/method-complexity` fires on functions the triage measures at cyclomatic complexity 1 (items 11, 12, 17), contradicting Spec 17 fixture 17 which proved the cyclomatic path at complexity 59 — a shipped gate passed while the product misbehaves, meaning a second code path or a broken metric survived R5. The data-access false positives (items 2, 5, 6, 9, 10) share one root: no shared, gated DB-call detection. The DRY uselessness (items 21–25) is partly rules that should not exist.

## R1 — method-complexity: root cause the complexity-1 firings

1. **Diagnose before fixing.** Reproduce items 11 (52-line function of complexity 1: one SQL call + `.map()` + large JSDoc), 12 (branchless JSX presentational component), and 17 (data-payload assembly) as fixtures. Determine which path produced the findings: a surviving line-count rule (`maxFunctionLines`-style) still mapped to the `solid/method-complexity` id, `adapter.getComplexity()` returning line-derived or wrong-node values for arrow functions/JSX/methods, or flagging attributed to the wrong node (file/class instead of function). The diagnosis is written into the spec-19 CHANGELOG entry — which path it was, in one sentence.
2. Fix accordingly. Post-fix, all three fixtures produce **zero** `method-complexity` findings at default config; fixture 17 from Spec 17 (complexity 59) still fires. If a legitimate long-function rule was the culprit, it gets its own rule id (`solid/function-length`), `suggestion` severity, default-off until Spec 11 measures it — length is not complexity and never reports under a complexity id again.
3. Add per-node-shape unit tests for `getComplexity()`: function declaration, arrow function, class method, JSX component, generator — each with hand-counted expected values. This is the same class of guard as the Spec 17 node-type smoke tests: a metric that silently returns garbage for one node shape must break the suite.

## R2 — Shared DB-call detection (the data-access false-positive root)

1. New shared module (one implementation, consumed by BOTH the schema and data-access analyzers — the single-extractor principle from Spec 18 item 3 applies): a call expression is a DB call iff the receiver matches `dbReceiverNames`/`dbBindingNames` (Spec 17 item-6 heuristic, config-shared) AND the method name **exactly equals** an entry in `dbCallMethods`. Exact match, never substring or prefix — `findIndex` matching `first`/`find`-family entries (item 5) must be impossible by construction.
2. **loop-query requires a DB call inside the loop body.** A loop with no detected DB call in its body produces nothing, regardless of what precedes or follows it: item 6 (in-memory iteration) and item 2 (loop body calls only an LLM function; the insert is a batch call outside the loop) become fixtures asserting zero findings. Item 3's real per-iteration `INSERT … RETURNING` shape becomes the positive fixture.
3. **Batch-awareness:** calls matching a configurable `dbBatchMethods` list (default `['batch']`) inside a loop body are not loop-query findings — batching inside a loop is the remediation, not the disease.

## R3 — sql-injection: context gating and interim demotion

1. The injection rule consumes the R2.1 shared detection: a template-literal interpolation is a candidate only when the template is the argument of a detected DB call or a configured SQL tag. Item 9 (Playwright `page.evaluate` CSS selector) becomes a zero-finding fixture — `evaluate` on a non-DB receiver is out of scope by construction.
2. Interpolations that resolve to a closed set of literals (ternary/conditional over string literals, `as const` narrowing — item 10's type-narrowed table name) are recognized where statically resolvable and suppressed; the finding message for remaining hits states what made the interpolation flag-worthy (unresolvable expression in a SQL argument position).
3. **Severity: `warning` → `suggestion`.** Sample precision at warning tier was 0/2 after the context fixes were already supposedly in place; the rule holds no elevated tier until it clears Spec 11's bars. `severityOverrides` remains the user path up; CHANGELOG and the README security section updated (second demotion of this rule — the section says so plainly rather than pretending it's the first).

## R4 — DRY sub-rule retirement

1. `duplicate-import` (items 21–23) and `duplicate-string`/duplicate-CSS-class (items 24–25) sub-rules are **disabled by default**, with the measured rationale recorded (0 actionable in sample; cross-file import/constant/class reuse is how modules work). They remain selectable via analyzer config for anyone who disagrees, documented with their numbers.
2. Block-duplication (`dry/duplicate`) and `dry/structural-similarity` are untouched — items 19, 20, 26, 27 are true-but-useless calibration material, not defects; they are Spec 11's problem and this spec does not pre-empt the measurement.

## R5 — Triage artifact and fixtures

1. The 27-sample triage committed verbatim at `bench/diagnostics/2026-07-recall-warning-triage.md`; hash-assertion test, same as the first diagnostic.
2. Every cited item above ships as a synthetic fixture (structurally equivalent code, report-item cited in a comment): items 2, 3, 5, 6, 9, 10, 11, 12, 17 minimum. All absorbed by Spec 11 as labeled bench entries.

## Acceptance evidence

1. Full suite green including all new fixtures and the `getComplexity()` per-shape unit tests; the R1.1 diagnosis sentence present in the CHANGELOG.
2. Re-run of the triage's own sample set against the fixed build: items 2, 5, 6, 9, 10, 11, 12, 17 produce zero findings; items 1, 3, 4, 7, 8, 13, 15, 16, 18 still fire. (The triage table is the regression oracle for itself.)
3. Full-audit warning count on the recall-shaped corpus classes drops accordingly; per-analyzer before/after recorded in `bench/baselines/` alongside the spec-17 deltas.
4. Hook path unaffected verification: `--fail-on critical` behavior identical before/after (nothing here touches critical).
5. Docs: CHANGELOG (R1 diagnosis, R3 second demotion, R4 retirements with numbers); README security section updated.
6. Tag `spec-19`; release commit takes the next minor version.

## Out of scope

- True-but-useless calibration (DRY block thresholds, structural-similarity default, per-path profiles for scripts/tests) — Spec 11, now with two labeled diagnostics and this spec's fixtures as its opening corpus.
- Any new detection capability.
