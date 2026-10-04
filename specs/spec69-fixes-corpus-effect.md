# Spec 69 Fixes 1–5 — corpus effect (before/after, attributed)

The six-fix working list that closed out Spec 69 Slice 1 changed rule behavior;
the synthetic rule-evidence corpus proves *what* changed, but the only evidence
that the fixes did something in the wild is their effect on the real read-only
corpora. This report is that evidence: the before/after finding count, per fix,
per corpus, attributed to the mechanism the fix changed.

## Method

Each fix's commit is checked out in turn; `scripts/measure-corpus-counts.ts`
runs the full `runAudit` pipeline against each corpus and prints per-rule
counts (read-only — the index/ledger scratch goes to
`CODE_AUDITOR_DATA_DIR=/tmp`, never into the target). The base is `6943a29`
(Spec 69 Slice 1, immediately before Fix 1); each subsequent row is the commit
that landed that fix, so the delta between consecutive rows is that fix's
effect alone.

Corpora: `recall-protocol`, `hhra-org`, `openstatus`, `blitz` — the same set
the corpus baselines pin.

## Before/after table

Only the rules a fix touched are shown. `0` means the rule fired no findings on
that corpus (absent from the per-rule output).

| fix | commit | rule | recall-protocol | hhra-org | openstatus | blitz |
|---|---|---|---|---|---|---|
| base | `6943a29` | — | — | — | — | — |
| 1 | `0385905` | missing-org-filter | 0 → 0 | 71 → 70 | **175 → 86** | 0 → 0 |
| 2 | `bb3493e` | sql-injection-risk | 12 → 12 | **0 → 7** | **1 → 11** | 0 → 0 |
| 3 | `888eeb9` | missing-org-filter | 0 → 0 | 70 → 70 | 86 → 86 | 0 → 0 |
| 4 | `5fef1b0` | unfiltered-query | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| 5 | `f4c9226` | loop-query | **193 → 209** | 7 → 7 | **24 → 26** | 2 → 2 |

Advisory-total cross-check (must equal the sum of the per-fix deltas above):

| corpus | total (base → after fix 5) | Δ |
|---|---|---|
| recall-protocol | 5116 → 5132 | +16 |
| hhra-org | 1184 → 1190 | +6 |
| openstatus | 4182 → 4105 | −77 |
| blitz | 1035 → 1035 | 0 |

## Attribution

**Fix 1 — `hasOrganizationFilter` reads the configured tenant column
(`0385905`): −90 total (−1 hhra-org, −89 openstatus).** The predicate detector
ran on a hardcoded eight-name vocabulary while table discovery read the
configured `orgFilterColumns` — two vocabularies for one concept. `openstatus`
tiers on `workspaceId`, which was outside the eight, so its *predicates* were
invisible the same way its *tables* were: a query scoped by
`eq(x.workspaceId, …)` read as having no tenant predicate and fired. Unifying
predicate detection and tier discovery on the one configured vocabulary quiets
those 89 false positives. `hhra-org` tiers on the default `organization_id`,
which was already in the eight, so its one Fix-1 move is **not** the vocabulary
half but the dotted-value half: `existingRelation` in
`app/api/admin/users/[userId]/organizations/route.ts` (`POST`) is a
correctly-scoped `eq(userOrganizations.organizationId, validatedData.organizationId)`
whose dotted *value* the old blanket lookahead misread as a join (−1). See
`spec69-r5-hhra-redisposition.md`. This is the largest single real-corpus move
in the whole fix set.

**Fix 2 — tagged templates recurse for interpolation (`bb3493e`): +17 total
(+7 hhra-org, +10 openstatus).** `sql\`…\`` tags whose template is a direct
child carry no `arguments` node, so the old recursion never reached the `${…}`
interpolation; a raw string-concatenation interpolation inside a tag was
silently missed. The fix recurses into the direct `template_string` child, so
those genuine injection sites now fire. Net-positive on both corpora that use
drizzle tagged templates.

**Fix 3 — quoted camelCase DDL identifiers (`888eeb9`): 0 everywhere.** The
motivating case — a `projects_v2` table whose tenant column is a quoted
camelCase `"organizationId"` that lowercases to one token and evades Tier-3
discovery — is synthetic-only. No real corpus declares a tenant column that
way, so the fix moves nothing in the wild. Its value is closing the discovery
asymmetry, proven by the corpus fixture, not by a real delta.

**Fix 4 — the `unfiltered-query` read half consumes Tier 3 (`5fef1b0`):
0 everywhere.** `unfiltered-query` fires no findings on any of the four corpora
at any commit, so adding Tier-3 DDL-discovered tenant tables to the read half
moves nothing in the wild. The motivating shape — a filterless *read* of a
DDL-only tenant table with no Tier-1/Tier-2 declaration — does not occur in
these repos. The change is still load-bearing for the corpus (three new
directives) and for future repos, but its real-corpus delta is zero and
reported as such, not silently skipped.

**Fix 5 — `.get()` into the eager set + iterator-callback loop detection
(`f4c9226`): +18 total (+16 recall-protocol, +2 openstatus).** Two distinct
root causes: `.get()` (the single-row read shared by better-sqlite3 /
node:sqlite / bun:sqlite) was missing from the eager-method set, so
`db.prepare(…).get(…)` in a loop read as statement construction and was
skipped; and `isIteratorCallback` extracted the iterator method name through a
dead path (`getNodeText(prop, '')`), so `.forEach`/`.map` callbacks were never
recognized as implicit loops. Both are genuine N+1 surfaces now firing.
`recall-protocol` dominates because it is the largest corpus and uses both
`.get()` and array-iterator callbacks heavily.

## What the numbers say

- The fix set is a net **−55** advisory findings (−90 from Fix 1, +17 from Fix
  2, +18 from Fix 5; Fixes 3 and 4 are corpus-only). The three findings-adding
  fixes tighten genuine detections (injection, N+1); the one findings-removing
  fix deletes 90 false positives, the bulk of them openstatus's invisible
  `workspaceId` predicates.
- Fixes 3 and 4 are **proven by the synthetic corpus, not by real corpora** —
  their motivating shapes do not occur in these repos. That is the honest
  division of labor: the corpus exists precisely to carry the cases the real
  repos don't.
