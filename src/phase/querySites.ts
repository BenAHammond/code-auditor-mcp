/**
 * Spec 69 R2 — the per-file `query-sites` producer.
 *
 * Replaces the `function-bodies` producer: instead of projecting each function's
 * raw source text (which made `too-many-queries` re-run `countQueries` over text
 * and therefore double-count a nested closure's sites — a closure's text is
 * inside its parent's text), it projects the *located* query sites themselves.
 * Every DB-query site is extracted once from the raw source (`extractQuerySiteOffsets`)
 * and attributed to its innermost enclosing function, so a function's query count
 * is the number of sites whose enclosing function is that function — a relation,
 * which cannot double-count by construction.
 *
 * The site set is the same three-component scan `countQueries` performs (eager
 * execution-method calls, `.exec`-with-SQL, standalone SQL keywords over
 * call-body-stripped text), so `countQueries(funcText)` over a whole file equals
 * `extractQuerySiteOffsets(file.source).length` — the parity the old rule relied
 * on, now carried as locations instead of a per-function count.
 *
 * The producer never decides "is this a finding"; it locates sites and attributes
 * them. The rule groups by the enclosing-function coordinate and counts.
 */

import type { AstFile, QuerySiteFact } from './types.js';
import {
  extractQuerySiteOffsets,
  offsetToLocation,
} from '../analyzers/universal/schema/codeAnalysis.js';
import { passesFileGate } from '../analyzers/universal/schema/discovery.js';
import { buildProvenanceContext } from '../analyzers/provenance.js';
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
 * One file's located DB-query sites as `QuerySiteFact[]`.
 *
 * @param file - The parsed file whose query sites are located.
 * @returns Each query site with its innermost enclosing-function identity.
 */
export function extractQuerySites(file: AstFile): QuerySiteFact[] {
  // The legacy `too-many-queries` detector ran inside the schema-code visitor,
  // which short-circuited on `passesFileGate` (a file with no DB context never
  // reached `checkQueryPatterns`). Mirror that gate here so the fact only carries
  // sites from DB-context files — otherwise the rule over-fires on non-DB modules.
  const provenanceContext = buildProvenanceContext(file.ast, file.adapter, file.source, {
    mode: 'hybrid',
    dbReceiverNames: DEFAULT_SCHEMA_CONFIG.dbReceiverNames,
    dbBindingNames: DEFAULT_SCHEMA_CONFIG.dbBindingNames,
    dbCallMethods: DEFAULT_SCHEMA_CONFIG.dbCallMethods,
    dbWrapperNames: DEFAULT_SCHEMA_CONFIG.dbWrapperNames,
  });
  if (!passesFileGate(file.file, file.source, DEFAULT_SCHEMA_CONFIG, provenanceContext)) {
    return [];
  }

  const functions = file.adapter.extractFunctions(file.ast);

  const out: QuerySiteFact[] = [];
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
    out.push({
      file: file.file,
      line: loc.line,
      column: loc.column,
      method: site.method,
      functionLine: enclosing?.start.line ?? null,
      functionColumn: enclosing?.start.column ?? null,
      functionName: enclosing?.name ?? null,
    });
  }
  return out;
}
