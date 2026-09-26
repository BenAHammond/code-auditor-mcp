/**
 * Spec 68 §3.2 — the `data-access-calls` FileProcessor extraction.
 *
 * Re-homes the "extract resolved calls" half of `UniversalDataAccessAnalyzer`
 * as a pure per-file processor. The analyzer's `analyzeWithFacts` did two jobs:
 * extract `DatabaseCall[]` and derive violations from them. The producer keeps
 * only the extraction — the calls the missing-org-filter / unfiltered-query /
 * sql-injection-risk rules read. The analyzer's `extractDataAccessCalls` export
 * is the synchronous extraction (its body was never actually awaited), run on
 * {@link DEFAULT_DATA_ACCESS_CONFIG} since config is the §10 tuning surface and
 * is not available to a `process(file)` call.
 *
 * `DatabaseCall` is structurally identical to the `ResolvedQuery` fact, so the
 * mapping is the identity — this module owns only the `ParsedFile` → fact
 * unwrapping, and the fact shape is pinned in `phase/types.ts`.
 */

import type { ParsedFile, ResolvedQuery } from './types.js';
import { extractDataAccessCalls as extractAnalyzerCalls } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';

/** Extract the per-file resolved DB calls from one parsed file. */
export function extractDataAccessCalls(file: ParsedFile): ResolvedQuery[] {
  return extractAnalyzerCalls(file.ast, file.adapter, file.source);
}
