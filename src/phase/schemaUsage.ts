/**
 * Spec 68 §3.2 — the `schema-usage` FileProcessor extraction.
 *
 * Re-homes the "record table references" half of `UniversalSchemaAnalyzer` as a
 * pure per-file processor. The analyzer's `recordTableUsage` walked each
 * extracted `TableReference` up the AST to the enclosing function and pushed a
 * `SchemaUsage` row for the lifecycle rules. That is the whole of this producer:
 * `findTableReferences` extracts the references, then each one is re-homed to a
 * `SchemaUsageFact` with the same coordinate/identity fields the cross-domain
 * lifecycle rules (written-never-read, read-never-written, transaction-boundary
 * risk) read. No config, no DB — `findTableReferences` runs on
 * {@link DEFAULT_SCHEMA_CONFIG} because its config knobs (`sqlTagNames`,
 * `dbCallMethods`, `dbReceiverNames`) all have `?? default` fallbacks, and
 * config is the §10 tuning surface not available to a `process(file)` call.
 *
 * The `< 3`-character short-table guard in `parseSqlTables` takes an optional
 * `allTables` catalog to let a known 1–2-char table name through; the producer
 * runs before the catalog exists, so it passes `undefined` and conservatively
 * skips short bare identifiers — the same default the standalone analyze path
 * takes when no schemas are configured.
 */

import type { ParsedFile, SchemaUsageFact } from './types.js';
import {
  findTableReferences,
  findClosestNodeAt,
  findEnclosingFunctionIdentity,
} from '../analyzers/universal/schema/codeAnalysis.js';
import { DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/schema/config.js';

/** Extract the per-file table usages from one parsed file. */
export function extractSchemaUsage(file: ParsedFile): SchemaUsageFact[] {
  const { references } = findTableReferences(file.ast, file.adapter, file.source, {
    config: DEFAULT_SCHEMA_CONFIG,
  });

  const usages: SchemaUsageFact[] = [];
  for (const ref of references) {
    // Re-home `recordTableUsage`'s identity walk: coordinate + nullable name.
    const node = findClosestNodeAt(file.ast.root, ref.location, file.adapter);
    const identity = node ? findEnclosingFunctionIdentity(node, file.adapter, file.file) : null;
    const functionName =
      identity == null
        ? file.file.endsWith('.sql') || file.file.includes('/migrations/')
          ? 'schema-file'
          : 'top-level'
        : identity.topLevel
          ? 'top-level'
          : identity.name;

    usages.push({
      tableName: ref.table,
      filePath: file.file,
      functionName,
      functionStartLine: identity?.startLine ?? null,
      functionStartColumn: identity?.startColumn ?? null,
      usageType: ref.type,
      line: ref.location.line,
      column: ref.location.column,
      rawQuery: ref.context,
      origin: ref.origin,
    });
  }
  return usages;
}
