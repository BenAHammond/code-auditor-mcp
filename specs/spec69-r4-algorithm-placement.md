# Spec 69 R4 — where the five algorithms compute today

R4 asks: for each of five named algorithms, does it compute **inside a rule
body** or **inside a processor**? Anything in a rule body moves to a processor
that produces the computed fact; the rule becomes a read of it. This report
records the placement list before anything moves.

The phase model's seam is concrete: a `FileProcessor.process(file)` produces a
fact from an AST and receives **no config**; a `CorpusProcessor.process(facts,
ctx)` reduces facts and receives **no config**; a rule's `analyze(ctx)` is the
only place that receives `thresholds` (config). So a computation whose knob is a
config key is, by construction, the rule's decision — not a processor's.

## The list

| # | algorithm | computes in | location | action |
|---|---|---|---|---|
| 1 | `dry/structural-similarity` skeleton hashing | **processor** | `codeBlocks.ts` `normalizeStructure` (38) + `normalizeCodeForStructure` (91), stored as `structuralSkeleton` in `createCodeBlock` (165) | none |
| 2 | `dry/structural-similarity` "clustering" | rule body | `dry.ts` `computeJaccardSimilarity` (300) + `detectStructuralDuplicates` (507) | **stays** — it is pairwise comparison at the `similarityThreshold` config, i.e. the rule's decision, not a computed fact |
| 3 | `dry/duplicate` block hashing | **processor** | `codeBlocks.ts` `hashCode` (97), stored as `hash` in `createCodeBlock` (173) | none |
| 4 | `value-drift` CIELAB conversion | **rule body** | `styles.ts` `parseColorToRGB` (241), `rgbToLab` (214), `deltaE` (288) | **move** |
| 5 | `value-drift` single-linkage clustering | rule body | `styles.ts` `clusterDistinctColors` (340) | **stays** — threshold is `colorDeltaE` (config), so clustering is the rule's decision |
| 6 | `dependency-graph` betweenness kernel | library | `graph/callGraph.ts` `computeBetweenness` (322) + `brandesExact`/`brandesSampled`/`accumulateBrandes`; consumed by the `rank` CLI and the code map, not by any rule | none |
| 7 | `method-complexity` node-type walk | **processor/adapter** | `adapterBridge.ts` `calculateComplexity` (427) + `adapter.getComplexity` (TS `TreeSitterTypeScriptAdapter.ts:1038`, Go `GoAdapter.ts:675`), consumed by processors `fileSymbols.ts` (134), `functionIndex.ts` (74), `goFunctions.ts` (58) | none |

## What the list says

Five of the seven entries were already in the right place before R4: the two DRY
hashes live in the `code-block` producer (`codeBlocks.ts`), the betweenness
kernel lives in the graph library and is never called by a rule, and the
cyclomatic-complexity walk lives in the language adapters behind the
`file-symbols`/`function-index`/`go-functions` processors.

One entry computes in a rule body: **`value-drift`'s CIELAB conversion**. The
rule (`styles/value-drift`) parses raw color strings to sRGB and converts them
to CIELAB Lab in its own body, then clusters. That conversion is a pure,
threshold-independent derivation from the raw declaration value — exactly the
"one level up from raw source text" computation a processor should own.

Two entries are named in the spec but are correctly left in the rule:

- **`dry/structural-similarity` "clustering"** is not a clustering kernel at
  all — it is pairwise Jaccard over the pre-computed skeletons, gated by
  `similarityThreshold`. That is the rule's decision (which pairs are similar
  enough to flag), not a computed fact. The skeleton it compares — the computed
  fact — is already in the producer.
- **`value-drift` single-linkage clustering** is the union-find pass at
  `cfg.colorDeltaE`. Its threshold is a config key, and config reaches only the
  rule. Moving clustering to a processor would either hardcode the threshold
  (breaking the `colorDeltaE` knob) or leak config into a processor (breaking
  the seam). Once the CIELAB conversion moves out, the rule clusters over
  processor-provided Lab values — the processor computes, the rule decides.

## The move (done)

`value-drift`'s CIELAB conversion moved from `styles.ts` into
`src/phase/colorMath.ts` (`parseColorToRGB`, `rgbToLab`, `labDistance` — the
`deltaE` name the list recorded is now `labDistance`), and a `color-values`
corpus producer (`producers.ts`, `needs: ['style-declarations']`) pre-computes
the per-declaration Lab triples. The rule reads `color-values` via
`ctx.facts['color-values']`, imports only `labDistance`, and keeps the
clustering + canonical selection + flagging at its own `colorDeltaE` config.

This mirrors how the DRY hash/skeleton was already placed: the producer
computes the derived value with default normalization and no threshold; the rule
applies the config-parameterized decision.
