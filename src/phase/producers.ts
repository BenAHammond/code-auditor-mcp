/**
 * Spec 68 §3.1 — one producer per fact kind, enforced by a mapped type.
 *
 * `ProducerMap` is a mapped type over {@link FactKind}: exhaustive by
 * construction. A fact kind with no entry fails the type (residue check #1 in
 * checks.ts); a second producer for one kind is a duplicate object key
 * (single-producer check). There is no list to be omitted from — which is the
 * defect class Spec 68 §0, row 2 exists to remove.
 *
 * Only kinds with a producer that returns *real* data appear here. A planned
 * kind without a working producer is absent from {@link FactShapes} and from
 * this map by construction; the migration map (spec68-rule-migration-map.md)
 * holds the plan, the type holds only what runs. Residue check #2 is satisfied
 * by reality — every kind below is actually read by a rule or a corpus
 * processor — not by a placeholder.
 */

import type {
  FactKind,
  FileProcessor,
  CorpusProcessor,
  Producer,
  ParsedFile,
  FactFragment,
  TableCatalog,
} from './types.js';
import { extractFileSymbols } from './fileSymbols.js';
import { extractFunctionIndex } from './functionIndex.js';
import { extractStylesCss } from './stylesCss.js';
import { extractDataAccessCalls } from './dataAccessCalls.js';
import { extractSchemaUsage } from './schemaUsage.js';
import { extractSchemaCode } from './schemaCode.js';
import { extractCrossLanguageEntities } from '../pipelineAdapters.js';
import { getLanguageFromPath } from '../utils/fileDiscovery.js';

/** Exhaustive map over every fact kind. `satisfies` is the single-producer check. */
export type ProducerMap = { readonly [K in FactKind]: Producer<K> };

/**
 * The fact kinds a producer currently serves. Derived from the actual keys of
 * {@link PRODUCERS}, not re-declared — add a producer and this widens with it.
 */
export type ProducedFactKind = keyof typeof PRODUCERS;

export const PRODUCERS = {
  // ── Per-file producers — the extraction visitors re-registered as processors ──
  // `file-symbols` is the §3.2 vertical slice: per-file function/class/interface
  // symbols with pre-computed metrics, so the SOLID rules read plain data.
  'file-symbols': {
    id: 'file-symbols',
    produces: 'file-symbols',
    formats: ['typescript', 'tsx', 'javascript'],
    process(file: ParsedFile): FactFragment<'file-symbols'> {
      return extractFileSymbols(file);
    },
  } satisfies FileProcessor<'file-symbols'>,
  'function-index': {
    id: 'function-index',
    produces: 'function-index',
    formats: ['typescript', 'tsx', 'javascript'],
    process(file: ParsedFile): FactFragment<'function-index'> {
      return extractFunctionIndex(file);
    },
  } satisfies FileProcessor<'function-index'>,
  // `ddl-declarations` was `schema-code`: DDL declarations parsed from code.
  'ddl-declarations': {
    id: 'ddl-declarations',
    produces: 'ddl-declarations',
    formats: ['typescript', 'tsx', 'javascript'],
    process(file: ParsedFile): FactFragment<'ddl-declarations'> {
      return extractSchemaCode(file);
    },
  } satisfies FileProcessor<'ddl-declarations'>,
  'schema-usage': {
    id: 'schema-usage',
    produces: 'schema-usage',
    formats: ['typescript', 'tsx', 'javascript'],
    process(file: ParsedFile): FactFragment<'schema-usage'> {
      return extractSchemaUsage(file);
    },
  } satisfies FileProcessor<'schema-usage'>,
  // `style-declarations` was `styles-css` (named for the declaration, not the format).
  'style-declarations': {
    id: 'style-declarations',
    produces: 'style-declarations',
    formats: ['css', 'scss'],
    process(file: ParsedFile): FactFragment<'style-declarations'> {
      return [extractStylesCss(file)];
    },
  } satisfies FileProcessor<'style-declarations'>,
  'cross-language-entities': {
    id: 'cross-language-entities',
    produces: 'cross-language-entities',
    formats: ['typescript', 'tsx', 'javascript', 'go'],
    process(file: ParsedFile): FactFragment<'cross-language-entities'> {
      return extractCrossLanguageEntities(
        file.ast,
        file.file,
        file.source,
        getLanguageFromPath(file.file),
      );
    },
  } satisfies FileProcessor<'cross-language-entities'>,
  'data-access-calls': {
    id: 'data-access-calls',
    produces: 'data-access-calls',
    formats: ['typescript', 'tsx', 'javascript'],
    process(file: ParsedFile): FactFragment<'data-access-calls'> {
      return extractDataAccessCalls(file);
    },
  } satisfies FileProcessor<'data-access-calls'>,

  // ── Corpus processors producing derived facts ─────────────────────────────
  // `table-catalog` reduces the DDL declarations into the flat known-table set
  // the `missing-org-filter` and `unknown-table` rules read. `needs` forms the
  // DAG edge ddl-declarations → table-catalog.
  'table-catalog': {
    id: 'table-catalog',
    produces: 'table-catalog',
    needs: ['ddl-declarations'],
    process(facts): TableCatalog {
      const tables: { name: string; source: string }[] = [];
      const seen = new Set<string>();
      for (const schema of facts['ddl-declarations']) {
        if (!schema.name || seen.has(schema.name)) continue;
        seen.add(schema.name);
        tables.push({ name: schema.name, source: schema.file });
      }
      return { tables };
    },
  } satisfies CorpusProcessor<'table-catalog', readonly ['ddl-declarations']>,
} satisfies ProducerMap;

/**
 * The fact-kind vocabulary as a runtime value, kept in lockstep with
 * {@link FactShapes} by the `satisfies` check: a kind added to FactShapes but
 * missing here — or present here but absent from FactShapes — fails to compile.
 * The producer-liveness test derives its expected producer count from this
 * instead of a hand-maintained literal, so the number can only change in the
 * same edit that changes the vocabulary.
 */
export const FACT_KINDS = {
  'file-symbols': true,
  'function-index': true,
  'ddl-declarations': true,
  'schema-usage': true,
  'style-declarations': true,
  'cross-language-entities': true,
  'data-access-calls': true,
  'table-catalog': true,
} satisfies Record<FactKind, true>;
