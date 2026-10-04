/**
 * Spec 70 Item 4 (step 3) — the per-file `data-access-calls-candidates` producer.
 *
 * The extract half of the corpus `data-access-calls` reduction. The legacy
 * `data-access-calls` producer did two jobs: extract the resolved DB calls and
 * fold the provenance-dependent half of `buildDatabaseCall` (the `identifyHandle`
 * admission verdict → the injection-risk gate, and the per-site dialect → the SQL
 * parse) over the cross-file `dbProvenanced` seed. The collapse splits them: this
 * producer runs only the provenance-free half — the text-derived shape, the static
 * security arms 1–3, the organization filter, the enclosing identity, the resolved
 * WHERE — while the AST lives, projecting the two provenance-dependent inputs as
 * identities (`handle*` and `site*`), so the corpus producer re-folds them once the
 * `receiver-provenance` fixed point supplies the seed. The producer runs on the
 * empty-provenance scan (the analyzer's `buildCandidateScan`), so no cross-file
 * seed is read here; config is the §10 tuning surface, omitted → defaults.
 */

import type { AstFile, DataAccessCallCandidate } from './types.js';
import { extractDataAccessCallCandidates as extractAnalyzerCandidates } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';

/** Extract one file's raw, provenance-free data-access-call candidates.
 *
 *  @param file the parsed file to project data-access-call candidates from
 *  @returns the file's `DataAccessCallCandidate[]` (no raw-side dedup — the corpus
 *    producer dedups after re-folding admission)
 */
export function extractDataAccessCallCandidates(file: AstFile): DataAccessCallCandidate[] {
  return extractAnalyzerCandidates(file.ast, file.adapter, file.source);
}
