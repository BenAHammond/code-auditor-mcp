# Spec 69 R5 — re-disposition of the hhra-org `missing-org-filter` findings

The 71 hhra-org `missing-org-filter` findings split into **69 genuine + 2
false positives**. This report re-measures after R3's local-binding resolution,
re-samples every remaining finding, and records the split before any baseline
is pinned (criterion 12 — no baseline before the split is on record).

## The measurement, attributed

Measured with `scripts/measure-corpus-counts.ts` (read-only,
`CODE_AUDITOR_DATA_DIR=/tmp`, the same harness as the Fix 1–5 report):

| stage | hhra-org `missing-org-filter` | movement | attributed to |
|---|---|---|---|
| pre-Fix-1 (`6943a29`) | 71 | — | the spec's headline |
| after Fix 1 (`0385905`) | 70 | −1 | the stray configured-column FP (see `spec69-fixes-corpus-effect.md`) |
| **after R3 (`c8b49ea`)** | **68** | **−2** | **local binding resolution — the two unconditional builders** |

Advisory total follows the same arithmetic: 1190 (after Fix 5) → **1188** (the
−2 is exactly the two quieted builders; nothing else moved).

The −2 is the two false positives the spec names:

## The two false positives (now quiet)

Both are the *unconditional* builders — the `conditions` array initializer
always carries the org predicate, so a finding asserting its absence was false
whatever the cause. R3 resolves the initializer as all-paths and the rule goes
quiet.

| function | file:line | shape | before | after |
|---|---|---|---|---|
| `getAccessibleSampleIds` | `lib/middleware/organizationFilter.ts:124` | `const conditions = [inArray(sampleOwnership.organizationId, orgIds)]` then `.where(and(...conditions))` | critical | quiet ✓ |
| `getCertifierTestResults` | `src/lib/queries/certifier-data.ts:240` | `const conditions = [eq(certifierResidueTests.organizationId, params.organizationId)]` then `.where(and(...conditions))` | critical | quiet ✓ |

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
| 1 | `isOrganizationAdmin` | `lib/utils/organizationFilters.ts:138` | `if (organizationId) conditions.push(eq(userOrganizations.organizationId, organizationId))` | "…when `organizationId` is absent" |
| 2 | `getUploadStatus` | `src/lib/queries/certifier-data.ts:148` | `if (organizationIds && organizationIds.length > 0) conditions.push(inArray(rawCertifierData.organizationId, organizationIds))` | "…when `organizationIds && organizationIds.length > 0` is absent" |
| 3 | admin data page | `app/private/admin/data/page.tsx:36` | `if (organizationId && organizationId !== 'all') conditions.push(eq(rawCertifierData.organizationId, organizationId))` | "…when `organizationId && organizationId !== 'all'` is absent" |
| 4 | sample-ownership stats | `app/api/admin/sample-ownership/route.ts:59` | ternary `organizationId ? statsQuery.where(eq(sampleOwnership.organizationId, organizationId)) : statsQuery.limit(…)` | plain (no spread — outside R3's ceiling) |
| 5 | admin data base | `app/private/admin/data/page.tsx:62` | `query = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery` | plain (reassignment — outside R3's ceiling) |

Cases 1–3 exercise R3's some-paths path (the "is absent" message). Cases 4 and
5 are the two conditional forms R3 deliberately does **not** resolve — its
ceiling is the `.where(and(...conditions))` spread within one statement, not a
ternary predicate nor a builder reassignment. They fire with the plain message
today and are pinned so they stay firing rather than being mistaken for
all-paths and silenced.

## The remaining 63 — real IDOR surfaces and real unfiltered queries

Every one of the 63 remaining findings was sampled individually; all are
genuine. They fall into two buckets, matching the spec's "real IDOR surfaces,
real unfiltered queries":

- **Real IDOR surfaces** — primary-key / uploadId-keyed lookups on a tenant
  table with no ownership check: a caller who can name an `id` reads the row
  regardless of organization. This is `missing-org-filter`'s purpose. The
  `upload_jobs` and `raw_certifier_data` PK lookups are the canonical set.
- **Real unfiltered queries** — aggregates, admin-list, and membership-list
  queries that touch a tenant table (`user_organizations`,
  `sample_ownership`, `raw_certifier_data`, `upload_jobs`) with no
  `organization_id` predicate at all.

Full disposition, per file (68 findings, the 5 conditional cases included and
marked):

| file | count | tables | category |
|---|---|---|---|
| `queue-worker/src/queue-worker.ts` | 5 | `upload_jobs` | IDOR (worker claims a job by id, `FOR UPDATE SKIP LOCKED`) |
| `app/api/dashboard/stats/repositories.ts` | 5 | `raw_certifier_data`, `processed_certifier_data` | unfiltered (admin dashboard aggregates) |
| `queue-worker/src/processing-service.ts` | 4 | `raw_certifier_data` | IDOR (upload-id-keyed lookups) |
| `app/private/admin/sample-ownership/page.tsx` | 4 | `sample_ownership`, `organizations`, `user_organizations`, `users` | unfiltered (admin list/join queries) |
| `app/private/admin/queue/page.tsx` | 4 | `upload_jobs`, `raw_certifier_data` | IDOR / unfiltered (admin queue list) |
| `src/lib/queries/certifier-data.ts` | 4 | `upload_jobs`, `raw_certifier_data` | IDOR (`getCertifierUpload` id-lookup, `getUploadJobStatus`) + 1 conditional (#2) |
| `app/private/admin/data/page.tsx` | 3 | `raw_certifier_data` | 2 conditional (#3, #5) + 1 unfiltered (status aggregate) |
| `database/services/repositories/JobRepository.ts` | 2 | `upload_jobs` | IDOR (id-keyed `getJob`/`updateJob`) |
| `database/services/repositories/UploadRepository.ts` | 2 | `raw_certifier_data` | IDOR (id-keyed lookups) |
| `src/lib/services/certifier-upload-processor.ts` | 2 | `upload_jobs`, `raw_certifier_data` | IDOR (upload/job id-keyed) |
| `src/lib/queries/organizations.ts` | 2 | `user_organizations` | unfiltered (membership lookup + admin count) |
| `scripts/enable-org-filtering.ts` | 2 | `sample_ownership`, `user_organizations` | unfiltered (one-shot migration script) |
| `lib/utils/organizationFilters.ts` | 2 | `user_organizations` | 1 conditional (#1) + 1 unfiltered (`getUserOrganizations`, user-keyed) |
| `app/private/admin/system/page.tsx` | 2 | `upload_jobs`, `raw_certifier_data` | unfiltered (system health counts) |
| `app/api/health/database/route.ts` | 2 | `upload_jobs`, `user_organizations` | unfiltered (health-check counts) |
| `app/api/dashboard/activity/repositories.ts` | 2 | `raw_certifier_data`, `data_access_log` | unfiltered (activity aggregates) |
| `app/api/admin/users/[userId]/organizations/[relationshipId]/route.ts` | 2 | `user_organizations`, `organizations` | unfiltered (membership read/delete) |
| `app/api/admin/sample-ownership/route.ts` | 2 | `sample_ownership`, `organizations` | 1 conditional (#4) + 1 unfiltered (count aggregate) |
| `app/api/admin/jobs/[jobId]/route.ts` | 2 | `upload_jobs` | IDOR (job-id-keyed read/update) |
| `tests/unit/organization-isolation.test.ts` | 1 | `user_organizations` | unfiltered (test fixture) |
| `src/lib/queries/user-organizations.ts` | 1 | `user_organizations`, `organizations` | unfiltered (membership join) |
| `lib/middleware/organizationFilter.ts` | 1 | `user_organizations`, `organizations` | unfiltered (`validateOrgAccess` membership) |
| `components/certifier/UploadHistory.tsx` | 1 | `raw_certifier_data`, `upload_jobs` | unfiltered (history list) |
| `app/private/admin/users/page.tsx` | 1 | `users`, `user_organizations` | unfiltered (admin user list) |
| `app/private/admin/users/[userId]/page.tsx` | 1 | `user_organizations`, `organizations` | unfiltered (user membership detail) |
| `app/private/admin/queue/[jobId]/page.tsx` | 1 | `upload_jobs`, `raw_certifier_data`, `users` | IDOR (job detail) |
| `app/private/admin/page.tsx` | 1 | `upload_jobs` | unfiltered (dashboard count) |
| `app/private/admin/organizations/page.tsx` | 1 | `organizations`, `user_organizations` | unfiltered (admin org list) |
| `app/api/admin/users/export/route.ts` | 1 | `users`, `user_organizations` | unfiltered (export) |
| `app/api/admin/users/bulk/route.ts` | 1 | `user_organizations` | unfiltered (bulk upsert lookup) |
| `app/api/admin/users/[userId]/route.ts` | 1 | `user_organizations` | unfiltered (membership delete) |
| `app/api/admin/users/[userId]/organizations/route.ts` | 1 | `user_organizations`, `organizations` | unfiltered (membership list) |
| `app/api/admin/organizations/export/route.ts` | 1 | `organizations`, `user_organizations` | unfiltered (export) |
| `app/api/admin/jobs/export/route.ts` | 1 | `upload_jobs` | IDOR (export) |

## Baseline

The split is on record before any baseline is pinned (criterion 12). The
`corpus-baselines.md` un-re-pinned-drift note now records the superseding count
— **68** (`data-access::missing-org-filter`, hhra-org), advisory total **1188** —
superseding the stale 9; the pinned per-corpus table re-pin lands with the
release step (#338), not here. The two quieted builders and the five conditional
cases are pinned as fixtures (`spec69-r5-conditional-mustfire.spec.ts` for the
five, plus the R3 all-paths/some-paths pair in
`spec69-r3-motivating-fixtures.spec.ts`), so a future resolution change that
over-quiets is caught by a test, not by a number moving.
