# Spec 70 — Item 4 "collapse the double-parse": corrected design

The prior revision of this file mis-scoped the work in two ways, both corrected
here:

1. It conflated "reads the index" with "needs the legacy parse." **Reading the
   index was always fine** — the index is a byproduct, and cross-run history
   legitimately lives there. What dies is the *second parse*
   (`resolveCorpusReceivers` → `resolveReceiverProvenance`), and the *writes* that
   are today produced by their own parse move onto the phase model.
2. It proposed a **two-pass `buildFacts` that keeps ASTs alive through the
   cross-file fixed point.** That is wrong and it matters: `dispose()` exists
   (Spec 30/31) so every tree dies right after its file is visited — holding them
   corpus-wide is precisely how the large-project OOM happened in stage 1. The
   correct shape lifts the AST-dependent extraction into a **file fact**, and
   makes the four consumers **corpus producers** reading that file fact plus the
   provenance fixed point. Stage position expresses the dependency, exactly as
   Spec 68 does everywhere else.

Governing bar (unchanged): a moved number is attributed to the change that moved
it, or it is an open defect — never a bare re-record, never a silent finding-count
shift.

## 2b — four index-backed producers, corrected

| producer | disposition |
| --- | --- |
| `defined-classes` ← `style-declarations` | **DONE** (re-derived; parity-verified) |
| `call-graph` ← `function-index` | **DERIVABLE** — add the missing `usedImports` field |
| `clone-pair-history` | **read stays; the write moves** (pair computation + history write from the phase `code-block` fact) |
| `unread-style-sources` | **sourced from the traverse phase**, not a visitor/parse |

### `defined-classes` ← `style-declarations` (done, prior revision)

`src/phase/producers.ts` `defined-classes` now derives the catalog from
`style-declarations[].declarations[].context` via the same
`/\.([a-zA-Z0-9_-]+)/g` regex every `style_defined_classes` writer used, grouped
by class name keeping `MIN(file_path)`, sorted by `className` for near-miss tie
parity. Full suite green (2510 tests).

### `call-graph` ← `function-index` — a missing field, not index-only data

The prior "NOT-DERIVABLE" verdict was wrong. `used_imports` is not *intrinsically*
index-only: it is produced by `extractIdentifierUsage`
(`src/utils/dependencyExtractor.ts:261-315`), which is a parse-time walk over the
function's AST — just a *different* parse (the functionScanner sync path) than the
audit's single parse. `function-index` already carries `functionCalls` (the same
shape of parse-time derivation); it simply lacks `usedImports`.

Fix (DONE, verified):

1. Add `usedImports: string[]` to `FunctionIndexFact` (`src/phase/types.ts:256-268`),
   extracted in `src/phase/functionIndex.ts` `extractFunctionIndex` via
   `extractIdentifierUsage(node, sourceCode, importNames)` where `importNames` is
   the set of `getImportsDetailed(root, source).map(imp => imp.localName)` —
   exactly the derivation `functionScanner.ts:160,178-179` does.
2. `buildValidatorIdsFact` (`src/phase/rules/crossDomain.ts:545-594`) reads
   `usedImports` from the fact (array `.includes(pkg)`), not the JSON-string
   `LIKE '%"zod"%'` scan over the index column.
3. The `call-graph` producer now takes `needs: ['function-index']` but **only** to
   source `usedImports` (joined by the `(file, name, line)` identity the index
   `conflictKey` uses). The `functions` catalog and `callEdges` **stay index
   reads** (`functions` + `graph_cache`).

**Why the edges stay index reads (measured, not assumed).** The first cut
re-derived `callEdges` from `functionCalls` by a name join. That turned on the
`multi-table-write` depth-1 expansion during a plain audit, because the sync-only
`graph_cache` is empty there (`resolveCallGraphContext` gates the expansion on
`callEdges.length > 0`). Measured on recall-protocol:
`multi-table-write` **9 → 19 (+10)** — a silent finding-count shift, forbidden by
the release bar. Reverting the edge re-derivation (edges back to the index read)
restores **9**, and `uncovered-risk` / `no-validator-reachable` stay 0 on every
corpus (both are opt-in-gated, absent from the default effective config). The
six-corpus `uncovered-risk` verification is **0 → 0** on all six; the only
rule that reads `callEdges` (`multi-table-write`) is byte-identical to baseline
(9 on recall-protocol, 0 elsewhere).

### `clone-pair-history` — read stays, write moves

Cross-run history cannot come from one run (`diverging-clone` needs
`rows.length >= divergenceRuns + 1`), so the read of `dry_pair_history` stays an
index read. But `createDryVisitor` + `persistDryPairs` do not need their own parse:
the pair computation (`computePairFingerprint`, per-block `hash`/`structuralSkeleton`)
and the history write come from the phase `code-block` fact at the end of the phase
run. Move the write (`persistDryPairs`, `src/auditRunner.ts:1036-1070`) to consume
the phase `code-block` fact; keep `clone-pair-history` reading the index.

### `unread-style-sources` — traverse phase, not a visitor

"Discovered but could not be read" is a property of the corpus *walk*, not of any
parse. Spec 32 already established that an unparsed file is never silent and the
walk records them. Source `unread-style-sources` from the traverse phase's own
unparsed-file record (`.less`/`.styl`/`.sass` discovered but unparsed, plus the
read-failure reasons). No visitor, no parse.

## 2a — corpus producers over a file fact (corrected)

The four consumers `schema-usage`, `query-sites`, `data-access-calls`,
`loop-queries` are today file producers reading `file.receiverProvenance` (a
corpus-level seed) *and* the AST. To collapse the second parse without holding
ASTs alive:

1. **Lift the AST-dependent extraction into a file fact.** During the single pass,
   each file producer extracts from the AST the raw candidates those four consumers
   need *before* any cross-file provenance is applied. The provenance seed is
   **not** part of this extraction — it is applied later, corpus-side.
2. **Make the four consumers corpus producers** reading (a) that file fact and
   (b) the provenance fixed point. No AST outlives its file.
3. **The provenance fixed point is a corpus producer** over three new file facts
   the existing set does not carry (these were correctly identified and remain in
   scope):
   - import specifiers with `isNamespace`/`isDefault`/`alias`/local name
     (`imports`/`file-imports`/`import-form` all drop them),
   - the full export set including star re-exports (`export-form` is incomplete),
   - a Go package-bindings fact for the Go branch (`withinFileProvenance`'s Go arm
     is not purely within-file — it reads sibling `.go` package symbols).
4. **The manifest-staleness diagnostic** (`src/pipeline.ts:973-982`) moves with the
   resolution: it is a single manifest read (not a parse), re-homed wherever the
   phase-side resolution lands, or dropped if it is provably a duplicate of the
   phase-side unparsed-file record.

Delete points for the second parse (unchanged from the prior revision):
`src/pipeline.ts:263, 266-268, 790-794, 382-388, 1110, 973-982`,
`src/auditRunner.ts:897, 903, 958, 1223`, `src/types.ts:391, 397-405, 690`, and
the `PhaseInfra.receiverProvenance` / `ParsedFile.receiverProvenance` fields
(`src/phase/phaseModel.ts:126, 376-379`, `src/phase/types.ts:1477`).

The `unresolved-query` / `cannot-fire` diagnostic (2c) is emitted in
`src/pipelineAdapters.ts:2940-2999` from `context.unresolvedReceiverImports` /
`context.unprovenQueryReceivers`; its pure message-shaping helpers
(`checkUnresolvedReceiverImports` / `checkUnprovenQueryReceivers` /
`dedupeCannotFireByReceiver`, `src/analyzers/universal/schema/codeAnalysis.ts:1408-1506`)
are re-used verbatim, fed by the phase-side resolution corpus fact.

## Disposition

- `defined-classes` — done.
- `call-graph` — done: `usedImports` moves to the `function-index` fact (array);
  `functions`/`callEdges` stay index reads (re-deriving the edges moves
  `multi-table-write` 9→19, measured and rejected). `uncovered-risk` 0→0 on all
  six corpora.
- `clone-pair-history` — done: the write moves to `seedDryPairs` over the phase
  `code-block` fact, fired from a new `PhaseInfra.afterFileFacts` hook so the
  `dry_pair_history` write lands before `clone-pair-history` reads it; the read
  stays the index read. `createDryVisitor`/`DryVisitorBundle`/`persistDryPairs`
  (visitor-shaped) deleted from `pipelineAdapters.ts`/`auditRunner.ts`. Parity
  pinned by `spec70-dry-pair-seed-parity.spec.ts` (legacy bare-token-set Jaccard,
  legacy `checkStructuralSimilarity` gate, per-file seed). Six-corpus dry counts
  byte-identical to `specs/corpus-baselines.md` (`duplicate-string-literal`,
  `duplicate-import`, `dry/structural-similarity`, `dry/similar-expression`,
  `dry/duplicate`); `dry/diverging-clone` stays 0 everywhere on a fresh run.
- `unread-style-sources` — source from the traverse phase's unparsed-file record.
- 2a/2c/2d — corpus producers over a file fact (no live-AST two-pass); new
  specifier/export/Go-bindings file facts; delete the second parse.
