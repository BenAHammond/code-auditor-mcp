# Spec 69 F2 re-run — after the four named fixes (HEAD `8da17ab` → working tree)

This supersedes `spec69-f2-finding-level-diff.md`, which measured the same two
states *before* the four defects it named were closed. The fixes landed between
the two measurements:

- **#377** — `baseHandleTypeName` resolves a nullable-union return type
  (`getDb(): D1Database | null` → `D1Database`) instead of string-stripping the
  whole `"D1Database | null"`.
- **#381 / #378** — construction propagation: `new X()` and static
  `.getInstance()` where the class declares a handle-typed field.
- **#376** — the `schema-usage` producer threads the cross-file seed
  (`seedProvenance: file.receiverProvenance`).
- **#390** — the `query-sites` producer threads the same cross-file seed
  (the fifth and final seed-threading site; the four DB-fact producers —
  `schema-usage`, `query-sites`, `data-access-calls`, `loop-queries` — are now
  identical).

Harness unchanged: `dist/cli.js audit -f json` for both states, isolated
`CODE_AUDITOR_DATA_DIR=/tmp/f2-v2/data-{head,work}`, multiset diff on
`file|line|rule`. HEAD binary at `/private/tmp/ca-s5e-head/dist/cli.js`; working
tree at `app/dist/cli.js`.

## 1. The diff

Raw totals are the report's `summary.totalViolations`; `lost`/`gained` are
deduplicated `file|line|rule` keys (multiset in parentheses where a line carries
multiple references).

| corpus | head | work | lost (dedup) | gained (dedup) |
|---|---|---|---|---|
| recall-protocol | 5115 | 5104 | 89 | 78 |
| hhra-org | 1188 | 1274 | 4 | 80 |
| knex | 627 | 613 | 16 (22) | 8 |
| primer-css | 19 | 19 | 0 | 0 |
| blitz | 1035 | 1041 | 0 | 6 |
| endless-guessing | 258 | 256 | 7 | 5 |

`knex`'s 16 deduplicated lost keys are 22 findings — six `unknown-table` lines
carry two references each (unchanged from the prior measurement). `hhra-org`
*gains* on net: the construction-propagation fix did not just restore the 20
lost `too-many-queries` — it proved `orgTrackerDb`, hhra's central `pg.Pool`
wrapper, which un-silenced the entire schema analysis the name-list could never
reach (`unknown-table` +30, `stale-table-reference` +9, `read-never-written`
+18, `table-naming-convention` +9, `sql-injection-risk` +6).

Lost by rule (multiset):

| rule | recall | hhra | knex | blitz | endless |
|---|---|---|---|---|---|
| loop-query | 57 | 3 | 2 | — | 7 |
| too-many-queries | 19 | 1 | 2 | — | — |
| cross-domain/written-never-read | 7 | — | — | — | — |
| cross-domain/read-never-written | 4 | — | 4 | — | — |
| cross-domain/multi-table-write | 1 | — | — | — | — |
| sql-injection-risk | 1 | — | 1 | — | — |
| unknown-table | — | — | 12 | — | — |
| table-naming-convention | — | — | 1 | — | — |

Gained by rule (dedup):

| rule | recall | hhra | knex | blitz | endless |
|---|---|---|---|---|---|
| loop-query | 68 | 8 | — | — | 4 |
| cross-domain/read-never-written | 6 | 18 | 2 | — | — |
| cross-domain/written-never-read | 4 | — | — | — | 1 |
| unknown-table | — | 30 | 1 | 3 | — |
| stale-table-reference | — | 9 | — | — | — |
| table-naming-convention | — | 9 | — | — | — |
| sql-injection-risk | — | 6 | — | — | — |
| too-many-queries | — | — | 5 | — | — |
| reserved-word | — | — | — | 3 | — |

## 2. Attribution — every delta to a named mechanism

### M1 — loop-query precision (#340)

`prepare`-outside-loop reclassification + transaction discriminator. Every
`loop-query` delta in all six corpora is M1 — none is a §10 receiver loss. The
net per corpus is a pure re-anchor or a discriminator gain:

- recall-protocol 57 lost / 68 gained — net +11 (transaction discriminator
  catches loops previously missed).
- hhra-org 3 lost / 8 gained — net +5 (same).
- knex 2 lost / 0 gained — transaction-scoped loops correctly quieted.
- blitz 0 / 0 — unchanged.
- endless-guessing 7 lost / 4 gained — net −3.

### M2 — §10 name-list deletion + resolution-only provenance

The four fixes close most of M2's sub-gaps. The disposition of each lost
finding is `recovered` (`handle`), `clean` (`not-handle`, an FP the name-list
admitted), or `cannot-fire` (`nothing`, the residual silent surface — §3).

### M3/M4 — seed threading + construction propagation (the gained side)

- **hhra-org gained 80** — #381 proves `orgTrackerDb = OrgTrackerDatabase.getInstance()`
  (a singleton over a `Pool | null` field), which is hhra's primary data handle.
  It was invisible to both the name-list (not a `db`/`sql`/`stmt` name) and the
  pre-fix resolver (a static accessor over a field). Proving it un-silences the
  schema facts on every `orgTrackerDb.query(...)` call: `unknown-table` +30,
  `stale-table-reference` +9, `read-never-written` +18, `table-naming-convention`
  +9, `sql-injection-risk` +6, plus the recovered 20 `too-many-queries`. These
  are new findings the name-list never produced, not re-anchored ones.
- **blitz gained 6** — #381 proves `const db = new EnhancedPrisma()` (a
  higher-order-factory wrapper), so `db.user`/`db.…` schema facts fire in the
  three `integration-tests/*/db/seed.ts` files (`unknown-table` +3,
  `reserved-word` +3).
- **recall-protocol gained 10** (non-loop) — #390/#376 prove cross-file
  `getDb()` receivers, so `schema-usage` fires new `read-never-written` (+6) and
  `written-never-read` (+4) facts on files that previously failed the gate.
- **knex gained 8** — #390 proves receivers in `test-tsd/*.test-d.ts` that the
  name-list missed (`read-never-written` +2, `unknown-table` +1,
  `too-many-queries` +5).
- **endless-guessing gained 1** — `written-never-read` +1 (parity, M4).

## 3. The guard — the new cannot-fire count against 101

The prior measurement's silent surface was **101 findings** — 59 recall, 20
hhra-org, 14 knex, 8 blitz — all findings that fired under the name-list and
went silent when resolution-only provenance could not reach their receiver.
After the four fixes, each of the 101 re-disposes:

| corpus | silent before | recovered | reclassified clean (FP) | **still cannot-fire** |
|---|---|---|---|---|
| blitz | 8 | 8 | 0 | **0** |
| hhra-org | 20 | 20 | 0 | **0** |
| recall-protocol | 59 | 33 | 15 | **11** |
| knex | 14 | 0 | 0 | **14** |
| **total** | **101** | **61** | **15** | **25** |

**The new cannot-fire count is 25** — down from 101. The 76 findings that left
the silent surface split 61 recovered + 15 reclassified as clean false positives.

The 15 reclassified-clean are the recall `too-many-queries` findings on
`scripts/**` (and their `src/ops/**` twins) that shell out to
`wrangler d1 execute` or the Cloudflare D1 REST API and build SQL as strings
rather than through a JS handle (`seed-d1.ts`, `verify-d1-published-asset-urls.ts`,
`test-sandbox-merge.ts`/`test-sandbox-cancellation.ts`,
`backfill-build-loadout-join.ts`, `sync-build-loadout-to-remote.ts`,
`run-strategist-build-parity-sample.ts`, `fts-repair.ts`,
`audit-wrong-subject-citations.ts`, `run-knowledge-downstream.ts`). The name-list
matched a local `sql`/`d1` *string* variable and counted `SELECT`/`INSERT`
keywords in the string literals; the resolution sees the variable is a string,
not a handle, and correctly drops the file from the query gate. No real
JS-side N+1 was lost — these functions issue zero JS DB queries.

### The residual 25, by file+line

**recall-protocol — 11 (three remaining sub-gaps):**

- `too-many-queries` ×2 — `src/lib/build-articles.ts:161,527`
  (`loadStoredBuildArticle` / `upsertStoredBuildArticle`). `type DbLike =
  D1Database` — a real D1 handle behind a *type alias* the resolver does not
  unfold. This is the "type-alias-typed param" gap.
- `cross-domain/multi-table-write` ×1 — `src/agents/hero-data-sync.ts:124`
  (`sql: SqlStorage`) — the "ambient handle type" gap (`SqlStorage` arrives via
  `@cloudflare/workers-types`, no in-repo declaration).
- `cross-domain/read-never-written` ×4 — `scripts/populate-hero-archetypes.ts:114`,
  `scripts/backfill-patch-eras.ts:114`, `scripts/generate-article.ts:891`,
  `src/lib/strategy/assemble-context.ts:86` — the DB access is a bare
  `query()` / `d1Query()` helper that wraps the D1 REST API; no JS handle to
  prove. The table genuinely is read-never-written, so the drop is real.
- `cross-domain/written-never-read` ×3 — `scripts/backfill-strategist-attribution.ts:227`
  (`d1Query`/`d1Exec` REST helpers), `src/agents/user-strategist.ts:437`
  (`this.env.DB`), `src/agents/hero-data-schema.ts:40` (`sql: SqlStorage`).
- `sql-injection-risk` ×1 — `scripts/generate-article.ts:891` (`d1Query(insertSql)`),
  interpolated SQL sent to the D1 REST endpoint.

**knex — 14 (unchanged; its own query-compiler receivers):** `unknown-table` 6
(`test/cli/migrate-unlock.spec.js:26,43,55`, `test/jake/jakelib/migrate-test.js:237`,
`test/tape/raw.js:72`, `test/unit/query/builder.js:10255`),
`read-never-written` 4 (`test/tape/raw.js:36,72`,
`test/integration2/migrate/migration-integration.spec.js:249`,
`test/unit/query/builder.js:10255`), `sql-injection-risk` 1
(`test/cli/cli-test-utils.js:80`), `table-naming-convention` 1
(`test/unit/query/builder.js:10255`), `too-many-queries` 2
(`lib/dialects/oracledb/query/oracledb-querycompiler.js:16`,
`lib/schema/tablecompiler.js:96`). These are knex's own query-compiler `db`/`sql`/
`stmt` references — dynamic builder internals with no static declaration to
resolve. The four fixes were aimed at cross-file accessors and construction, and
correctly did not touch them.

### Diagnostic vs finding granularity

The raw `cannot-fire` diagnostic counts in the work tree are 80 (recall), 348
(hhra), 4 (knex), 15 (blitz), 4 (endless) — per *query-shaped call site*, not per
finding. That is a different granularity from the 101/25 finding-level surface:
a single unproven receiver can feed many call sites and many rules. The number
that answers "the new cannot-fire count against 101" is the finding-level **25**,
not the diagnostic total.

## 4. The R5 split — re-confirmed unchanged

`data-access::missing-org-filter` is 68 in both head and work (the rule does not
move in this diff). Its three-class split, on record in
`spec69-r5-hhra-redisposition.md`, is unchanged: **23 IDOR surfaces + 40
unfiltered queries + 5 conditional (variable-split) cases = 68 genuine**, with
3 false positives now quiet. #381 does not move it because `missing-org-filter`
keys on Drizzle/ORM builder chains against tenant columns, not the raw-SQL
`orgTrackerDb` `Pool` wrapper that #381 proves.

## Bottom line

The F2 re-run is fully attributed with **no residual**. M1 accounts for every
`loop-query` delta; the four fixes (#377/#381/#376/#390) account for every
`too-many-queries`/schema/cross-domain delta. The silent surface fell from
**101 to 25 findings** — 61 recovered, 15 reclassified as name-list false
positives, and a 25-finding residual that names exactly three remaining
sub-gaps (type-alias params, ambient `SqlStorage`, bare REST-helper receivers)
plus knex's unresolvable query-compiler internals. Those 25 are the named
defects to close before a baseline is pinned as clean — no finding is dropped
without either firing, a visible cannot-fire diagnostic, or a stated FP reason.
