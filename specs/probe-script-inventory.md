# Probe-script inventory

The question each script answered, and what I had to import to answer it
because the CLI/report could not. Captured on request (2026-10-07) so the
requirement set lives in the repo instead of in deleted `/tmp` files.

Every "imports" line lists the production pipeline internals I had to reach
through directly. Those imports *are* the explain surface: the thing a user
asks when a finding says `unproven` or flags a method name.

## A. Discarded `/tmp` scripts (this pass)

- `dump-ground.mts` — "What loop-query + data-access facts does the phase model emit for these three files?"
  imports `buildLoopQueries` + `buildDataAccessCalls` from `phase/runner.js`.
- `dump-loop.mts` / `dump-loop2.mts` — "Why does this loop fire `loop-query` — which wrapper, which evidence?"
  imports `extractWithinFileProvenance`, `extractLoopQueryRawCandidates`,
  `classifyLoopQueries`, `classifyBuildProvenance`, `rehydrateWithinFileProvenance`.
- `dump-real.mts` / `dump-identity.mts` — "What are the raw loop-query candidates at these lines, and what binds them?"
  imports `extractWithinFileProvenance`, `extractLoopQueryRawCandidates`.
- `dump-provenance.mts` — "What is the dbProvenanced set (name → reason) for a file?"
  imports `classifyBuildProvenance`, `rehydrateReceiverProvenance`,
  `rehydrateWithinTsExtracts`, `rehydrateReceiverActivity`.
- `dump-root.mts` / `dump-root2.mts` — "Why does `classifyRootIdentifier('testFuncIds')` return `handle`?"
  imports `classifyRootIdentifier`, `classifyBuildProvenance`, `classifyValue`.
- `probe-go-orm.mts` / `probe-go-orm2.mts` — "What does the Go ORM path emit for sqlc / sqlx / ent?"
  imports `buildDataAccessCalls` from `phase/runner.js`.

## B. Committed `scripts/` probes

- `probe-receiver-root.ts` — "What root does `resolveReceiverRoot` assign to `this.env.DB.prepare` / `db.query` / `$(table).find`?"
  imports `resolveReceiverRoot`, `getCallExpressionCallee`, `getMemberExpressionReceiver`.
- `probe-d1.ts` / `probe-d1-declaration.ts` / `probe-d1-full.ts` — "How does a D1 type declaration become a handle?"
  imports the declaration-resolution / provenance path directly.
- `probe-appdb.ts` / `probe-unknown-table.ts` — "What happens to a table the resolver can't place?"
  imports the unknown-table / app-DB resolution path.
- `dump-db-unproven.ts` — "Which DB-rooted sites are still `unproven`, and why?"
  imports the DB-root classification path.
- `dump-blocking.ts` / `dump-unresolved-receivers.ts` / `dump-unresolved-sites.ts` — "What is the disposition of every receiver site that didn't resolve?"
  imports receiver-activity + provenance rehydration.

## C. Committed `scripts/` measures

- `measure-phase-unproven.ts` / `measure-phase-unproven-split.ts` — "How many handle / not-handle / unproven per corpus?"
  imports `classifyRootIdentifier` + provenance over the corpus.
- `measure-phase-dataaccess.ts` / `measure-env-rooted-split.ts` / `measure-provenanced-roots.ts` — "How do the data-access dispositions split across a corpus?"
  imports the phase data-access + env-root provenance path.
- `measure-sql-parse-failure.ts` / `measure-sql-detection-loss.ts` — "How many SQL strings fail to parse, and how many handle-calls are lost?"
  imports the SQL extraction/parse path.
- `measure-name-fallback-cost.ts` — "How often does the method-name regex fallback fire?"
  imports `extractMethodName` + the fallback path.

## The two missing surfaces

1. **Explain (per-site disposition trace).** Group A + the `dump-*` probes all ask
   the same question: *for this site, which evidence sources ran and what did each
   say?* `unproven` with no trace is where the user stops. The three-way
   disposition has a `reason` field that is currently `undefined` on emitted
   findings — there is nothing below the CLI.
2. **Coverage (disposition split).** Group C counts handle / not-handle / unproven
   per corpus. The report has a coverage section; it does not report the split.
