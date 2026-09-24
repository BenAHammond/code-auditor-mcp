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
- R1 landed (reporter serialization table below) — R3's dead list is now settled
  against what reporters actually emit, not just what analyzers read back.
  Remaining: R6 (`signature` populated or removed with the schema bump), then
  R2's conformance test class.

## R1 — what each reporter actually serializes

R3 classifies a seam as dead only when *no consumer* reads it, and the four
reporters are consumers. A field that a reporter serializes is not dead even if
no analyzer reads it back — it reaches the user. R1 pins that surface. The JSON
reporter is the reference: it spreads each violation verbatim (`...violation`)
plus a `fingerprint` field, so JSON carries every field on the record. The other
three are allowlisted, and their field coverage is narrower than JSON's.

| field | JSON | SARIF | CSV | HTML | identity-bearing |
| --- | --- | --- | --- | --- | --- |
| `file` | ✓ | `artifactLocation.uri` | ✓ | ✓ | ✓ (fingerprint) |
| `rule` | ✓ | ruleId precedence 1 | ✓ | — | ✓ (fingerprint) |
| `line` / `column` | ✓ | `region` | both | line only | — |
| `severity` | ✓ | `level` | ✓ | ✓ | — |
| `message` | ✓ | fullDescription + result text | ✓ | ✓ | — |
| `suggestion` | ✓ | per-rule help + `properties.resolution` | — | — | — |
| `recommendation` | ✓ | — | ✓ | ✓ | — |
| `hotspot` | ✓ | `properties.hotspot` | ✓ | ✓ | — |
| `new` | ✓ | `properties.baseline` | — | — | — |
| `snippet` | ✓ | — | — | ✓ | — |
| `estimatedEffort` | ✓ | — | ✓ | — | — |
| `analyzer` (@deprecated) | ✓ | via fingerprint only | ✓ | ✓ | ✓ (fingerprint) |
| `type` (@deprecated) | ✓ | ruleId precedence 4 | — | — | — |
| `principle` | ✓ | ruleId precedence 2 | — | — | — |
| `schemaType` | ✓ | ruleId precedence 5 | — | — | — |
| `violationType` | ✓ | ruleId precedence 6 | — | — | — |
| `details.rule` | ✓ | ruleId precedence 3 | — | — | — |
| symbol fields (`symbol` → `functionName` → … → `enclosingSymbol`) | ✓ | via fingerprint only | — | — | ✓ (fingerprint) |

Two consequences for R3, recorded below.

### `analyzer` is deprecated-but-identity-bearing

`Violation.analyzer` carries `@deprecated Read from AnalyzerResult.analyzerName
instead.` (`types.ts:114`), but it is the **first component of the fingerprint
tuple** (`buildFingerprintInput`, `fingerprint.ts:56-67`), which keys SARIF
`partialFingerprints`, every baseline entry, and every dismissal. The deprecation
is contradicted twice over:

- `auditRunner.ts:906-929` has a dedicated normalization block that stamps
  `violation.analyzer` from the result key — with a comment calling the result key
  "the single source of truth" — precisely so fingerprints and `analyzerCounts`
  are correct (the react analyzer omits the field; the schema sub-visitors
  hardcode `'schema'` and the block re-buckets them). The field is actively
  maintained, not transitional.
- The fingerprint reads `violation.analyzer`, not `AnalyzerResult.analyzerName`.
  The two already diverge intentionally: `data-access-org-filter` is stamped
  `analyzer: 'data-access'` (`analyzerFieldOverride`) so the ledger group
  `data-access/missing-org-filter` stays stable across the Stage-2 → Stage-4
  move, while its `AnalyzerResult.analyzerName` remains `'data-access-org-filter'`.
  "Finishing" the deprecation — reading `analyzerName` instead — would change the
  fingerprint of every `missing-org-filter` finding.

Removing or renaming the field is therefore a migration with a user-visible blast
radius (every GitHub alert closes and reopens, every baseline resets, every
dismissal resurrects), not a cleanup — and nothing connects the `@deprecated`
note to the fingerprint. The correct disposition is to **remove the
`@deprecated` note** (the field is load-bearing), or, if the deprecation is kept,
to extend the note to name the fingerprint as the reason it cannot be removed so
the next author does not "finish" it.

### `symbol` falls back to `''`, collapsing file-level findings to one identity

`extractSymbol` returns `''` when no symbol field is present, so the tuple becomes
`[analyzer, rule, file, '']` and every unsymboled finding of a rule in a file
shares one fingerprint — dismissing one dismisses all, and a baseline records one
where there are N. Measured across the three corpora (3726 + 421 + 944 findings):

| corpus | empty-symbol findings | colliding groups (≥2 in same analyzer+rule+file) |
| --- | --- | --- |
| recall-protocol | 131 | 0 |
| hhra-org | 88 | 0 |
| blitz | 212 | 1 (3× `secrets/hardcoded-secret` in `apps/toolkit-app-passportjs/src/pages/api/auth/[...auth].ts`) |

Real but small: one group of three, in `hardcoded-secret`, a per-line rule with
no extractable symbol by construction. Not a systemic problem today, but a latent
one for any future symbol-less per-line rule — N firings per file that collapse
to one identity are coarser than the users relying on dismissals/baselines
believe. (Not gating R3; recorded here because it is an identity-seam property,
not an analyzer one.)

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
