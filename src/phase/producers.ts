/**
 * Spec 68 §3.1 — one producer per fact kind, enforced by a mapped type.
 *
 * `ProducerMap` is a mapped type over {@link FactKind}: exhaustive by
 * construction. A fact kind with no entry fails the type (residue check #1 in
 * checks.ts); a second producer for one kind is a duplicate object key
 * (single-producer check). There is no list to be omitted from — which is the
 * defect class Spec 68 §0, row 2 exists to remove.
 *
 * The entries below are the *registration* of every fact kind's producer, with
 * the id / produces / formats (or upstream `needs`) that §5's DAG and §8's
 * coverage are derived from. Their `process` bodies are wired in §3.2 (the six
 * extraction visitors) and §9 (the Go binary); until then each throws — the
 * registry is the schedule, the body is the implementation, and the two are
 * deliberately separate so a producer can be *declared* (and thus fail the
 * residue check if absent) before its extraction is migrated.
 */

import type {
  FactKind,
  FileProcessor,
  CorpusProcessor,
  Producer,
  ParsedFile,
  FactFragment,
  Format,
  TableCatalog,
} from './types.js';
import { extractFileSymbols } from './fileSymbols.js';
import { extractFunctionIndex } from './functionIndex.js';
import { extractStylesCss } from './stylesCss.js';
import { extractDataAccessCalls } from './dataAccessCalls.js';
import { extractCrossLanguageEntities } from '../pipelineAdapters.js';
import { getLanguageFromPath } from '../utils/fileDiscovery.js';

/** Exhaustive map over every fact kind. `satisfies` is the single-producer check. */
export type ProducerMap = { readonly [K in FactKind]: Producer<K> };

/**
 * The fact kinds a producer currently serves. Derived from the actual keys of
 * {@link PRODUCERS}, not re-declared — add a producer and this widens with it.
 */
export type ProducedFactKind = keyof typeof PRODUCERS;

/** A per-file producer whose extraction body is migrated in §3.2 / §9. */
function fileProducer<K extends FactKind>(
  id: string,
  produces: K,
  formats: readonly Format[],
): FileProcessor<K> {
  return {
    id,
    produces,
    formats,
    process(_file: ParsedFile): FactFragment<K> {
      throw new Error(`spec68 §3.2: producer "${id}" is declared but not yet migrated`);
    },
  };
}

export const PRODUCERS = {
  // ── §3.2: the six extraction visitors, re-registered as FileProcessors ────
  // `file-symbols` is the §3.2 vertical slice: the first producer whose body is
  // migrated (see fileSymbols.ts). It extracts per-file function/class/interface
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
  'schema-json': fileProducer('schema-json', 'schema-json', ['typescript', 'tsx', 'javascript']),
  'schema-code': fileProducer('schema-code', 'schema-code', ['typescript', 'tsx', 'javascript']),
  'schema-usage': fileProducer('schema-usage', 'schema-usage', ['typescript', 'tsx', 'javascript']),
  'styles-css': {
    id: 'styles-css',
    produces: 'styles-css',
    formats: ['css', 'scss'],
    process(file: ParsedFile): FactFragment<'styles-css'> {
      return [extractStylesCss(file)];
    },
  } satisfies FileProcessor<'styles-css'>,
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

  // ── §3.2: corpus processors producing derived facts ───────────────────────
  // `table-catalog` reduces the schema facts (declared in code DDL and in JSON
  // schema config) into the flat known-table set the `missing-org-filter` and
  // `unknown-table` rules read. It is a pure reduction over complete upstream
  // facts — the §5 case that proves the corpus-processor path: `needs` forms the
  // DAG edge schema-json/schema-code → table-catalog.
  'table-catalog': {
    id: 'table-catalog',
    produces: 'table-catalog',
    needs: ['schema-json', 'schema-code'],
    process(facts): TableCatalog {
      const tables: { name: string; source: string }[] = [];
      const seen = new Set<string>();
      for (const schema of [...facts['schema-json'], ...facts['schema-code']]) {
        if (!schema.name || seen.has(schema.name)) continue;
        seen.add(schema.name);
        tables.push({ name: schema.name, source: schema.file });
      }
      return { tables };
    },
  } satisfies CorpusProcessor<'table-catalog', readonly ['schema-json', 'schema-code']>,

  // ── §9: the Go binary as an external-process FileProcessor ────────────────
  'go-imports': fileProducer('go-imports', 'go-imports', ['go']),
  'go-error-bindings': fileProducer('go-error-bindings', 'go-error-bindings', ['go']),
  'go-goroutines': fileProducer('go-goroutines', 'go-goroutines', ['go']),
  'go-channels': fileProducer('go-channels', 'go-channels', ['go']),
} satisfies ProducerMap;
