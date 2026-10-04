/**
 * Spec 70 Item 4 (step 3) — the per-file `loop-query-candidates` producer.
 *
 * The extract half of the corpus `loop-queries` reduction. The legacy
 * `loop-queries` producer did two jobs: find every in-loop DB call (via
 * `collectLoopQueryCandidates`) and fold the provenance-dependent half — the
 * strict-handle filter (`isDbCallNode`'s `identifyHandle`), the per-loop dedup,
 * and the stable symbol — over the cross-file `dbProvenanced` seed. The collapse
 * splits them: this producer runs only the provenance-free half — the broadened
 * discovery and every provenance-free discriminator (statement-construction,
 * for-of-iterable, hoisted-reuse, batch-argument, LLM/queue suppression) — while
 * the AST lives, projecting the handle identity so the corpus producer re-folds
 * the strict-handle filter once the `receiver-provenance` fixed point supplies the
 * seed. No dedup and no symbol happen here: both depend on the re-folded handle
 * set. The producer runs on the empty-provenance scan (the analyzer's
 * `buildCandidateScan`).
 */

import type { AstFile, LoopQueryRawCandidate } from './types.js';
import { extractLoopQueryRawCandidates as extractAnalyzerCandidates } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';

/** Extract one file's raw, provenance-free loop-query candidates.
 *
 *  @param file the parsed file to project loop-query candidates from
 *  @returns the file's `LoopQueryRawCandidate[]` (no raw-side dedup or symbol —
 *    the corpus producer re-folds both after re-folding the handle verdict)
 */
export function extractLoopQueryRawCandidates(file: AstFile): LoopQueryRawCandidate[] {
  return extractAnalyzerCandidates(file.ast, file.adapter, file.source);
}
