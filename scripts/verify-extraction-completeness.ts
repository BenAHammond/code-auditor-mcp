#!/usr/bin/env node
/**
 * verify-extraction-completeness.ts — the I/O half of the
 * `verify:extraction-completeness` gate.
 *
 * The data-access pipeline projects a broadened candidate set
 * (`extractDataAccessCallCandidates`) and admits a subset into real
 * `DatabaseCall`s (`extractDataAccessCalls`). The gate's invariant is that every
 * candidate the extractor did not admit carries a *reason* — a three-way
 * disposition (extracted / declined-as-non-builder / unaccounted). This half
 * parses a synthetic fixture carrying a query-builder call, runs both extractors,
 * matches each candidate to its admitted call by `line:column`, and feeds the
 * resulting dispositions to `checkExtractionCompleteness` (the pure predicate in
 * the `.core.mjs` half). Exit 1 iff a query-builder-shaped candidate was declined.
 */
import { initializeLanguages, initParsers, LanguageRegistry } from '../src/languages/index.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import {
  extractDataAccessCalls,
  extractDataAccessCallCandidates,
} from '../src/analyzers/universal/UniversalDataAccessAnalyzer.js';
import { checkExtractionCompleteness } from './verify-extraction-completeness-core.mjs';

const FIXTURE_PATH = '/tmp/ca-extraction-completeness.ts';
/** A query-builder chain (`select` → `from` companion) — shape-admitted, so it is
 *  both a candidate and an extracted DatabaseCall. */
const FIXTURE = `import { db } from './db';

export async function listUsers(id: number) {
  return db.select('*').from('users').where('id', id);
}
`;

async function main(): Promise<void> {
  initializeLanguages();
  await initParsers();

  const adapter = LanguageRegistry.getInstance().getAdapterForFile(FIXTURE_PATH);
  if (!adapter) throw new Error('no adapter for fixture path');
  const ast = parseFile(FIXTURE_PATH, FIXTURE);
  if (!ast) throw new Error('fixture failed to parse');
  try {
    const candidates = extractDataAccessCallCandidates(ast, adapter, FIXTURE);
    const extracted = extractDataAccessCalls(ast, adapter, FIXTURE);

    // Liveness: a fixture with a query-builder call must discover candidates. A
    // zero-candidate run would be a discovery miss, not a pass.
    if (candidates.length === 0) {
      console.error('extraction-completeness: no data-access candidates discovered from a query-builder fixture');
      process.exit(1);
    }

    const dispositions = candidates.map((c) => ({
      site: `${FIXTURE_PATH}:${c.line}:${c.column}`,
      extracted: extracted.some((dc) => dc.line === c.line && dc.column === c.column),
      queryBuilderShape: c.isQueryBuilderShape,
    }));

    const drift = checkExtractionCompleteness({ candidates: dispositions });
    for (const line of drift) console.error(`extraction-completeness violated: ${line}`);
    if (drift.length > 0) process.exit(1);
    console.log(
      `extraction-completeness holds: ${candidates.length} candidate(s), ${extracted.length} extracted.`,
    );
  } finally {
    ast.dispose?.();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
