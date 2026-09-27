/**
 * Spec 68 §3.2 — the per-file `dynamic-sql` producer.
 *
 * Re-homes the "find dangerous query/execute string-argument call sites" half of
 * `checkSQLInjection` (in `codeAnalysis.ts`, the Spec-34 helper the legacy
 * `UniversalSchemaAnalyzer` calls) as a pure per-file processor. The analyzer did
 * two jobs: collect the dynamic-SQL candidates and derive violations from them.
 * The producer keeps only the collection — the candidates the
 * `dynamic-sql-construction` rule reads.
 *
 * `DynamicSqlCandidate` is structurally identical to the `DynamicSqlFact` fact,
 * so the mapping is the identity — this module owns only the `AstFile` → fact
 * unwrapping, and the fact shape is pinned in `phase/types.ts`.
 */

import type { AstFile, DynamicSqlFact } from './types.js';
import { collectDynamicSqlCandidates } from '../analyzers/universal/schema/codeAnalysis.js';

/** Extract the per-file dynamic-SQL construction candidates from one parsed file. */
export function extractDynamicSql(file: AstFile): DynamicSqlFact[] {
  return collectDynamicSqlCandidates(file.ast, file.adapter, file.source);
}
