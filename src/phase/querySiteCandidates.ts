/**
 * Spec 70 Item 4 (step 3) — the per-file `query-site-candidates` producer.
 *
 * The extract half of the corpus `query-sites` reduction. The legacy
 * `query-sites` producer did two jobs: locate each DB-query site (a provenance-free
 * text + function scan) and gate the file on DB context (`passesFileGate`, which
 * needs the cross-file `dbProvenanced` seed). The collapse splits them: this
 * producer runs only the location job — extracting every site and attributing it
 * to its innermost enclosing function — *un-gated*, while the corpus producer
 * re-applies the gate once the `receiver-provenance` fixed point supplies the seed.
 *
 * `hasSqlTag` is the one gate input the corpus producer cannot re-derive (it scans
 * source text), so it is projected here alongside the sites. `dbActivity` travels
 * in `receiver-activity`; `dbProvenanced` is re-derived corpus-side by
 * `classifyBuildProvenance`. The producer emits one fragment per TS-family file
 * (null-or-value) so the corpus producer sees every file, not just the ones with
 * sites.
 */

import type { AstFile, QuerySiteCandidatesFact, QuerySiteFact } from './types.js';
import {
  extractQuerySiteOffsets,
  offsetToLocation,
} from '../analyzers/universal/schema/codeAnalysis.js';
import { hasSqlTag } from '../analyzers/universal/schema/discovery.js';
import { DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/schema/config.js';

/** True when `loc` falls inside the span [start, end]. All are 1-based
 *  line/column (the adapter's convention). */
function contains(
  start: { line: number; column: number },
  end: { line: number; column: number },
  loc: { line: number; column: number },
): boolean {
  const afterStart =
    start.line < loc.line || (start.line === loc.line && start.column <= loc.column);
  const beforeEnd = end.line > loc.line || (end.line === loc.line && end.column >= loc.column);
  return afterStart && beforeEnd;
}

/** True when `a` starts at or after `b` — the "innermost wins" tiebreak: among
 *  the functions containing a site, the one with the latest start is the deepest
 *  (a nested closure's start is inside its parent's span, hence later). */
function startsAtOrAfter(
  a: { line: number; column: number },
  b: { line: number; column: number },
): boolean {
  return a.line > b.line || (a.line === b.line && a.column >= b.column);
}

/**
 * One file's un-gated located DB-query sites plus its sql-tag gate signal.
 *
 * @param file - The parsed file whose query sites are located.
 * @returns A one-element array carrying the sites and `hasSqlTag`.
 */
export function extractQuerySiteCandidates(file: AstFile): QuerySiteCandidatesFact[] {
  const functions = file.adapter.extractFunctions(file.ast);

  const sites: QuerySiteFact[] = [];
  for (const site of extractQuerySiteOffsets(file.source)) {
    const loc = offsetToLocation(file.source, site.offset, { line: 1, column: 1 });
    // Innermost enclosing function: the containing function with the latest start.
    let enclosing: { name: string; start: { line: number; column: number } } | null = null;
    for (const fn of functions) {
      if (
        contains(fn.location.start, fn.location.end, loc) &&
        (enclosing === null || startsAtOrAfter(fn.location.start, enclosing.start))
      ) {
        enclosing = { name: fn.name, start: fn.location.start };
      }
    }
    sites.push({
      file: file.file,
      line: loc.line,
      column: loc.column,
      method: site.method,
      functionLine: enclosing?.start.line ?? null,
      functionColumn: enclosing?.start.column ?? null,
      functionName: enclosing?.name ?? null,
    });
  }

  return [{ file: file.file, sites, hasSqlTag: hasSqlTag(file.source, DEFAULT_SCHEMA_CONFIG) }];
}
