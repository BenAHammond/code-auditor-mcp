# Spec 13 — Hotspots & Temporal Analysis

**Ships as:** next minor version, assigned at release time in publish order (tag `spec-13`)
**Depends on:** Spec 12 merged and tagged.

## Context

Complexity alone misranks risk: a complexity-161 function that never changes is a sleeping dog; one that changes weekly is where bugs live. Git history × the index gives churn-weighted prioritization at file and function level, ownership analytics surface bus-factor risk, and the findings ledger gives trend lines. One new violation type ships (diverging clones); everything else makes existing findings better ranked.

## R1 — Churn extraction

1. Read-only git integration by shelling out to git (no library dependency). Window: `churnWindowMonths` (default 12), configurable. No git repo → all temporal features degrade to absent with a one-line notice; nothing errors. No git write operations, ever.
2. `file_churn` table: file → commit count, lines added/deleted, distinct author count, dominant-author share, last-touched. Refreshed on full sync when a repo is present.
3. **Function-level churn:** `function_churn` table populated by mapping `git log -p` hunks to function line-spans per commit — spans resolved against each commit's own tree state (correct as-of that commit; no cross-commit drift problem). File renames via `git log --follow`; function renames detected by span-overlap plus signature similarity, with a `confidence` field on every attribution — low-confidence rows are kept and flagged, never silently dropped or silently trusted. The history walk is windowed by `churnWindowMonths`; its sync-time cost is measured and reported in the evidence.

## R2 — Hotspot scoring and surfacing

1. Hotspot score per function: function churn percentile × complexity percentile, falling back to file churn where function attribution is absent or low-confidence (basis recorded per row). Per file: file churn percentile × max-function-complexity percentile.
2. `code-audit hotspots` — ranked table showing score, basis, and factors; `--json`, `--limit`. New `code_map` section `hotspots`.
3. **Finding reordering:** when churn data exists, findings on every output surface (CLI, HTML, JSON, MCP results) are ordered within severity by the containing function's hotspot score, and each finding carries a `hotspot` field. SARIF excluded — GitHub orders its own.

## R3 — Ownership analytics

Per file and function: distinct-author count and dominant-author share (from R1). Knowledge-concentration flag: single author ≥ 90% of windowed churn on a top-quartile hotspot → "bus-factor risk" entry in the hotspots report. Report-level only, no findings; author identities appear as git reports them and are never sent anywhere.

## R4 — Ledger trends

1. `code-audit ledger stats` gains trends: per rule and per severity, new vs fixed counts over time. Fixed = fingerprint present in full-audit run N, absent in the next full-audit run of the same target; only full-audit runs of the same target are comparable, and the command states its comparison basis.
2. Output includes a net-direction summary per analyzer (improving / worsening / flat over the window).

## R5 — Diverging clones

1. New `dry_pair_history` table: DRY similarity pairs keyed by order-normalized pair fingerprint, storing similarity per full-audit run.
2. Finding (warning severity, via the DRY analyzer): a pair whose similarity decreased across ≥ `divergenceRuns` (default 2) consecutive full audits while both blocks still exist and similarity remains above the DRY floor — "these clones are diverging; merge or intentionally fork them." Message includes both locations and the similarity trajectory.
3. Warning tier at introduction is permitted only because the underlying pair detection is already measured under Spec 11; the divergence fixtures below must still clear the R5 warning-tier numbers or the finding demotes to suggestion.

## R6 — Measurement

Bench gains a scripted git-fixture corpus with synthetic history: a hot file, a cold complex file, a function renamed mid-history (attribution confidence asserted), a single-author hotspot (bus-factor flag asserted), a diverging clone pair across staged commits, and a stable clone pair as near-miss. Hotspot ordering, function-churn attribution, ownership flags, and divergence detection are all asserted against it.

## Acceptance evidence

1. Bench green including git fixtures; no-repo degradation transcript (clean notice, everything else works).
2. Transcript on this repo: `code-audit hotspots` ranked output with per-row basis; audit report showing hotspot-ordered findings with `hotspot` fields; function-churn sync-time cost reported.
3. Ledger trends transcript over the accumulated ledger showing new/fixed per rule with stated comparison basis.
4. Divergence transcript against the git fixture: warning fires with trajectory; stable pair stays silent.
5. Tag `spec-13`; release commit the next minor version at release.

## Out of scope

- Any git write operations.
- Cross-repo history aggregation (single-project boundary, per Spec 12's stated design boundary).
