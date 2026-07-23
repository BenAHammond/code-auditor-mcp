# Spec 18 — Baseline, Ratchet & Report Inversion

**Ships as:** next minor version, assigned at release time in publish order (tag `spec-18`)
**Sequencing:** immediately after Spec 17. Revised forward order: 17 → 18 → 11 → 10 → 12 → 13 → 14 → 15.
**Basis:** the post-17 recall-corpus run — 11,477 findings, 0 critical. Individually mostly true; collectively unreadable. Severity answers "how bad if true"; nothing in the output answers "what do I do today." This spec makes the delta the product and the inventory a tracked liability.

## Context

A full audit of any mature codebase yields thousands of true-but-accumulated findings. Presenting accumulated debt as an action list guarantees the output is ignored, which destroys trust in the findings that *do* need action. The fix is the ratchet model: accepted debt is snapshotted by fingerprint; audits thereafter surface what is new, what got fixed, and which direction the debt is moving. The Spec 02 fingerprint (stable under line drift) is the enabling primitive and already exists on every finding.

## R1 — The baseline

1. `code-audit baseline` writes `.codeauditor.baseline.json` at the project root: the fingerprint set of all current advisory findings, plus metadata (tool version, date, per-analyzer counts, corpus stats). Committed to the user's repo by design; the docs say so.
2. **Invariants are never baselined.** Findings from the `invariants` analyzer are excluded from the snapshot and from all baseline matching. Declared laws are enforced on all code, always — only descriptive/advisory findings are grandfathered. The command output states this exclusion every time it runs.
3. Re-running `baseline` re-snapshots current state (fixed findings drop out, new ones are absorbed). It prints what it is absorbing — count of previously-new findings entering the baseline — so absorbing regressions is a visible act, never a silent one.
4. Baseline matching is by fingerprint only. A finding whose fingerprint is absent from the baseline is **new**; present is **known**; baseline fingerprints matching nothing in the current run are **fixed**.

## R2 — Report inversion

1. Default human output of a full `audit` becomes the summary report, in order: (a) the delta headline — new N / fixed M / known debt K with direction vs the previous full run of the same target (ledger provides the previous run); (b) new findings, itemized in full — these are the action queue; (c) per-analyzer debt counts; (d) top-10 files by finding count (enriched by hotspot score when Spec 13 lands; count-ranked until then); (e) one line on how to see everything.
2. The full itemized inventory moves behind `--full`. JSON output keeps its complete shape unconditionally, gaining `new: boolean` per finding and a `baseline` summary block. HTML report gains the same summary-first structure with the inventory in a collapsed section.
3. No baseline file present → nothing is "known," every finding is new, output is the current behavior. First-run experience: the summary ends with one suggestion line: run `code-audit baseline` to adopt the ratchet. Never auto-created.

## R3 — Failure semantics

1. With a baseline present, `--fail-on <severity>` evaluates **new** findings plus all invariant findings. Known (baselined) findings never fail a run. With no baseline, behavior is unchanged — the semantics are strictly additive.
2. `--include-baseline` restores evaluation over everything, for users who want the old totality gate.
3. The ratchet direction is enforceable: `--fail-on-regression` fails if known-debt count increased versus the baseline metadata (someone absorbed new debt without re-baselining). Optional flag, off by default.

## R4 — Hook path (`changed`)

1. Scoped runs classify each finding against the baseline the same way. Default hook behavior: **block on new findings and invariants at the configured threshold; report known findings as informational** ("2 pre-existing findings in files you touched"), never blocking. Touching a file does not make you responsible for its history; the hook's contract is "don't make it worse."
2. Config `hookIncludeKnown: true` for teams that want boy-scout enforcement (known findings in touched files also count against the threshold).

## R5 — Surfaces and interplay

1. `tasks from_audit` gains `--new-only` (default true when a baseline exists) so the remediation queue is the delta, not the inventory; `--all` restores full generation.
2. SARIF output is unchanged in content — GitHub performs its own new-vs-existing comparison via the same partialFingerprints — but gains a `properties.baseline` marker per result (`new` | `known`) for non-GitHub SARIF consumers. Documented interplay note: on GitHub, prefer letting code scanning do the delta; the baseline file is for local/CI-gate use.
3. Ledger records the baseline state per run (baseline hash, new/fixed/known counts) so Spec 13's trend output can plot debt direction directly.
4. MCP `audit results` carries the same `new` flags and baseline block as JSON.

## R6 — Measurement and fixtures

Fixtures: a project with a committed baseline where (a) an untouched known finding does not fail `--fail-on warning`, (b) a newly introduced finding does, (c) an invariant violation fails regardless of any baseline content, (d) fixing a baselined finding surfaces it as fixed and `baseline` re-snapshot drops it, (e) `changed` on a file containing one known + one new finding blocks on the new one only and reports the known one informationally, (f) fingerprint stability — reordering lines above a known finding does not make it new. Spec 11 inherits these as bench entries; baseline correctness becomes regression-protected like everything else.

## Acceptance evidence

1. Full suite green including R6 fixtures.
2. Transcript on a real corpus: full audit (no baseline) → `code-audit baseline` → re-audit shows new 0 / fixed 0 / known N summary-first output → introduce one violation → re-audit headlines exactly 1 new and `--fail-on warning` exits nonzero → fix it → re-audit shows 1 fixed.
3. Hook transcript per R4: known-finding file edit passes with the informational line; new-finding edit blocks; invariant violation blocks with or without baseline.
4. JSON/SARIF/MCP samples showing the `new` flags and baseline blocks.
5. Docs: README ratchet section (the "adopting on an existing codebase" story is the lead — this is the first-run answer), CHANGELOG entry, skill updated to teach `baseline` and the delta workflow; A2 skill-accuracy gate re-run.
6. Tag `spec-18`; release commit takes the next minor version.

## Out of scope

- Per-finding confidence/impact scoring — Spec 11 (measured precision) and Specs 13/14 (hotspot, blast radius) enrich the report when they land; the summary structure above already reserves their slots.
- Baseline sharing/merging across branches beyond ordinary git merge of the JSON file (documented: conflicts resolve by union).
- Auto-expiry or aging of baselined findings.
