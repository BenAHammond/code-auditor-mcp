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
- R3 disposition landed: the never-written / never-serialized seams were removed
  (`AnalyzerResult.extras`, `AnalyzerResult.filesProcessed`,
  `PolyglotAnalysisResult.crossLanguageViolations`, `getContentHashesForFiles`),
  and the `@deprecated` notes on `Violation.analyzer` / `Violation.type` were
  replaced with their real contracts (fingerprint bucket / SARIF rule-id
  precedence 4). Fields emitted to users via JSON's verbatim spread
  (`importSpecifier`, `caller`, `fix`, `sourceFormat`) stay.
- R6 landed: the always-empty `signature` argument was removed from
  `computeContentHash` (body-only hashing) **and** the always-empty
  `functions.signature` column was removed end-to-end (schema, FTS mirror,
  triggers, `functionToRow`/`rowToFunction`/`registerFunction`, the search
  surface, CLI display, `conventionMiner`, and every test fixture). `SCHEMA_VERSION`
  bumped 16→17 with a migration that drops the column, rebuilds `functions_fts`
  without it, and clears the index — a test demonstrates a pre-bump index is
  rebuilt, not silently consumed, on open. The reducer `filesProcessed: 0`
  residual in the JSON writer was also fixed (reducers omit `filesProcessed` and
  carry `factsConsumed`).
  Remaining: R2's conformance test class.

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
| `analyzer` | ✓ | via fingerprint only | ✓ | ✓ | ✓ (fingerprint) |
| `type` | ✓ | ruleId precedence 4 | — | — | — |
| `principle` | ✓ | ruleId precedence 2 | — | — | — |
| `schemaType` | ✓ | ruleId precedence 5 | — | — | — |
| `violationType` | ✓ | ruleId precedence 6 | — | — | — |
| `details.rule` | ✓ | ruleId precedence 3 | — | — | — |
| symbol fields (`symbol` → `functionName` → … → `enclosingSymbol`) | ✓ | via fingerprint only | — | — | ✓ (fingerprint) |

Two consequences for R3, recorded below.

### `analyzer` and `type` are load-bearing, not deprecated

`Violation.analyzer` and `Violation.type` each carried a `@deprecated` note, and
both notes were wrong — a deprecation on a field that identity depends on is worse
than no note, because it invites the next author to "finish" the cleanup and
silently re-key every finding. The notes are removed (`types.ts`); the fields'
real contracts are documented in place.

**`analyzer`** is the **first component of the fingerprint tuple**
(`buildFingerprintInput`, `fingerprint.ts`), which keys SARIF
`partialFingerprints`, every baseline entry, and every dismissal:

- `auditRunner.ts` has a dedicated normalization block that stamps
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

**`type`** is the **precedence-4 rule-id fallback** in SARIF `resolveRuleId`
(`rule` → `principle` → `details.rule` → `type` → `schemaType` →
`violationType` → `'unknown'`), carried by the DRY, Data Access, and Dependency
Graph analyzers that predate the canonical `rule` field.

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

### Disposition: emitted-to-users stay; never-written/never-serialized go

R1 pins what each reporter emits, and the JSON reporter spreads each violation
verbatim, so a field that JSON carries is *emitted to users* even when no internal
reader reads it back. That is not a dead seam — the report is the field's terminal
consumer. Four fields are in this bucket and stay, recorded here rather than as
removal candidates:

| field | written by | emitted via |
| --- | --- | --- |
| `importSpecifier` | invariant `import-ban` | JSON verbatim spread |
| `caller` | `call-constraint` | JSON verbatim spread |
| `fix` | resolvable rules | JSON verbatim spread |
| `sourceFormat` | cross-domain `detectMeasuredUncovered` (`uncovered-risk`) | JSON verbatim spread |

(`sourceFormat` was first mis-filed as "never-written"; it *is* written — by
`CrossDomainAnalyzer.detectMeasuredUncovered` — and therefore emitted, which puts
it in the same bucket as `importSpecifier`/`caller`/`fix`, not the delete bucket.)

The seams that are genuinely dead — never written, never called in production, or
written-but-never-serialized — are removed:

| seam | proof |
| --- | --- |
| `AnalyzerResult.extras` | declared, never written nor read anywhere. |
| `AnalyzerResult.filesProcessed` | written/read only by `UniversalSchemaAnalyzer` to aggregate its sub-results, and effectively always `0` because the sub-results populate `status.filesProcessed`, not this field; the JSON reporter reads `getFilesProcessed(result.status)` instead. Rewired to `getFilesProcessed(...status)`. |
| `PolyglotAnalysisResult.crossLanguageViolations` | written (`LanguageOrchestrator`), never read downstream — the findings already flow through `violations`. Field removed; `CrossLanguageViolation` type kept (return type of the cross-language detectors). |
| `getContentHashesForFiles` | no production caller — superseded by the single `computeContentHash` (R5); only a unit test exercised it. Method + test removed. |

## R6 — the `signature` argument was a dead seam; removed, with a schema bump

R5 unified `computeContentHash(body, signature)` as the single content-hash
definition imported by both consumers. R6 resolves its second argument.

**The `signature` argument was always empty.** Every producer fed it an empty
value — the pipeline's function-index visitor wrote the literal `''`
(`pipelineAdapters.ts:636`) and `FunctionScanner` left the field `undefined` —
so it contributed a constant `|` suffix to every hash and never distinguished
one function from another. It *looked* like it identified the function's
declaration (a real, useful thing to hash) while no producer populated it — the
same shape as the written-never-read seams above, but worse: it silently
degraded the hash's precision rather than doing nothing.

**Disposition: removed, not populated.** Populating it would be a new feature
(signature extraction across TS/JS/Go) that no consumer has asked for; the body
alone is what change detection needs. `computeContentHash(body)` now hashes only
the normalized body. The three call sites dropped their empty second argument
(`pipelineAdapters.ts:622`, `codeIndexDB.ts` `functionToRow` and
`detectChangedFunctions`).

**The `functions.signature` column goes too.** It was the second half of the
dead seam: `functionToRow` wrote `''` into it on every row, and full-text search
mirrored it in `functions_fts` — a column that has never held data, i.e. the
same shape the previous two days spent deleting. It is removed end-to-end: the
column, the `functions_fts` mirror, and its `functions_ai/ad/au` trigger terms
all go, and the search surface drops the field (`searchFields` union,
`signatureMatch` weight, `signature` highlight, the `'signature'` default in
`QueryParser`, the CLI definition/search display, and `conventionMiner`'s read).
`CrossLanguageEntity.signature` (populated, read by `APIContractAnalyzer`) and
the telemetry structural signature are separate surfaces and stay.

**`SCHEMA_VERSION` 16→17 + a rebuild migration.** Changing the hash formula
invalidates every stored `content_hash` (each was computed under the old
`body|signature` formula), and the column removal means a pre-bump schema no
longer matches what `functionToRow` writes. The 16→17 migration drops the
`signature` column and rebuilds the `functions_fts` surface without it (SQLite
refuses `DROP COLUMN` while the FTS triggers reference it, so the triggers and
FTS table are dropped first), then `DELETE FROM functions` to force the derived
index to be re-derived from source on the next sync. Without it, a pre-bump index
would be **silently consumed**: a no-edit `changed` run recomputes a body-only
hash, compares it to the stored body|signature hash, and reports the whole file
changed — attributing to the code what was actually the index's stale hash.

**The rebuild is demonstrated, not just coded.** Three tests pin it:

- `auditScope.spec.ts` "stale-index rebuild (Spec 63 R6)" indexes a function,
  stamps the stored `schema_version` down to 16 and plants a stale hash,
  re-opens the DB, and asserts the row is gone (`getAllFunctions()` is empty)
  and the version is now 17. It also asserts `functions_fts` held a real row
  *before* the stamp-down (the DELETE-before-FTS-drop ordering that risks
  corruption only surfaces with populated FTS content) and that
  `PRAGMA integrity_check` returns `ok` afterward — the rebuild leaves the
  database *sound*, not just empty.
- `codeIndexDB-sqlite.spec.ts` "schema migration replay" reconstructs the
  pre-17 `functions` shape (signature column, signature-bearing `functions_fts`
  and triggers, populated rows), then replays the chain forward from every
  historical version 0..16, asserting `integrity_check = ok` and
  `schema_version = 17` after each. Ordering hazards between `functions` and its
  external-content FTS aren't unique to 16→17 — one test covers the class.

**A fresh database skips migrations entirely.** `createSchema` produces the
current shape, so `runMigrations` runs only against an existing index being
upgraded in place: `createSchema` detects a fresh DB (no `functions` table
before its `CREATE TABLE`s) and stamps `schema_version = SCHEMA_VERSION` without
replaying history the DB never lived through. This turns "every future migration
author must remember an idempotence guard" into "there is nothing to guard
against" — the same structural move as the tier function and the exhaustiveness
assertion. Completing the move surfaced that three tables (`graph_cache`,
`import_specifiers`, `style_defined_classes`) were created only by migrations,
not by `createSchema`; they are now in `createSchema` too, so a fresh DB really
does get the full current shape.

### Reducer `filesProcessed: 0` residual (raised mid-R6)

The R3 `filesProcessed` audit left one statement the reducer never made: the JSON
writer emitted `filesProcessed: getFilesProcessed(result.status)`, which is `0`
for a `reducer-ran` status because `getFilesProcessed` returns 0 for anything
that is not `visitor-ran`. A CI script reading `summary.filesProcessed` to check
whether the schema analyzer ran was told it processed nothing. Fixed in the JSON
writer: a reducer summary **omits** `filesProcessed` and **carries**
`factsConsumed` instead. Presence (not the number) is now the signal that
distinguishes "scanned nothing" from "doesn't count files" — the same clean-vs-
cannot-fire distinction enforced elsewhere. Pinned by
`jsonReportGenerator.spec.ts`.

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
