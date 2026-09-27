/**
 * Spec 68 §3.2 — the per-file `loop-queries` producer.
 *
 * Re-homes the "find loops whose body issues a DB call" half of
 * `UniversalDataAccessAnalyzer.checkLoopQueries` as a pure per-file processor.
 * The analyzer did two jobs: collect the loop→query candidates and derive
 * violations from them. The producer keeps only the collection — the candidates
 * the `loop-query` rule reads. The analyzer's `extractLoopQueries` export is the
 * synchronous extraction, run on {@link DEFAULT_DATA_ACCESS_CONFIG} (config is
 * the §10 tuning surface and is not available to a `process(file)` call).
 *
 * `LoopQueryCandidate` is structurally identical to the `LoopQueryFact` fact, so
 * the mapping is the identity — this module owns only the `AstFile` → fact
 * unwrapping, and the fact shape is pinned in `phase/types.ts`.
 */

import type { AstFile, LoopQueryFact } from './types.js';
import { extractLoopQueries as extractAnalyzerLoopQueries } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';

/** Extract the per-file loop-query candidates from one parsed file. */
export function extractLoopQueries(file: AstFile): LoopQueryFact[] {
  return extractAnalyzerLoopQueries(file.ast, file.adapter, file.source);
}
