# Spec 63 — Seam Conformance

The function index's identity and content-hash seams must behave identically
across languages — `detectChangedFunctions` and `computeContentHash` must not
branch on host language. R1 first; nothing in R3 until R1 is answered.

## Governing lesson (from Spec 62 A4)

A test whose fixture does not match producer output is a **drift signal, not a
fixture bug.** The bench's first live-defect catch was `styles/value-drift`
silently skipping every color/length property because its classifier read the
JSON-encoded `normalized_value` the indexer actually stores, while the fixture
(and the original test) assumed the raw CSS spelling. The fix was to make the
analyzer read what the producer emits — not to edit the fixture back to the
analyzer's assumption. Every seam-conformance test below follows the same rule:
pin to the producer's actual output shape, and treat a mismatch as the seam
being wrong.

## Status

- R4.1 / R4.2 / R5 landed (tasks #204–#206): `detectChangedFunctions` identity on
  `(name, line_number)`, the dead language ternary and ignored `scanFunctions`
  param removed, and a single `computeContentHash` imported by both consumers.
- Source collection + empirical `content_hash` test landed (#203).
- R1 (the identity question) is the next item, before R3.

## R3 — written-never-read seam table

A seam is not only "two functions that must agree" — it is also "a value that
is written and then never read," which is a dead seam: it *looks* like it does
something (it has a name, a producer, a stored field) while no consumer reads
its output. A dead seam is dangerous in exactly the way a live seam's drift is:
a future author widens it (adds `pg`, `mysql2`, `kysely`…) believing they are
extending recognition, and nothing moves, because the value was never consumed.
Each row records a chain that is written-never-read end to end, so it is
reverted or removed — not re-extended — the next time it is touched.

| seam (write path → never-read terminal) | file | proof |
| --- | --- | --- |
| `importPatterns` → `mapDatabaseImports` → `classifyCallType` → `DatabaseCall.type` | `src/analyzers/universal/UniversalDataAccessAnalyzer.ts` | `importPatterns` is read only by `mapDatabaseImports` (`:299-317`); its `dbImports` map is read only by `classifyCallType` (`:413`, `:437-449`); the return is assigned to `DatabaseCall.type` (`:416`); `.type` is read by no consumer — not `checkViolations`, `analyzeQuery`, the loop-query path, nor the Stage-4 `missing-org-filter` reducer (`pipelineAdapters.ts:278-293`, which reads `file`/`line`/`column`/`tables`/`hasOrganizationFilter`/`method`/`enclosingFunction`). Widening `importPatterns` cannot move a finding. Reverted (Spec 62 §5 widening); the drivers named there are recognized through `DB_PACKAGES` + provenance instead. |

## Fluent-chain provenance — a coincidence, not a capability

The kysely builder-chain fix (task #222) began from an apparent asymmetry:
drizzle builder chains (`db.select().from(…).where(…)`) *resolved* their root
receiver while kysely chains (`db.selectFrom(…).where(…)`) did not. The asymmetry
was an **accident**, not a special case. Drizzle resolved only because `select`
happened to already be in `ORM_METHODS`, so `db.select()` was recognized and the
rest of the chain stayed provenanced by coincidence; kysely's `selectFrom` /
`deleteFrom` / … are camelCase and absent from every live surface, so the chain
never resolved. No fluent chain was ever actually handled — the first
`call_expression` in the receiver path returned `null` from `resolveReceiverText`,
so `a.b().c().d()` dropped provenance at the first call boundary for *both*
drivers. The fix was therefore not a drizzle special-case but a general descent
through `call_expression` receivers (plus kysely's camelCase verb vocabulary in
the live surfaces `ORM_METHODS` / `isOrmPattern` / `hasWriteVerb` /
`hasMassWriteVerb` / `extractTables`). The capability that "looked real" (drizzle
resolved, kysely didn't) was a name-listing coincidence — the same shape as the
dead seams above, but benign: it cost nothing and misled a diagnosis.
