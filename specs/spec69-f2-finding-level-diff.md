# Spec 69 F2 — finding-level diff (HEAD `8da17ab` → working tree)

Two-state full audit of all six read-only corpora, every rule, matched on
`file:line:rule`, with every appearance and disappearance attributed to a named
mechanism, the per-corpus guard (findings-lost vs cannot-fire-gained) reconciled
on the deduplicated count with residual enumerated by file+line, and the final
R5 split.

Harness: `dist/cli.js audit -f json` for both states, isolated
`CODE_AUDITOR_DATA_DIR=/tmp/f2/data-{head,work}`, multiset diff on
`file|line|rule`. HEAD binary built at `/private/tmp/ca-s5e-head/dist/cli.js`;
working tree at `app/dist/cli.js`.

## 1. The diff

| corpus | head | work | lost (dedup) | gained (dedup) |
|---|---|---|---|---|
| recall-protocol | 5115 | 5075 | 132 | 92 |
| hhra-org | 1188 | 1179 | 23 | 14 |
| knex | 627 | 605 | 16 | 0 |
| primer-css | 19 | 19 | 0 | 0 |
| blitz | 1035 | 1025 | 10 | 0 |
| endless-guessing | 258 | 256 | 7 | 5 |

(`knex` shows 16 deduplicated keys; the multiset delta is 22 because six of the
`unknown-table` lines carry two references each. The directive's "deduplicated
count" is what the guard uses.)

Lost by rule, per corpus:

| rule | recall | hhra | knex | blitz | endless |
|---|---|---|---|---|---|
| loop-query | 67 | 3 | 2 | 2 | 7 |
| too-many-queries | 40 | 20 | 2 | — | — |
| cross-domain/written-never-read | 10 | — | — | — | — |
| cross-domain/read-never-written | 4 | — | 4 | — | — |
| stale-table-reference | 8 | — | — | — | — |
| cross-domain/multi-table-write | 2 | — | — | — | — |
| sql-injection-risk | 1 | — | 1 | — | — |
| unknown-table | — | — | 6 | 4 | — |
| table-naming-convention | — | — | 1 | — | — |
| reserved-word | — | — | — | 4 | — |

Gained by rule:

| rule | recall | hhra | endless |
|---|---|---|---|
| loop-query | 67 | 8 | 4 |
| cross-domain/read-never-written | 17 | — | — |
| cross-domain/written-never-read | 8 | — | 1 |
| sql-injection-risk | — | 6 | — |

## 2. Attribution — every delta to a named mechanism

Four mechanisms account for every lost and gained finding. §10 (name-list
deletion + resolution-only provenance) is the single dominant cause; the other
three are precision fixes or the schema-usage seed defect.

### M1 — loop-query precision (#340)

`prepare`-outside-loop reclassification + transaction discriminator. The
finding anchor moves from the loop head to the actual query call site, so the
same loop appears as a lost line and a gained line (`file:line` moves), and a
few loops go quiet (transaction-scoped or hoisted prepare) while a few new ones
fire. **Every loop-query delta in all six corpora is M1** — none is a §10
receiver loss:

- recall-protocol 67 lost / 67 gained — net 0, pure re-anchor (e.g.
  `scripts/groom-strategies.ts:204 (loop 191)` → `:196 (loop 191)`).
- hhra-org 3 lost / 8 gained — net +5 (transaction discriminator catches loops
  previously missed).
- knex 2 lost / 0 gained — `test/cli/migrate-disable-transactions.spec.js:47,105`
  (transaction-scoped loops correctly quieted).
- blitz 2 lost / 0 gained — `apps/toolkit-app*/db/seeds.ts:13` (same).
- endless-guessing 7 lost / 4 gained — net −3.

### M2 — §10 name-list deletion + resolution-only provenance (#353–#355, #359–#360)

`DB_RECEIVER_NAMES` (`db`, `database`, `sql`, `stmt`) is deleted; a receiver is
now DB-provenanced only if the cross-file resolution recovers it. Every
non-loop-query loss traces to a receiver that the resolution cannot recover,
split three ways by disposition:

- **cannot-fire** (`nothing`) — the silent-regression surface. The receiver was
  name-list-provenanced and fired real findings; now it resolves to nothing and
  the findings go silent. Sub-gaps, all one class of "resolution can't reach the
  handle":
  1. **`new <wrapper-class>()` construction gap** (already documented in the R5
     spec for queue-worker) — `orgTrackerDb = OrgTrackerDatabase.getInstance()`
     (hhra-org, wraps `pg.Pool`), queue-worker `this.db = new Database()`, blitz
     `import db from "db"` → `new EnhancedPrisma()`.
  2. **Nullable-union return type** — `getDb(): D1Database | null`
     (`baseHandleTypeName` returns the whole `"D1Database | null"` string, not
     the base name), so recall-protocol's `const db = getDb(locals)` goes
     cannot-fire.
  3. **Ambient handle types** — `SqlStorage`, and `D1Database` when it arrives
     through a union or an ambient `@cloudflare/workers-types` import rather than
     a clean in-repo annotation.
  4. **Runtime bindings** — `env.DB`, `const db = env.DB` (documented).
  5. **Deleted hybrid method fallback** — `.query()`/`.raw()` on a non-name-list
     bare receiver (`orgTrackerDb.query`) is no longer a DB call.

- **clean** (`not-handle`) — the receiver's declaration is a provably non-DB
  literal (`sql = "SELECT …"` string, not a handle). These findings were
  name-list false positives; their removal is correct, not a regression.

- **recovered** (`handle`) — no loss; the finding fires as before.

### M3 — schema-usage seed omission (#376)

`extractSchemaUsage` builds its `provenanceContext` in `hybrid` mode **without**
`seedProvenance: file.receiverProvenance`, so a receiver provenanced only
cross-file (`getDB(): D1Database` in the bench schema corpus) fails the schema
file gate and drops every `unknown-table`/`stale-table-reference` fact. This is
**latent** against the six corpora today — they have no non-null, in-repo
`getDB(): D1Database` accessor; their accessors all return nullable unions
(`D1Database | null`) that already fail under M2. Fixing M2's union gap will
surface M3 on the real corpora, so M3 must be fixed before M2 is.

### M4 — cross-domain parity (#302) — gained side only

`detectWrittenNeverRead` parity (update/delete/create) and the schema-usage
re-emission add the gained cross-domain findings (recall-protocol read-never
+17 / written-never +8, endless-guessing written-never +1). The gained
`sql-injection-risk` +6 on hhra-org is the S5b/S5c binding-rule completion
(import/param/class-field/`new X()`) recovering `this.db = new Database()`
receivers in `lib/etl/loadStaging.ts` / `pipelineSteps.ts` that the name-list
never reached.

## 3. The guard — findings lost vs cannot-fire gained

Receiver-level corroboration (`scripts/measure-receiver-resolution.ts`,
post-S5d widened to bare **and** `this.<field>` receivers):

| corpus | bare receivers | recovered | not-handle | cannot-fire |
|---|---|---|---|---|
| recall-protocol | 323 | 143 | 5 | 175 (+2 this) |
| hhra-org | 18 | 15 | 0 | 3 (+5 this recovered) |
| knex | 38 | 0 | 3 | 35 (+1 this) |
| blitz | 60 | 6 | 0 | 54 |
| endless-guessing | 3 | 1 | 0 | 2 |
| primer-css | 0 | 0 | 0 | 0 |

Finding-level reconciliation (deduplicated lost, by mechanism):

| corpus | lost | M1 loop-query | M2 cannot-fire (silent) | M2 clean (FP) | accounted |
|---|---|---|---|---|---|
| recall-protocol | 132 | 67 | 59 | 6 | 132 ✓ |
| hhra-org | 23 | 3 | 20 | 0 | 23 ✓ |
| knex | 16 | 2 | 14 | 0 | 16 ✓ |
| blitz | 10 | 2 | 8 | 0 | 10 ✓ |
| endless-guessing | 7 | 7 | 0 | 0 | 7 ✓ |

**No residual.** Every lost finding reconciles to a named mechanism; the
"cannot-fire (silent)" column is the release-bar surface and is enumerated
below by file+line. The receiver table is corroboration, not the measure: recall
reports 177 cannot-fire receivers but only 59 of them ever fired a finding, so
the finding-level silent surface is 59, not 177. The other 118 receivers were
name-list-provenanced but never tripped a rule, so their silence is pre-existing.

### The silent surface, by file+line

**recall-protocol — 59 findings lost to cannot-fire (silent):**

- `stale-table-reference` (8, all **critical**, dropped `generation_queue` table
  still referenced — real):
  `src/pages/api/admin/generation/queue.ts:35,36,37,39,42,105,113,121`
  (`db = getDb(locals)` → `D1Database | null` union gap).
- `sql-injection-risk` (1, **high**, interpolated SQL sent to Cloudflare D1 REST
  — real): `scripts/generate-article.ts:891` (`d1Query(insertSql)`).
- `cross-domain/multi-table-write` (2, **high**):
  `src/agents/hero-data-sync.ts:124` (`sql: SqlStorage` ambient gap),
  `src/pages/api/account/claim-heroes.ts:134`.
- `cross-domain/read-never-written` (4, **severe**):
  `scripts/populate-hero-archetypes.ts:114`, `scripts/backfill-patch-eras.ts:114`,
  `scripts/generate-article.ts:891`, `src/lib/strategy/assemble-context.ts:86`.
- `cross-domain/written-never-read` (6, **high**):
  `scripts/backfill-strategist-attribution.ts:227`,
  `scripts/test-stage0-idempotency.ts:110`,
  `src/agents/user-strategist.ts:437`,
  `src/pages/api/stadium/strategist/chip-click.ts:39`,
  `src/agents/hero-data-schema.ts:40`,
  `src/pages/api/telemetry/ingest.ts:81`.
- `too-many-queries` (38, **high**) — real over-querying functions whose `db`/`sql`
  receiver went cannot-fire, e.g. `scripts/test-sandbox-merge.ts:71` (42),
  `scripts/seed-d1.ts:746`, `scripts/verify-d1-published-asset-urls.ts:180` (13),
  `src/lib/build-articles.ts:161,527`, `src/agents/hero-data-agent.ts:187,489`,
  `src/pages/api/admin/generation/queue.ts:27`, `src/pages/api/admin/*` (full
  list in `/tmp/f2/full-detail.txt`).

**recall-protocol — 6 findings lost to clean (FP removal, correct):**
`scripts/run-knowledge-keystone.ts:558`, `scripts/run-knowledge-downstream.ts:348,627,628`
(written-never-read), `scripts/run-knowledge-downstream.ts:298,582`
(too-many-queries) — all `sql` receivers whose declaration is a string literal,
not a DB handle.

**hhra-org — 20 findings lost to cannot-fire (silent):** all `too-many-queries`
on `orgTrackerDb.query(...)` (singleton `pg.Pool` wrapper — the `new
OrgTrackerDatabase()` construction gap). `src/lib/queries/compliance-enhanced.ts:72`
(15), `fifra-inadvertent.ts:53` (17), `highRisk-enhanced.ts:56` (14),
`pdpImportsRiskRankings.ts:53` (12), `riskRankingsUSGrown.ts:48` (12),
`residue-cascades.ts:70` (11), and 14 more (full list in `/tmp/f2/full-detail.txt`).

**knex — 14 findings lost to cannot-fire (silent):** `unknown-table` 6
(`test/cli/migrate-unlock.spec.js:26,43,55`, `test/jake/jakelib/migrate-test.js:237`,
`test/tape/raw.js:72`, `test/unit/query/builder.js:10255`), `read-never-written` 4
(`test/tape/raw.js:36,72`, `test/integration2/migrate/migration-integration.spec.js:249`,
`test/unit/query/builder.js:10255`), `sql-injection-risk` 1
(`test/cli/cli-test-utils.js:80`), `table-naming-convention` 1
(`test/unit/query/builder.js:10255`), `too-many-queries` 2
(`lib/dialects/oracledb/query/oracledb-querycompiler.js:16`,
`lib/schema/tablecompiler.js:96`) — knex's own `sql`/`db`/`stmt` query-compiler
references, all unresolvable (0 recovered).

**blitz — 8 findings lost to cannot-fire (silent):** `unknown-table` 4
(`integration-tests/auth/pages/api/signin.ts:7,16`,
`integration-tests/next-13-app-dir/app/api/signin/route.ts:6,9`) + `reserved-word` 4
(same lines) — `import db from "db"` → `enhancePrisma`/`new EnhancedPrisma()` chain
breaks, `db.user` goes cannot-fire.

## 4. The R5 split (hhra-org, three classes)

Already on record in `spec69-r5-hhra-redisposition.md`; re-confirmed unchanged
by F2 (the R5 rule — `missing-org-filter` — did not move in this diff):

| class | count | detail |
|---|---|---|
| **real IDOR surfaces** | 18 (post-§10) / 23 (pre-§10) | row-identifier-keyed reads/mutations on tenant tables, no org predicate |
| **real unfiltered queries** | 40 | set operations (aggregates/lists/exports/health) on tenant tables, no org predicate |
| **false positives** | 3 | 1 dotted-value predicate (Fix 1) + 2 unconditional builders (R3) |

Plus 5 conditional (variable-split) cases that stay firing — genuine, pinned as
must-fire fixtures. The pre-§10→post-§10 IDOR move (23→18) is the queue-worker
`this.db = new Database()` construction gap, already recorded as a silent
`clean` defect in that spec.

## Bottom line

The F2 diff is fully attributed with **no residual**: loop-query precision (M1)
accounts for every loop-query delta; §10 (M2) accounts for every
too-many-queries/schema/cross-domain/data-access loss, split into a **59-finding
silent surface** (cannot-fire) and a 6-finding clean FP removal across the six
corpora (plus 20 silent on hhra-org and 14 on knex and 8 on blitz — the
per-corpus silent surface is 101 findings in total). The silent surface is the
release-bar violation: it is a `clean`/`cannot-fire` accounting hole of the exact
kind §10 forbids. Its four sub-gaps (wrapper construction, nullable-union return
type, ambient handle types, deleted hybrid fallback) plus M3 (#376, the
schema-usage seed omission) are the named defects to close before any baseline is
pinned.
