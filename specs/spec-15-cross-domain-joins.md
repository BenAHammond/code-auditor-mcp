# Spec 15 — Cross-Domain Joins

**Ships as:** next minor version, assigned at release time in publish order (tag `spec-15`)
**Depends on:** Spec 14 merged and tagged (risk rank consumed by R4).

## Context

The index holds domains no single analyzer crosses: schema usage, the call graph, test-file edges, validation functions, and — via ingestion — the user's own coverage data. The joins are where systemic issues live: data written and never read, writers that skip the validation path their peers take, important functions no test reaches.

**Stated product limit (not a deferral):** this tool does not and will not perform dataflow/taint analysis. "Reach" throughout this spec means call-graph membership, not value flow — value-flow tracking requires an engine class this architecture does not have. The docs state this limit plainly.

## R1 — Schema lifecycle findings (via the schema analyzer)

1. **Written-never-read:** tables with INSERT/UPDATE usage and zero SELECT usage across the index → `suggestion` ("may be read externally" stated in the message — external readers are the known false-positive source).
2. **Read-never-written:** the inverse, same severity and caveat (seeded/externally-populated tables).
3. **Transaction-boundary risk:** a function whose own plus depth-1 callee schema usage writes ≥ `txnTableMax` (default 4) distinct tables → `suggestion`, message lists the tables.

## R2 — ORM-aware schema extraction

1. Schema-usage extraction gains an adapter registry (same shape as the language layer). Raw-SQL extraction (current behavior) remains the base layer — raw query call sites continue to be extracted unchanged.
2. Two ORM adapters ship: **Drizzle** and **Prisma** — schema definitions and query-builder call sites mapped to tables and usage types, feeding the same `schema_usage` table R1 joins against.
3. Additional ORMs are adapter contributions; CONTRIBUTING.md documents the adapter contract.

## R3 — Validation-bypass detection

1. Validator set = union of a user-configured `validators` list (analyzer config: function names or `path#name`) and a name-heuristic default (`validate*`, `assert*`, `parse*Schema`). The resolved set is printed by `code-audit config get data-access` — inspectable, never invisible.
2. Among functions with schema **write** usage: if ≥ `modeShare` (default 0.8, corpus ≥ `minCorpus` 20) transitively reach (depth ≤ 3) any validator, writers that reach none → `warning`. The message names the peers' dominant validator. Warning tier requires clearing the Spec 11 R5 warning bars on the fixtures below, else it ships at suggestion — the tier decision is recorded in the recalibration table.

## R4 — Coverage by importance

1. Two coverage bases, per function, best-available wins and the basis is labeled on every row:
   a. **Static reach** (zero-setup default): reached at depth ≤ 2 from a test-glob file, reusing Spec 14's definition.
   b. **Measured execution** (ingested): `code-audit coverage --import <path>` parses standard lcov or istanbul-JSON output the user's own test runner already produced, joined to indexed functions by file + line-span. Parse only — this tool never executes tests. Stale imports (older than the last full sync) are flagged in output.
2. `code-audit coverage --by-risk` — untested functions ranked by Spec 14 risk, `--json`. New `code_map` section `coverage`.
3. One finding: exported functions in the top risk decile with no coverage on the best-available basis → `suggestion` ("high-centrality, high-complexity, untested"), message stating which basis was used.

## R5 — Measurement

Bench fixtures per detector: a written-never-read table plus an externally-read near-miss (seeded SELECT); a 5-table writer plus a 3-table near-miss; a validation-bypass writer among conforming peers plus a no-mode near-miss directory where nothing may fire; an untested top-decile export plus a tested one; a Drizzle fixture and a Prisma fixture asserting table mapping; an lcov import fixture asserting the basis upgrade (statically-unreached function shown covered by ingested data, and the reverse). Triage sample on the Spec 11 pinned corpora per its R4 rules. All thresholds sweepable.

## Acceptance evidence

1. Bench green with all fixtures and baseline; sweep curves for `txnTableMax`, `modeShare`, depth parameters.
2. Transcript on the Spec 11 corpora: each detector either fires with a defensible finding or is shown correctly silent, with the triage section covering whatever fired.
3. `coverage --by-risk` transcript with per-row basis labels, once with static reach only and once after an `--import`.
4. Validator-set inspectability transcript.
5. ORM transcripts: Drizzle and Prisma fixtures indexed, R1 detectors firing correctly against ORM-mapped usage.
6. Recalibration table updated with the new rules' measured numbers; R3's tier decision recorded.
7. Tag `spec-15`; release commit the next minor version at release.

## Out of scope

- Dataflow/taint analysis — per the stated product limit above.
- Test execution or instrumentation of any kind; ingestion parses artifacts only.
- ORM adapters beyond Drizzle and Prisma (contribution path documented).
