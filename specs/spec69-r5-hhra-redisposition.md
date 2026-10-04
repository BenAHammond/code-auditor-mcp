# Spec 69 R5 — re-disposition of the hhra-org `missing-org-filter` findings

The 71 hhra-org `missing-org-filter` findings split into **68 genuine + 3
false positives**. This report re-measures after R3's local-binding resolution,
re-samples every remaining finding, and records the split before any baseline
is pinned (criterion 12 — no baseline before the split is on record).

## The measurement, attributed

Measured with `scripts/measure-corpus-counts.ts` (read-only,
`CODE_AUDITOR_DATA_DIR=/tmp`, the same harness as the Fix 1–5 report):

| stage | hhra-org `missing-org-filter` | movement | attributed to |
|---|---|---|---|
| pre-Fix-1 (`6943a29`) | 71 | — | the spec's headline |
| after Fix 1 (`0385905`) | 70 | −1 | the dotted-value predicate FP (below) |
| **after R3 (`c8b49ea`)** | **68** | **−2** | **local binding resolution — the two unconditional builders** |

Advisory total follows the same arithmetic: 1190 (after Fix 5) → **1188** (the
−2 is exactly the two quieted builders; nothing else moved).

**71 was not wrong.** It is exactly 68 genuine + the three false positives named
below — one dotted-value predicate cleared by Fix 1, two unconditional builders
cleared by R3. The three drop, attributed to a named file+function+mechanism
each.

## The three false positives (now quiet)

### 1. `existingRelation` — the dotted-value predicate (Fix 1, `0385905`)

`app/api/admin/users/[userId]/organizations/route.ts`, `POST` handler, the
`existingRelation` guard (~line 133):

```ts
const existingRelation = await appDb.getDb()
  .select()
  .from(userOrganizations)
  .where(and(
    eq(userOrganizations.userId, userId),
    eq(userOrganizations.organizationId, validatedData.organizationId)
  ))
  .limit(1);
```

This query was **always** org-scoped — it carries
`eq(userOrganizations.organizationId, validatedData.organizationId)`. The
pre-Fix-1 predicate detector still fired on it because its ORM-helper regex
carried a blanket negative lookahead `(?!\s*[\w$]+\s*\.)` that rejected **any**
helper call whose second argument was dotted. Here the value is
`validatedData.organizationId`, so the lookahead misread the predicate as a
JOIN-on-org and excluded it; the query read as having no tenant predicate and
fired a false positive.

Fix 1 (`0385905`) scoped the join exclusion to join verbs only
(`isJoinCondition`: an `eq(col, dotted)` is a join iff it is the second argument
of `innerJoin`/`leftJoin`/…). Under `.where(and(…))` it is a filter, so the
predicate is recognized and the finding goes quiet. This is the **dotted-value**
half of Fix 1, not the vocabulary half — hhra-org carries no `workspace_id`, so
its one Fix-1 move is this predicate, not a newly-discovered tenant column.

### 2 and 3. The two unconditional builders (R3, `c8b49ea`)

Both are the *unconditional* builders — the `conditions` array initializer
always carries the org predicate, so a finding asserting its absence was false
whatever the cause. R3 resolves the initializer as all-paths and the rule goes
quiet.

| function | file:line | shape | before | after |
|---|---|---|---|---|
| `getAccessibleSampleIds` | `lib/middleware/organizationFilter.ts:124` | `const conditions = [inArray(sampleOwnership.organizationId, orgIds)]` then `.where(and(...conditions))` | critical | quiet ✓ |
| `getCertifierTestResults` | `src/lib/queries/certifier-data.ts:240` | `const conditions = [eq(certifierResidueTests.organizationId, params.organizationId)]` then `.where(and(...conditions))` | critical | quiet ✓ |

`getCertifierTestResults` is double-hidden: its predicate
`eq(certifierResidueTests.organizationId, params.organizationId)` is also a
dotted value, so pre-Fix-1 it was hidden by the same lookahead as finding 1,
**and** it sits behind a `...conditions` spread that Fix 1 does not see through.
Fix 1 only made the predicate recognizable; R3 then resolved the spread. It is
counted as an R3 move (−2) because the spread was the remaining hiding
mechanism. `getAccessibleSampleIds`'s predicate is `inArray(…, orgIds)` — a
bare `orgIds`, not dotted — so it was hidden by the spread alone.

The conditional pushes in `getAccessibleSampleIds` (`if (pdpYear)`, `if
(tableName)`) are **non-org** predicates, so they do not change the all-paths
verdict — the org isolation is unconditional in the initializer.

## The five conditional (variable-split) cases — stay firing

Five sites push the org predicate inside an `if` or a ternary, so the query
executes unscoped on the branch where the optional argument is absent. These
are genuine: a tenant filter that applies only when a caller supplies an
optional argument is the defect. Each is pinned as a must-fire fixture in
`src/__tests__/spec69-r5-conditional-mustfire.spec.ts`, so a future resolution
change cannot quietly silence one.

| # | function | file:line | shape | message |
|---|---|---|---|---|
| 1 | `isOrganizationAdmin` | `lib/utils/organizationFilters.ts:142` | `if (organizationId) conditions.push(eq(userOrganizations.organizationId, organizationId))` | "…when `organizationId` is absent" |
| 2 | `getUploadStatus` | `src/lib/queries/certifier-data.ts:152` | `if (organizationIds && organizationIds.length > 0) conditions.push(inArray(rawCertifierData.organizationId, organizationIds))` | "…when `organizationIds && organizationIds.length > 0` is absent" |
| 3 | admin data page | `app/private/admin/data/page.tsx:70` | `if (organizationId && organizationId !== 'all') conditions.push(eq(rawCertifierData.organizationId, organizationId))` | "…when `organizationId && organizationId !== 'all'` is absent" |
| 4 | sample-ownership stats | `app/api/admin/sample-ownership/route.ts:29` | ternary `organizationId ? statsQuery.where(eq(sampleOwnership.organizationId, organizationId)) : statsQuery.limit(…)` | plain (no spread — outside R3's ceiling) |
| 5 | admin data base | `app/private/admin/data/page.tsx:49` | `query = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery` | plain (reassignment — outside R3's ceiling) |

Cases 1–3 exercise R3's some-paths path (the "is absent" message). Cases 4 and
5 are the two conditional forms R3 deliberately does **not** resolve — its
ceiling is the `.where(and(...conditions))` spread within one statement, not a
ternary predicate nor a builder reassignment. They fire with the plain message
today and are pinned so they stay firing rather than being mistaken for
all-paths and silenced.

## The remaining 63 — 23 IDOR surfaces + 40 unfiltered queries

The 63 non-conditional findings split cleanly into the two classes criterion 12
asks for. Every finding was sampled individually; all 63 are genuine. The
classification rule is stated once and applied uniformly:

- **IDOR surface** — the query's access pattern is keyed by a row identifier a
  caller can name (`id`/`uploadId`/`jobId`/`userId`/`relationshipId`) or claims
  a row (`FOR UPDATE SKIP LOCKED`), on a tenant table, with no org predicate:
  a caller who supplies the identifier reads/mutates that tenant's row. This is
  `missing-org-filter`'s purpose.
- **Unfiltered query** — the query's access pattern is a *set* operation with no
  row-identifier key: aggregates, counts, lists, joins, exports, health checks,
  bulk lookups, queue-claim scans, membership lists, on tenant table(s) with no
  org predicate.

Under that rule the 63 split **23 IDOR / 40 unfiltered**. The false-positive
class is **zero beyond the three named above** — no other finding is a false
positive.

### IDOR surfaces (23)

Row-identifier-keyed reads/mutations and the worker claim path:

| file:line | symbol | key |
|---|---|---|
| `app/api/admin/jobs/[jobId]/route.ts:19` | `GET` | job-id read |
| `app/api/admin/jobs/[jobId]/route.ts:64` | `POST` | job-id update |
| `app/api/admin/users/[userId]/organizations/[relationshipId]/route.ts:29` | `PUT` | relationship-id |
| `app/api/admin/users/[userId]/organizations/[relationshipId]/route.ts:125` | `DELETE` | relationship-id |
| `app/api/admin/users/[userId]/route.ts:43` | `GET` | user-id |
| `app/private/admin/queue/[jobId]/page.tsx:17` | `getJobDetails` | job-id |
| `database/services/repositories/JobRepository.ts:13` | `findById` | id |
| `database/services/repositories/UploadRepository.ts:13` | `findById` | id |
| `database/services/repositories/UploadRepository.ts:23` | `findByUserId` | user-id |
| `src/lib/queries/certifier-data.ts:15` | `getUserOrganization` | user-id |
| `src/lib/queries/certifier-data.ts:99` | `getCertifierUpload` | upload-id |
| `src/lib/queries/certifier-data.ts:112` | `getUploadJobStatus` | upload-id |
| `src/lib/services/certifier-upload-processor.ts:50` | `processJob` | job-id |
| `src/lib/services/certifier-upload-processor.ts:71` | `processJob` | upload-id |
| `queue-worker/src/queue-worker.ts:58` | `claimNextJob` | claim (`FOR UPDATE SKIP LOCKED`) |
| `queue-worker/src/queue-worker.ts:162` | `updateJobProgress` | job-id |
| `queue-worker/src/queue-worker.ts:171` | `completeJob` | job-id |
| `queue-worker/src/queue-worker.ts:205` | `handleJobError` | job-id |
| `queue-worker/src/queue-worker.ts:228` | `handleJobError` | job-id |
| `queue-worker/src/processing-service.ts:37` | `processUpload` | upload-id |
| `queue-worker/src/processing-service.ts:48` | `processUpload` | upload-id |
| `queue-worker/src/processing-service.ts:100` | `processUpload` | upload-id |
| `queue-worker/src/processing-service.ts:118` | `processUpload` | upload-id |

### Unfiltered queries (40)

Set operations — aggregates, lists, counts, exports, health checks, membership
reads, migrations — with no row-identifier key:

| file:line | symbol | shape |
|---|---|---|
| `app/api/admin/jobs/export/route.ts:21` | `GET` | export (list, no id key) |
| `app/api/admin/organizations/export/route.ts:21` | `GET` | export |
| `app/api/admin/sample-ownership/route.ts:49` | `GET` | count aggregate |
| `app/api/admin/users/[userId]/organizations/route.ts:41` | `GET` | membership list |
| `app/api/admin/users/bulk/route.ts:81` | `POST` | bulk upsert lookup |
| `app/api/admin/users/export/route.ts:21` | `GET` | export |
| `app/api/dashboard/activity/repositories.ts:62` | `getRecentUploads` | list |
| `app/api/dashboard/activity/repositories.ts:81` | `getRecentAccessLogs` | list |
| `app/api/dashboard/stats/repositories.ts:28` | `getTotalUploadsCount` | count |
| `app/api/dashboard/stats/repositories.ts:37` | `getUploadStatusCounts` | count |
| `app/api/dashboard/stats/repositories.ts:50` | `getProcessedDataCount` | count |
| `app/api/dashboard/stats/repositories.ts:59` | `getRecentUploads` | list |
| `app/api/dashboard/stats/repositories.ts:76` | `getRecentProcessedCount` | count |
| `app/api/health/database/route.ts:46` | `GET` | health count |
| `app/api/health/database/route.ts:47` | `GET` | health count |
| `app/private/admin/data/page.tsx:74` | `getImportHistory` | status aggregate |
| `app/private/admin/organizations/page.tsx:22` | `getOrganizations` | list |
| `app/private/admin/page.tsx:37` | `getAdminStats` | count |
| `app/private/admin/queue/page.tsx:22` | `getJobsData` | list/join |
| `app/private/admin/queue/page.tsx:73` | `getJobsData` | list filter |
| `app/private/admin/queue/page.tsx:77` | `getJobsData` | group-by list |
| `app/private/admin/queue/page.tsx:84` | `getJobsData` | list filter |
| `app/private/admin/sample-ownership/page.tsx:15` | `getSampleOwnershipStats` | list/join |
| `app/private/admin/sample-ownership/page.tsx:34` | `getSampleOwnershipStats` | list/join |
| `app/private/admin/sample-ownership/page.tsx:46` | `getSampleOwnershipStats` | list |
| `app/private/admin/sample-ownership/page.tsx:58` | `getSampleOwnershipStats` | list |
| `app/private/admin/system/page.tsx:18` | `getSystemMetrics` | count |
| `app/private/admin/system/page.tsx:25` | `getSystemMetrics` | count |
| `app/private/admin/users/[userId]/page.tsx:29` | `getUserDetails` | membership detail |
| `app/private/admin/users/page.tsx:22` | `getUsers` | list |
| `components/certifier/UploadHistory.tsx:15` | `UploadHistory` | history list |
| `database/services/repositories/JobRepository.ts:30` | `findPendingJobs` | status-keyed scan |
| `lib/middleware/organizationFilter.ts:19` | `getUserOrganizations` | membership list |
| `lib/utils/organizationFilters.ts:32` | `getUserOrganizations` | membership list |
| `scripts/enable-org-filtering.ts:41` | `enableOrganizationFiltering` | one-shot migration |
| `scripts/enable-org-filtering.ts:108` | `enableOrganizationFiltering` | one-shot migration |
| `src/lib/queries/organizations.ts:183` | `getUserAccessibleOrganizations` | membership list |
| `src/lib/queries/organizations.ts:382` | `getOrganizationStats` | count |
| `src/lib/queries/user-organizations.ts:20` | `getUserOrganizationsWithDetails` | membership join |
| `tests/unit/organization-isolation.test.ts:135` | `fn` | test fixture |

Two prior "IDOR" mislabels are corrected here on the sample, so the split is
clean: `JobRepository.findPendingJobs` (a status-keyed queue-claim scan, not an
id-keyed lookup) and `jobs/export` (a list/export with no id key) are
unfiltered, not IDOR.

## F1 — post-§10 re-measure (the final number)

Re-measured with `scripts/measure-corpus-counts.ts` (read-only,
`CODE_AUDITOR_DATA_DIR=/tmp`) after §10 landed (name-list fallback deleted,
cross-file resolution active, S1–S4 done). The count is **63**, down **5** from
the R3 baseline of 68.

| stage | hhra-org `missing-org-filter` | movement | attributed to |
|---|---|---|---|
| after R3 (`c8b49ea`) | 68 | — | baseline before §10 |
| **after §10 (S1–S4)** | **63** | **−5** | **the queue-worker `this.db` construction gap (below)** |

The −5 is exactly the five `queue-worker/src/queue-worker.ts` `this.db.query(…)`
IDOR surfaces (`claimNextJob :58`, `updateJobProgress :162`, `completeJob :171`,
`handleJobError :205`/`:228`). A file:line diff of the 68-entry R3 list against
the current 63 shows **no other movement**: all 5 conditional and all 40
unfiltered are unchanged, and 18 of the 23 IDOR remain.

Careful not to read the two "63"s as the same number: at R3 the split was
68 = 5 conditional + **63 non-conditional** (23 IDOR + 40 unfiltered); after §10
the total is 63 = 5 conditional + **18 IDOR** + 40 unfiltered. The move is 23 →
18 IDOR; nothing else moved.

### Why the five dropped

`queue-worker.ts` imports `Database` from `./db` and constructs it directly:

```ts
import { Database } from './db';   // db.ts: class Database { … this.sql = neon(…) … }
private db: Database;
this.db = new Database();          // ← the construction
await this.db.query(`…`);          // 5 sites
```

`./db` → `db.ts` **resolves** (the file exists and wraps `@neondatabase/serverless`),
so `Database` is provenanced as a wrapper class. But the cross-file resolution
does **not** trace `this.db = new Database()` back to that provenance — the
`new <wrapper-class>()` construction is out of the declared-handle-type anchor
(the same `new <provenanced-type>()` gap the S2 instrument noted for blitz's
`new EnhancedPrisma()`). The deleted name-list fallback used to prove `this.db`
by name (`db`); the resolution has no equivalent, so `this.db.query(…)` is no
longer a DB call and the finding drops.

By contrast `processing-service.ts` (its 4 IDOR surfaces) still fires: it takes
`constructor(db: Database) { this.db = db; }`, so the parameter type annotation
(Rule 8b) proves `db`, and the assignment propagates to `this.db`. The
parameter-vs-construction distinction is the entire difference between the two
files.

### The accounting is a silent `clean`, not `cannot-fire`

The §10 guard requires a receiver that goes unseen to report `cannot-fire`, never
`clean`. These five report neither. The `cannot-fire` diagnostic
(`checkUnresolvedReceiverImports`) fires only for imports whose specifier does
**not** resolve to an in-repo file — and `./db` resolves. The S2 instrument also
missed them: it counted only *bare* receivers (`db` as a direct object), explicitly
excluding `this.db`, so these five were never in its 442-receiver denominator.
Net effect: the finding count falls by 5 with no coverage-channel offset — a
**silent regression** of the exact kind §10 forbids. This is a measured, open
defect (tracked as the `new <wrapper-class>()` construction gap), not an accepted
clean.

## Baseline

The R3 split is on record before any baseline is pinned (criterion 12): **68
genuine = 5 conditional + 23 IDOR + 40 unfiltered**, plus **3 false positives**
(1 dotted-value + 2 builders), zero beyond those three. The post-§10 count is
**63 = 5 conditional + 18 IDOR + 40 unfiltered**, the −5 being the
queue-worker `this.db` construction gap documented above. Both numbers are on
record; neither is a pinned baseline yet — the pinned per-corpus re-pin lands
with the release step (#338), not here, and must reflect the post-§10 count once
the S5 construction gap is closed (or be pinned at 63 with the gap recorded as a
standing limitation). The two quieted builders, the dotted-value FP, and the
five conditional cases are pinned as fixtures (`spec69-r5-conditional-mustfire.spec.ts`
for the five, plus the R3 all-paths/some-paths pair in
`spec69-r3-motivating-fixtures.spec.ts`), so a future resolution change that
over-quiets is caught by a test, not by a number moving. The queue-worker
`this.db` construction gap is the one case with **no** fixture pin yet — that pin
should be added when S5 closes the gap.
