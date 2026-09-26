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
  FactShapes,
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

/** A corpus producer whose reduction body is migrated in §3.2 / §9. */
function corpusProducer<K extends FactKind, N extends readonly FactKind[]>(
  id: string,
  produces: K,
  needs: N,
): CorpusProcessor<K, N> {
  return {
    id,
    produces,
    needs,
    process(_facts: { readonly [J in N[number]]: FactShapes[J] }): FactShapes[K] {
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
  // `declared-schemas` was `schema-json`: the JSON schema declarations the
  // table-catalog reduces (Spec 68 §2 — named for what it is, not its format).
  'declared-schemas': fileProducer('declared-schemas', 'declared-schemas', ['json']),
  // `ddl-declarations` was `schema-code`: DDL declarations parsed from code.
  'ddl-declarations': {
    id: 'ddl-declarations',
    produces: 'ddl-declarations',
    formats: ['typescript', 'tsx', 'javascript'],
    process(file: ParsedFile): FactFragment<'ddl-declarations'> {
      return extractSchemaCode(file);
    },
  } satisfies FileProcessor<'ddl-declarations'>,
  // `schema-validations` is the *second* half of the old `schema-json`: the
  // schema ↔ data validation pairs the 17 schema rules read (one kind, one shape).
  'schema-validations': fileProducer('schema-validations', 'schema-validations', ['json']),
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

  // ── §3.2: corpus processors producing derived facts ───────────────────────
  // `table-catalog` reduces the schema facts (declared in code DDL and in JSON
  // schema config) into the flat known-table set the `missing-org-filter` and
  // `unknown-table` rules read. It is a pure reduction over complete upstream
  // facts — the §5 case that proves the corpus-processor path: `needs` forms the
  // DAG edge declared-schemas/ddl-declarations → table-catalog.
  'table-catalog': {
    id: 'table-catalog',
    produces: 'table-catalog',
    needs: ['declared-schemas', 'ddl-declarations'],
    process(facts): TableCatalog {
      const tables: { name: string; source: string }[] = [];
      const seen = new Set<string>();
      for (const schema of [...facts['declared-schemas'], ...facts['ddl-declarations']]) {
        if (!schema.name || seen.has(schema.name)) continue;
        seen.add(schema.name);
        tables.push({ name: schema.name, source: schema.file });
      }
      return { tables };
    },
  } satisfies CorpusProcessor<'table-catalog', readonly ['declared-schemas', 'ddl-declarations']>,

  // ── §9: the Go binary as an external-process FileProcessor ────────────────
  'go-imports': fileProducer('go-imports', 'go-imports', ['go']),
  'go-error-bindings': fileProducer('go-error-bindings', 'go-error-bindings', ['go']),
  'go-goroutines': fileProducer('go-goroutines', 'go-goroutines', ['go']),
  'go-channels': fileProducer('go-channels', 'go-channels', ['go']),

  // ── Amendment 3: the vocabulary the 77 mis-declared rules actually read ───
  // Stub producers (bodies land in §3.2 / §9 / §8); each is already consumed by
  // at least one rule's re-declared `needs.facts` so residue check #2 holds.
  'react-component': fileProducer('react-component', 'react-component', ['typescript', 'tsx', 'javascript']),
  'string-literals': fileProducer('string-literals', 'string-literals', ['typescript', 'tsx', 'javascript']),
  'imports': fileProducer('imports', 'imports', ['typescript', 'tsx', 'javascript']),
  'code-block': fileProducer('code-block', 'code-block', ['typescript', 'tsx', 'javascript']),
  'export-form': fileProducer('export-form', 'export-form', ['typescript', 'tsx', 'javascript']),
  'file-imports': fileProducer('file-imports', 'file-imports', ['typescript', 'tsx', 'javascript']),
  'file-header': fileProducer('file-header', 'file-header', ['typescript', 'tsx', 'javascript']),
  'go-structures': fileProducer('go-structures', 'go-structures', ['go']),

  // Corpus facts (cross-run DB history / coverage / conventions / call graph).
  'clone-pair-history': corpusProducer('clone-pair-history', 'clone-pair-history', ['code-block']),
  'mined-conventions': corpusProducer('mined-conventions', 'mined-conventions', ['function-index']),
  'migration-history': corpusProducer('migration-history', 'migration-history', ['ddl-declarations']),
  'call-graph': corpusProducer('call-graph', 'call-graph', ['function-index']),
  'coverage-data': corpusProducer('coverage-data', 'coverage-data', ['function-index']),
  'hotspot-scores': corpusProducer('hotspot-scores', 'hotspot-scores', ['function-index']),
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
  'declared-schemas': true,
  'ddl-declarations': true,
  'schema-validations': true,
  'schema-usage': true,
  'style-declarations': true,
  'cross-language-entities': true,
  'data-access-calls': true,
  'table-catalog': true,
  'go-imports': true,
  'go-error-bindings': true,
  'go-goroutines': true,
  'go-channels': true,
  'react-component': true,
  'string-literals': true,
  'imports': true,
  'code-block': true,
  'clone-pair-history': true,
  'export-form': true,
  'file-imports': true,
  'file-header': true,
  'go-structures': true,
  'mined-conventions': true,
  'migration-history': true,
  'call-graph': true,
  'coverage-data': true,
  'hotspot-scores': true,
} satisfies Record<FactKind, true>;
