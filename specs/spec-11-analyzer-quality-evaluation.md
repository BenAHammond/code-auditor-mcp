# Spec 11 — Analyzer Quality Evaluation & Recalibration

**Project:** code-auditor-mcp
**Ships as:** v3.2.0 — this spec adds the series' third publish point, extending Amendment A1's pattern: tag `spec-11`, set version, Ben publishes.
**Done means:** merged to `main`, tagged `spec-11`, all evidence produced, release commit prepared.
**Depends on:** Spec 10 merged and tagged.

## Context

The entire series treated analyzer verdicts as ground truth: storage, scoping, transport, and enforcement were built around findings whose correctness has never been measured. The GoAdapter revelation proved the gap — a stub produced nothing for the tool's whole life and no gate noticed, because every existing gate asserts behavior, not truth. The agent-loop pivot raises the stakes: a false positive at `critical` severity blocks an agent mid-edit and feeds it a wrong correction, and a violation message is now a prompt the agent acts on, not documentation a human skims. This spec builds permanent detection-quality infrastructure, measures every analyzer, tunes every asserted threshold empirically, and recalibrates severity so blocking rights are earned, not assumed.

## R1 — Findings ledger (productizes Directive D1)

1. New SQLite table `findings_ledger`, append-only, surviving `clearIndex` like user-authored data: one run record per audit invocation (timestamp, git SHA + dirty flag, tool version, command/surface, scope, target, duration, exit status) with child rows per finding (analyzer, rule, severity, message, location, fingerprint) — verbatim, unfiltered, zero-finding runs included.
2. Every audit surface (CLI, MCP, library, hook path) writes to the ledger unconditionally as part of the run. No flag, no opt-out; it is local data in the user's own data dir.
3. `code-audit ledger` subcommand: `list` (runs, summarized), `export --json [--since <ISO>]` (full dump), `stats` (per-analyzer/per-rule finding counts and severity distribution across runs). MCP: no new tool — ledger data is reachable via `audit` tool `results` action semantics only if already natural; otherwise CLI-only, documented as such.
4. Import: `code-audit ledger import <dir>` ingests the D1 interim archive files (their format from the directive) so the interim data seeds the ledger. Run it on `bench/ledger-interim/` as part of this spec; the interim directory is then deleted and D1 is retired.

## R2 — Benchmark corpus and harness

1. `bench/corpus/` — per-analyzer fixture projects with labeled ground truth. Each fixture ships an `expected.json`: seeded true violations (matched by fingerprint or file+rule+symbol) **and** explicit near-miss files asserted to produce zero findings — near-misses are what measure false-positive rate, and every analyzer gets them. Coverage: solid, dry, react, documentation, data-access, schema, invariants (all five kinds), styles (all Spec 10 detectors).
2. `pnpm bench` — the harness runs every analyzer over the corpus and computes per-analyzer, per-rule precision, recall, and F1 against the labels. Output: a machine-readable report (`bench/results/latest.json`) and a human table.
3. CI regression gate: `bench/baseline.json` is committed; the harness fails if any rule's precision or recall drops below baseline (small float tolerance for tie-breaking nondeterminism, stated in the harness). Baseline updates are deliberate commits with the delta explained — detection quality gets the same regression protection behavior has.
4. The harness is permanent infrastructure with its own tests, not a one-off script.

## R3 — Empirical threshold tuning

1. Every asserted statistical threshold gets sweep tooling: the harness sweeps a parameter range against the corpus and emits the precision/recall curve. In scope: DRY similarity threshold; styles `colorDeltaE`, `outlierMaxShare`, `modeMinCount`, `similarityThreshold`, `zIndexMaxDistinct`, `minCorpus`; react `wrapperMinUsages`.
2. Shipped defaults are updated to the empirically chosen operating point per curve (chosen for precision-first at default severity, since defaults feed the hook path). Each new default is recorded in the report with its curve; a default that survives the sweep unchanged is recorded as confirmed, not assumed.
3. Sweep tooling stays in the repo (`pnpm bench --sweep <param>`) so future threshold changes are tuned, not asserted.

## R4 — Real-corpus triage

1. Corpora: (a) this repo at the `spec-10` tag; (b) `excalidraw/excalidraw` pinned at a recorded SHA (MIT; React+TS at scale); (c) `gin-gonic/gin` pinned at a recorded SHA (MIT; Go). External corpora are cloned into `bench/real/` by a pinned-SHA fetch script, not vendored.
2. Full audit of each corpus; every finding is triaged by the implementor into exactly one of: **true** (real issue, correctly located, actionable), **false** (not a real issue), **true-but-useless** (technically correct, no reasonable action follows). One-sentence rationale per finding. High-volume rules may be triaged on a random sample of ≥50 findings per rule per corpus, with the sampling stated; everything else is exhaustive.
3. Output: `bench/results/triage-report.md` — per-analyzer, per-rule judged-true rates alongside the R2 benchmark numbers. Where benchmark precision and judged-true rate disagree sharply, that gap is called out: it means the corpus fixtures don't represent reality and the corpus gets a follow-up fixture derived from the real false positives (closing the loop: real-world failures become permanent regression labels).
4. No runtime LLM enters the product anywhere in this spec. Triage is implementor labor producing a committed report.

## R5 — Recalibration

Applied from R2+R3+R4 results, with the decision rules fixed here so outcomes are mechanical:

1. **Blocking rights:** a rule keeps or gains `critical` default severity only if benchmark precision ≥ 0.95 **and** judged-true ≥ 0.90 across real corpora. Rules failing the bar demote to `warning`. Deterministic invariant kinds (import-ban, call-constraint, module-boundary, naming) are expected to pass trivially; if any doesn't, that's a bug to fix, not a demotion.
2. **Floor:** any rule with judged-true < 0.50 is disabled by default (remains selectable via analyzer config, documented with its measured numbers). Between 0.50 and the blocking bar: enabled at `warning` or `suggestion` per its numbers.
3. **Message rewrite:** every rule surviving at `warning` or above gets its message rewritten to name the action, not just the observation — the message is the prompt the agent executes. Standard: a competent agent reading only the message and location knows what change to attempt. Before/after for every rewritten message in the report.
4. The full recalibration lands as one table in the CHANGELOG: rule, old severity, new severity, benchmark precision, judged-true rate, message changed y/n.

## R6 — Honest documentation

README's analyzers section is rewritten around the measured split: **deterministic** (invariant kinds — facts, safe to block on) versus **advisory** (heuristic analyzers — measured precision stated per analyzer, defaults tuned accordingly). The positioning gets sharper, not weaker: project-specific invariants you can trust to block, plus advisories that know they're advisories. No measured number is omitted for being unflattering.

## Acceptance evidence

1. `pnpm bench` green in CI with committed baseline; harness tests green; full suite green.
2. Ledger populated across all four surfaces (one transcript each); D1 interim files imported, directory removed, D1 noted retired in the CHANGELOG.
3. Sweep curves for every R3 parameter with chosen operating points; defaults diff.
4. Triage report with per-rule judged rates, sampling disclosures, and the benchmark-vs-reality gap analysis; follow-up fixtures added for any sharp gaps.
5. Recalibration table; message before/afters; README analyzers section rewritten.
6. Tag `spec-11`; release commit sets v3.2.0; Ben publishes.

## Explicitly out of scope

- New detection capabilities or analyzers — this spec measures and calibrates what exists.
- Any runtime LLM integration in the product.
- Auto-fix generation from findings.
