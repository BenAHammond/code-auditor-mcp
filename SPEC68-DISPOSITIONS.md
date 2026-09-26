# Spec 68 — Disposition working notes

Scratch working notes for the three §13 dispositions + section progress. Folded
into the final report; not a shipped deliverable.

## Disposition 1 — unknown-table, 202 critical

**Question:** does the rule resolve tables declared by `CREATE TABLE` in
TypeScript template literals (how `codeIndexDB.ts` defines schema)?

**Answer: YES — the rule resolves them correctly.** Proven empirically: all ~30
tables declared via `this.db.exec(\`CREATE TABLE …\`)` in `codeIndexDB.ts`
(`functions`, `style_declarations`, `style_tokens`, `style_class_usage`,
`conventions`, `file_churn`, `function_churn`, `coverage_data`,
`findings_ledger_*`, `audit_results`, `code_maps`, `project_tasks`,
`schema_definitions`, `schema_usage`, `graph_cache`, `function_calls`,
`function_dependencies`, `import_specifiers`, `analyzer_configs`,
`dry_pair_history`, `hotspot_scores`, `meta`, `whitelist`, …) appear **zero**
times in the unknown-table findings. The `schema-code` visitor's `doTemplateDDL`
regex (`pipelineAdapters.ts:2817`) captures `db.exec(\`CREATE TABLE…\`)` template
literals, and the `schema` reducer replays them into `knownTables` (step 1a).

**The "202 critical" figure is a full-app audit (`--path .`), not `--path src`.**
Reproduced: `runAuditDispatch({ projectRoot: app })` → 1164 findings
(244 critical / 262 severe / 658 high), 202 unknown-table + 1 stale-table-reference.
`--path src` → 675 findings, 70 unknown-table. The prior session's "1164 / 202"
was the full-app number, mislabeled as "self-audit (`--path src`)".

**Breakdown of the 202 unknown-table (full-app):**

- **~190 = synthetic test fixtures + benchmark corpora** — `tests/fixtures/**`,
  `tests/samples/**`, `src/__tests__/fixtures/**`,
  `src/analyzers/**/__tests__/**`, `bench/corpus/**`, `bench/recall-fixture/**`.
  Deliberately fake names: `orders`, `entities`, `user`, `posts`, `items`,
  `products`, `heroes`, `quests`, `villains`, `phantom_table`, `void_table`,
  `non_existent_table`, `missing_table`, `ghost_table`, `ghost_ratings`,
  `invalid_posts`, `phantom_articles`, … These are **genuinely absent** — the
  rule's own test corpus, not a false-positive class. They are correct behavior.
- **~12 = real-source false positives, a DIFFERENT class** (not
  "CREATE TABLE unseen"):
  - `callers` (5) — `WITH RECURSIVE callers(id, caller_name, depth)` CTE name
    (`codeIndexDB.ts:2078`, `graph/blastRadius.ts`). Flagged as a table ref.
  - `deps` (2) — `WITH RECURSIVE deps(id, callee_name, depth)` CTE name
    (`codeIndexDB.ts:2055`).
  - `paths` (2) — `WITH RECURSIVE paths(start_name, path, current_name, depth)`
    CTE name (`codeIndexDB.ts:2101`).
  - `coverage` (1) — subquery alias `LEFT JOIN coverage c` (`codeIndexDB.ts:3664`).
  - `best_coverage` (1) — subquery alias `LEFT JOIN best_coverage bc`
    (`codeIndexDB.ts:3710`).
  - `schema_usage_old` (1) — transient rename `ALTER TABLE schema_usage RENAME
    TO schema_usage_old` (`codeIndexDB.ts:891`); the reducer's drop-provenance
    does not register the rename target.

**Conclusion:** the disposition's hypothesized "declared-in-code-unseen" class
does not exist. No red-first fix for template-literal resolution is warranted.
The 202 is not "202 false criticals shipping in 4.1.1" — it is ~190 deliberate
test fixtures + ~12 pre-existing CTE/alias false positives. The CTE/alias class
is a real (small) bug but is out of scope for this disposition and predates it.

## Disposition 2 — dependency-graph, 180

**Question:** split the 180 before/after the hub-nodes reshape.

**Measured (full-app audit, `--path .`), fresh index:**

| state              | total | orphaned-nodes | unreferenced-module | hub-nodes | tight-coupling |
|--------------------|-------|----------------|---------------------|-----------|----------------|
| before reshape     | **155** | 82           | 71                  | **1**     | 1              |
| after reshape      | **180** | 82           | 71                  | **26**    | 1              |

The reshape (`0c27bdc`) is the *entire* delta: `recordHubCheck` emits one
`hub-nodes` issue whose `details.hubs` carries all 26 hubs. Pre-reshape, the
generic branch anchored that single issue to the first hub (1 finding, all hubs
in the message); post-reshape, the dedicated branch emits one finding per hub at
its own file/line (26 findings). Orphaned/unreferenced/tight-coupling are
byte-identical across the reshape.

**Conclusion:** the "180" the prior session measured is the **post-reshape**
number. The clean §13 "before" baseline for dependency-graph is **155**; the
+25 is the hub-nodes reshape, attributable to exactly one cause (1→26 hub
findings).

## Disposition 3 — data-access-org-filter, 0

**Question:** what coverage state does the `data-access-org-filter` analyzer
actually emit? A `clean` here would be a regression against Amendment B
criterion 23 (the prior tier-asymmetry defect reported `clean` on a real
multi-tenant leak).

**Answer: it emits `notApplicable`, never a false `clean`.** The analyzer's
only rule is `missing-org-filter` (`ruleRegistry.ts:711`), and its coverage is
decided by two independent gates, both of which report `notApplicable` when the
corpus declares no org-filter tenancy:

1. **Node TS pipeline** — `evaluateMissingOrgFilterApplicability`
   (`applicability.ts:309-320`) builds the tier set via
   `buildOrgFilterTierSet` and checks `hasDeclaredTenancy`. When no tenant
   column exists in any tier it returns `applicable: false` with reason
   `"no tenant-scoping column found in table catalog"` → Spec 39 diverts the
   rule to `notApplicable` and removes any finding *before* the
   `resolveZeroViolationState` `clean` branch is ever reached. This is the exact
   Amendment B fix: applicability and firing both derive from one tier function,
   so they cannot drift.
2. **Go half** — `goUndeclaredTenancyRules` (`auditRouter.ts:304-313`) maps
   `missing-org-filter` → `"no org-filter tables declared"` when
   `orgFilterTables` is empty.

**Measured:**
- `src/` only → `missing-org-filter` = `notApplicable` count 0, reason
  "no org-filter tables declared (no .codeauditor.json or DDL tenancy)";
  `unfiltered-query` = `clean` count 0.
- full-app (`.` incl. Go corpus fixtures) → `missing-org-filter` = `fired`
  count **2** — both are Go-side findings (the bench/test Go fixtures declare
  tenancy, so the Go analyzer legitimately fires). The Node Stage-4 reducer
  emits 0.

**Conclusion: no regression against Amendment B criterion 23.** The "0" in the
disposition is an honest `notApplicable` ("no tenant-scoping column declared in
the app's own source"), not a false `clean`. When tenancy *is* declared (the Go
corpus), the rule fires (count 2), and applicability is derived from the same
tier set as firing.
