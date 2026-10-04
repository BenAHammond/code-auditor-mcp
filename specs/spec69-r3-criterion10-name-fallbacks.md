# Spec 69 R3 criterion 10 — zero name-based fallbacks (met)

Criterion 10 (§10 of the producer contract) is **met**. This record documents
where receiver identification lives, what the in-repo replacement is, the
measured cost of deleting the name list, how `inferredReceivers.ts` relates, and
the post-deletion grep proof. Criteria §7, §8 and §9 were met earlier (the
one-resolution-fact rename + enrichment, natural-unique-only quiet set, and
local binding resolution); §10 has now landed as the four steps S1–S4 below:

- **S1** — the cross-file in-repo declaration resolution
  (`src/analyzers/receiverResolution.ts` → `resolveReceiverProvenance`) was built
  first, exactly as the criterion required: no name list is consulted.
- **S2** — the overlap was measured (`spec69-r5-criterion10-receiver-resolution-measurement.md`):
  442 receivers, 150 recovered by declaration, 8 not-a-handle, 284 cannot-fire.
- **S3** — `DB_RECEIVER_NAMES` and its fallback machinery (`addNameListFallbacks`,
  `buildNamesOnlyProvenance`, `addIdentifierFallbacks`, `addBindingFallbacks`,
  and the user-configurable `dbReceiverNames` surface) were deleted, with the
  cannot-fire accounting landing in the same change so no receiver goes silently
  `clean`.
- **S4** — the ~20 fixtures that imported a DB handle from a nonexistent
  `./db` were given a real declaring file / `DB_HANDLE_TYPES` type annotation
  (the production declaration pattern, not a resolver special case); all 32
  resulting test failures were fixed and the full suite is green.

## Where receiver identification lives today

Two distinct mechanisms answer "is this a DB call?", neither of which reads a
name list:

1. **Query-builder chains** (`.select().from(`, `.insert().values(`, the Prisma
   object form) are discovered by a **shape test** — a verb-plus-companion
   grammar over the AST — not by what the receiver is named. This was Spec 68
   Thing 2 (`#312`), and it is name-independent already.
2. **Raw SQL** (`db.exec(sql)`, `db.query(sql)`, `db.prepare(sql)`,
   `db.run/all/first/batch`) has no chain grammar, so its receiver is resolved
   by `buildProvenanceContext` (`src/analyzers/provenance.ts`):

   - `extractDBProvenancedImports` seeds identifiers imported from a known DB
     package (`DB_PACKAGES`: `drizzle-orm`, `better-sqlite3`, `pg`, …).
   - `propagateProvenance` propagates within a file (`const db = drizzle(…)`,
     `new Database(…)`, `await`, destructuring).
   - **Rule 8 / Rule 8b** propagate a `DB_HANDLE_TYPES` type annotation
     (`let db: D1Database; constructor(db: Pool)`) to the identifier/parameter —
     type-anchored, not name-anchored.
   - **Cross-file resolution** (`resolveReceiverProvenance` →
     `seedProvenance`) merges the per-file DB-provenanced identifier set produced
     by the in-repo declaration resolution into the import seeds before
     propagation. This is the declaration-based replacement for the deleted name
     heuristic.

The deleted name list existed because the common application pattern is
`import { db } from './db'` — a *relative, in-repo* re-export of a DB client —
and `extractDBProvenancedImports` only matched node_modules package specifiers,
so `./db` was invisible to provenance. `resolveReceiverProvenance` closes that
gap by tracing the relative specifier to the declaring file and checking whether
that file exports the name as DB-provenanced (package import / construction /
wrapper / transitive cross-file import), terminating at a `DB_PACKAGES` import
or an unresolvable receiver.

## What resolving against in-repo `db` declarations replaces it with

The name list is replaced by a **cross-file, in-repo declaration resolution**: a
receiver is DB-provenanced only if it resolves to a declaration present in the
audited repository, tracing relative import specifiers (`./db`, `../db`,
`@/db`, `/index`) to the declaring file and checking whether that file exports
the name as DB-provenanced (via a package import or a construction, e.g.
`export const db = drizzle(…)` where `drizzle` came from `drizzle-orm`). This is
a transitive fixed-point over the repo's module graph; it terminates at a
`DB_PACKAGES` import or at an unresolvable receiver. No `node_modules` type
checker is involved — the ceiling holds: only declarations inside the audited
repo are consulted.

An unresolvable receiver (a runtime binding like `env.DB`, a wrapper not
traceable to a declaration, or a specifier that cannot be resolved to an in-repo
file) reports **`cannot-fire` with the reason** rather than guessing by name.
This is the correct end-state for recall-protocol's Cloudflare D1 bindings
(`env.DB`) and its `d1Query`/`d1Exec` wrappers, which are runtime bindings, not
repo declarations. The `DB_BINDING_NAMES` (`env.DB`) and `DB_WRAPPER_NAMES`
(`d1Query`/`d1Exec`) lists **stay** — they are project-specific runtime forms,
not a name guess over the receiver's English name.

## What deleting the name list costs (measured, superseded)

This section is retained for the finding-level cost, which the S2 instrument
does not cover. The receiver-level cost table is superseded by
`spec69-r5-criterion10-receiver-resolution-measurement.md`, which counts bare
receivers structurally rather than every word-boundary occurrence (including
JSON, comments, and `this.db`), and which exists only because the resolution was
built first.

The headline: for recall-protocol and knex, **~99%** of DB-provenanced
identifiers came from the name list, not a package import — because their access
is through `./db` re-exports and D1 bindings. Deleting `DB_RECEIVER_NAMES`
without the in-repo resolution would have collapsed raw-SQL detection to near
zero on those corpora. The in-repo resolution is therefore not an optimisation;
it is the criterion — and it landed before the deletion, so the collapse never
happened.

The finding-level cost is smaller, because query-builder findings are
shape-tested and do not read the name list — but it was **not zero**: hhra-org's
`missing-org-filter` findings include a raw-SQL subset (e.g.
`queue-worker/src/queue-worker.ts`'s five `this.db.query(…)` IDOR surfaces, plus
the admin pages' `getSql()` reads) whose receiver was recognised by name. Those
raw-SQL findings are recovered by the in-repo resolution
(`this.db = new Database()` → `./db` → `import { neon } from '@neondatabase/serverless'`),
which is what the 9 recovered hhra-org receivers in S2 are.

## How `src/codeIndex/inferredReceivers.ts` relates

`InferredReceiversStore` persists the inferred receiver set as one `MetaStore`
meta record (`inferred_receivers`). It is **orthogonal** to the deleted name
list — it is the persistence half of `inferReceivers`
(`src/analyzers/provenance.ts:1541`), the deferred conjunctive receiver
inference that traces a receiver calling a DB method back through within-file
assignment chains to a provenanced source. It is **not** the in-repo
declaration resolution (that is `receiverResolution.ts`, S1); it does not read a
name list, and it is untouched by the §10 deletion. It remains wired only into
the `config detection` subcommand (`src/cli.ts:1906`), not the phase
`data-access-calls` producer, which is unchanged from before the deletion.

The §10-relevant KEPT machinery is distinct and all live in
`src/analyzers/provenance.ts`:

- `DB_HANDLE_TYPES` (type-anchored) — the receiver *type* set, not a name list.
- `detectDbWrapperFunctions` / `detectDbWrapperClasses` — structural wrapper
  detection (D1 REST fetch, delegation to a provenanced identifier, wrapper
  classes). These were **kept**; `receiverResolution.ts` imports both (layers 3–4
  of its resolution).
- `DB_BINDING_NAMES` (`env.DB`) and `DB_WRAPPER_NAMES` (`d1Query`/`d1Exec`) —
  project-specific runtime forms, distinct from the deleted
  `DB_RECEIVER_NAMES` (`db`/`database`/`sql`/`stmt`).

## Grep proof

`isAbstractionBoundary` and its `/Error$/` suffix list are **gone** — the
open-closed rule uses `isErrorSubclass` with a fixed `BUILTIN_ERRORS` set plus an
`extends`-chain walk over the resolution fact's `classes`:

```
$ grep -rn "isAbstractionBoundary\|Error\$" src --include='*.ts' | grep -v __tests__   # no hits
```

`DB_RECEIVER_NAMES`, `dbReceiverNames`, `addNameListFallbacks`,
`buildNamesOnlyProvenance`, `addIdentifierFallbacks`, and `addBindingFallbacks`
are **gone** — the only surviving occurrences are comments/docstrings that
describe what was deleted:

```
$ grep -rn "DB_RECEIVER_NAMES\|dbReceiverNames\|addNameListFallbacks\|buildNamesOnlyProvenance\|addIdentifierFallbacks\|addBindingFallbacks" src --include='*.ts'
src/analyzers/receiverResolution.ts:5,388          // comment: "the deleted DB_RECEIVER_NAMES name list"
src/analyzers/provenance.ts:70,74,1162             // comment: "DB_HANDLE_TYPES vs DB_RECEIVER_NAMES"
src/analyzers/universal/UniversalDataAccessAnalyzer.ts:469   // comment: "deleted DB_RECEIVER_NAMES"
src/analyzers/universal/schema/codeAnalysis.ts:1233           // comment: "deleted DB_RECEIVER_NAMES"
src/pipeline.ts:784                                 // comment: "deleted DB_RECEIVER_NAMES"
src/types.ts:383,385                                // comment: "deleted DB_RECEIVER_NAMES"
src/cli-integration.spec.ts:606,691                 // comment: "addNameListFallbacks" (historical note)
src/phase/schemaUsage.ts:13                         // comment: "dbReceiverNames" (doc)
src/presets/presets.ts:7                            // comment: "dbReceiverNames" (doc)
src/__tests__/fixtures/spec-21/banco-provenance.ts:4        // comment (fixture doc)
src/__tests__/fixtures/spec-21/fallback-global.ts:5         // comment (fixture doc)
```

No executable reference remains: `src/analyzers/universal/schema/config.ts:23`
(`export const DB_RECEIVER_NAMES = …`) and `src/config/defaults.ts:264`
(`dbReceiverNames: ['db','database','sql','stmt']`) are both deleted.

The KEPT mechanisms (all distinct from the name list) survive, confirming the
deletion was surgical:

```
src/analyzers/provenance.ts:80           DB_HANDLE_TYPES
src/analyzers/provenance.ts:1118,1169    detectDbWrapperFunctions / detectDbWrapperClasses
src/analyzers/provenance.ts:1541         inferReceivers
src/analyzers/receiverResolution.ts      resolveReceiverProvenance (S1; imports both wrapper detectors)
src/codeIndex/inferredReceivers.ts       InferredReceiversStore (persistence for inferReceivers)
src/analyzers/universal/UniversalDataAccessAnalyzer.ts:186   dbBindingNames: [...DB_BINDING_NAMES]  (env.DB — stays)
```

## Status

- **§7, §8, §9 — met.** One resolution fact; natural-unique-only quiet set;
  local `const`/`let` binding resolution with all-paths vs some-paths (pinned by
  `spec69-r3-motivating-fixtures.spec.ts`).
- **§10 — met.** S1 (resolution) → S2 (measurement) → S3 (deletion with
  cannot-fire accounting) → S4 (fixture declaring files). The name list and its
  fallback machinery are gone; the grep proof above is the post-deletion record.
  The 32 tests that broke on deletion were fixed by real `DB_HANDLE_TYPES`
  annotations, not a resolver special case or relaxed path. Full suite green.
- **§12 — on record, final re-measure done (F1).** The hhra-org
  `missing-org-filter` count is **63** after §10, down **5** from the R3 baseline
  of 68 = 5 conditional + 23 IDOR + 40 unfiltered. The final split is
  **63 = 5 conditional + 18 IDOR + 40 unfiltered**; the −5 is the
  `queue-worker/src/queue-worker.ts` `this.db.query(…)` IDOR surfaces, whose
  `this.db = new Database()` construction the cross-file resolution does not
  trace (the `new <wrapper-class>()` gap), and which go **silently clean** — not
  `cannot-fire`, because `./db` resolves and the S2 instrument never counted
  `this.db` receivers. This is a measured, open defect (the S5 construction gap),
  recorded in `spec69-r5-hhra-redisposition.md`; the baseline is not pinned until
  S5 closes it or the gap is recorded as a standing limitation.
