# Spec 14 — Graph & Architecture Metrics

**Ships as:** next minor version, assigned at release time in publish order (tag `spec-14`)
**Depends on:** Spec 13 merged and tagged.

## Context

The call graph and import graph support decades-proven network analysis the per-function analyzers can't see: which functions are load-bearing (centrality), where the real module boundaries sit (community detection vs directory structure), which packages are architecturally unstable (Martin metrics), and what an edit actually reaches (blast radius). All advisory — reports and annotations, not violations — because architecture findings are judgments the user weighs, not laws the hook enforces.

## R1 — Graph construction

1. Two graphs built from existing tables at full sync, both **edge-weighted**: the function call graph (`function_calls`, weight = call-site count; unambiguous name resolution, unresolved externals excluded and counted) and the file import graph (weight = imported-symbol count). Cached adjacency in SQLite; rebuilt on full sync, incrementally patched on scoped sync.
2. Graph stats (nodes, edges, unresolved share) exposed in `index status` — an unresolved share above 30% is reported prominently since it degrades everything downstream.

## R2 — Centrality and risk ranking

1. **PageRank** on the weighted call graph (iterative implementation, no dependency; damping 0.85, convergence 1e-6, iteration cap stated).
2. **Betweenness centrality** (Brandes) on the same graph — exact up to `betweennessExactNodeCap` (default 2,000 nodes), Brandes–Pich pivot-sampled approximation above it (pivot count stated in output). Betweenness catches bridge functions — chokepoints between communities — that PageRank underweights. Both centralities run at full sync only, never in the hook path.
3. Risk rank per function: max(PageRank percentile, betweenness percentile) × complexity percentile × (1 + untested), where untested = no transitive call edge (depth ≤ 2) from any file matching test globs (default `**/*.{test,spec}.*`, `**/__tests__/**`, configurable).
4. `code-audit risk` — ranked list with all factors shown per row, `--json`, `--limit`. New `code_map` section `risk`.

## R3 — Community detection vs directory structure

1. Louvain community detection (own implementation, no dependency) on the weighted file import graph.
2. Report per directory: purity (share of its files in the directory's plurality community) and an overall structure-agreement score. Split candidates: directories spanning ≥2 communities with ≥ `communityMinFiles` (default 5) files each. Merge candidates: one community dominating ≥2 directories.
3. Surfaced via `code-audit architecture` and a `code_map` section `architecture`. Report only — no findings.

## R4 — Instability and abstractness

Per directory (treated as package): Ce, Ca, instability I = Ce/(Ca+Ce); abstractness A = exported type/interface declarations ÷ exported symbols (TS; Go uses interfaces + type defs); distance from main sequence D = |A + I − 1|. Included in the `architecture` report, ranked by D. Report only.

## R5 — Graph output formats

1. `code-audit architecture --format dot|mermaid` — emits the file import graph colored by detected community.
2. `code-audit risk --format dot` — emits the call-graph neighborhood (depth 2) of the top-N risk functions.
3. Standard formats only; rendering stays the consumer's tool (Graphviz, Mermaid). Zero rendering dependencies.

## R6 — Blast radius in the hook path

1. Scoped audits annotate output with impact per edited function: transitive caller count (depth cap 10) and count of reachable exported symbols. One `impact` object in the `--json` schema; one line in human output ("reaches 14 callers, 3 exports").
2. Hard latency budget: impact computation adds ≤ 100ms to a scoped run at this repo's scale, measured in the evidence. If the budget is missed, impact ships disabled by default with the measurement documented — the hook's sub-second promise outranks the feature.

## R7 — Measurement

Bench gains a synthetic graph fixture: known PageRank ordering, a planted bridge function (high betweenness, modest PageRank — asserts the two centralities disagree where they should), planted communities misaligned with directories, a planted untested-central function, and weighted edges whose weights change the ranking versus unweighted (asserting weights are actually used). PageRank, Brandes (exact and sampled), and Louvain implementations each have unit tests against hand-computed small graphs. Judged triage does not apply — no violations ship from this spec; the Spec 11 bars apply if any metric is ever promoted to findings, which is out of scope here.

## Acceptance evidence

1. Bench green with graph fixtures; algorithm unit tests green.
2. Transcripts on this repo: `code-audit risk` (factors shown, bridge/PageRank columns both populated), `code-audit architecture` (purity table, main-sequence table), `index status` graph stats, and one `--format dot` output rendered locally to confirm it's valid Graphviz input.
3. Hook transcript showing the `impact` annotation with the latency measurement against the R6.2 budget.
4. Sampled-betweenness path exercised in tests (fixture above the cap) even though this repo sits below it.
5. Tag `spec-14`; release commit the next minor version at release.

## Out of scope

- Any violation-severity findings from architecture metrics.
- Interactive visualization or rendering (standard-format emission only, per R5).
