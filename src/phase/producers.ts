/**
 * Spec 68 §3.1 — one producer per (fact kind, format), enforced by a nested
 * mapped type.
 *
 * `ProducerMap` is a mapped type over {@link FileFactKind}, and for each kind a
 * second mapped type over that kind's {@link SupplyingFormats} — exhaustive by
 * construction in both axes. A file fact kind with no entry (or a format named
 * in `SupplyingFormats` with no producer) fails the type (residue check #1 in
 * checks.ts); a second producer for one (kind, format) is a duplicate object
 * key (single-producer check). There is no list to be omitted from — which is
 * the defect class Spec 68 §0, row 2 exists to remove.
 *
 * The split is the fix for the naming rule in its second form: a fact kind is a
 * *concept*, not a language. `file-symbols` is supplied by three formats that
 * all run one format-agnostic extractor, so it has three (kind, format) entries
 * sharing a `process`; a future `channel-operations` would have a `go`, a
 * `rust` and a `typescript` entry with *different* extractors. A corpus
 * processor (a derived fact, no format) lives in {@link CORPUS_PRODUCERS}, not
 * here — the DAG (§5) walks that map's `needs` edges.
 *
 * Only kinds with a producer that returns *real* data appear. A planned kind
 * without a working producer is absent from {@link FactShapes} and from these
 * maps by construction; the migration map (spec68-rule-migration-map.md) holds
 * the plan, the type holds only what runs.
 */

import type {
  FactKind,
  FileFactKind,
  CorpusFactKind,
  FileProcessor,
  CorpusProcessor,
  SupplyingFormats,
  ParsedFile,
  FactFragment,
  TableCatalog,
  Format,
} from './types.js';
import { extractFileSymbols } from './fileSymbols.js';
import { extractFunctionIndex } from './functionIndex.js';
import { extractStylesCss } from './stylesCss.js';
import { extractDataAccessCalls } from './dataAccessCalls.js';
import { extractSchemaUsage } from './schemaUsage.js';
import { extractSchemaCode } from './schemaCode.js';
import { extractCrossLanguageEntities } from '../pipelineAdapters.js';
import { getLanguageFromPath } from '../utils/fileDiscovery.js';

/**
 * Exhaustive over both axes: every file fact kind, then every supplying format.
 * `satisfies` is the single-producer check (a duplicate (kind, format) is a
 * duplicate key; a missing kind or format fails the type).
 */
export type ProducerMap = {
  readonly [K in FileFactKind]: { readonly [F in SupplyingFormats[K]]: FileProcessor<K, F> };
};

/** Corpus producers are exhaustive over {@link CorpusFactKind} the same way. */
export type CorpusProducerMap = {
  readonly [K in CorpusFactKind]: CorpusProcessor<K, readonly FactKind[]>;
};

/**
 * The fact kinds a producer currently serves, derived from the actual keys of
 * both maps — never re-declared. Add a producer to either and this widens with
 * it; `checks.ts` residue #1 stays `never` only while every kind is produced.
 */
export type ProducedFactKind = keyof typeof PRODUCERS | keyof typeof CORPUS_PRODUCERS;

/** Build one (kind, format) file-producer entry from a shared extractor. */
function fileProducer<K extends FileFactKind, F extends SupplyingFormats[K]>(
  kind: K,
  format: F,
  process: (file: ParsedFile) => FactFragment<K>,
): FileProcessor<K, F> {
  return { id: `${kind}.${format}`, produces: kind, format, process };
}

// The seven per-file extractors, hoisted so each (kind, format) entry reuses the
// one format-agnostic `process` for the formats that share an adapter.
const fileSymbolsProcess = (file: ParsedFile): FactFragment<'file-symbols'> => extractFileSymbols(file);
const functionIndexProcess = (file: ParsedFile): FactFragment<'function-index'> => extractFunctionIndex(file);
const ddlProcess = (file: ParsedFile): FactFragment<'ddl-declarations'> => extractSchemaCode(file);
const schemaUsageProcess = (file: ParsedFile): FactFragment<'schema-usage'> => extractSchemaUsage(file);
const styleProcess = (file: ParsedFile): FactFragment<'style-declarations'> => [extractStylesCss(file)];
const crossLangProcess = (file: ParsedFile): FactFragment<'cross-language-entities'> =>
  extractCrossLanguageEntities(file.ast, file.file, file.source, getLanguageFromPath(file.file));
const dataAccessProcess = (file: ParsedFile): FactFragment<'data-access-calls'> => extractDataAccessCalls(file);

export const PRODUCERS = {
  'file-symbols': {
    typescript: fileProducer('file-symbols', 'typescript', fileSymbolsProcess),
    tsx: fileProducer('file-symbols', 'tsx', fileSymbolsProcess),
    javascript: fileProducer('file-symbols', 'javascript', fileSymbolsProcess),
  },
  'function-index': {
    typescript: fileProducer('function-index', 'typescript', functionIndexProcess),
    tsx: fileProducer('function-index', 'tsx', functionIndexProcess),
    javascript: fileProducer('function-index', 'javascript', functionIndexProcess),
  },
  // `ddl-declarations` was `schema-code`: DDL declarations parsed from code.
  'ddl-declarations': {
    typescript: fileProducer('ddl-declarations', 'typescript', ddlProcess),
    tsx: fileProducer('ddl-declarations', 'tsx', ddlProcess),
    javascript: fileProducer('ddl-declarations', 'javascript', ddlProcess),
  },
  'schema-usage': {
    typescript: fileProducer('schema-usage', 'typescript', schemaUsageProcess),
    tsx: fileProducer('schema-usage', 'tsx', schemaUsageProcess),
    javascript: fileProducer('schema-usage', 'javascript', schemaUsageProcess),
  },
  // `style-declarations` was `styles-css` (named for the declaration, not the format).
  'style-declarations': {
    css: fileProducer('style-declarations', 'css', styleProcess),
    scss: fileProducer('style-declarations', 'scss', styleProcess),
  },
  'cross-language-entities': {
    typescript: fileProducer('cross-language-entities', 'typescript', crossLangProcess),
    tsx: fileProducer('cross-language-entities', 'tsx', crossLangProcess),
    javascript: fileProducer('cross-language-entities', 'javascript', crossLangProcess),
    go: fileProducer('cross-language-entities', 'go', crossLangProcess),
  },
  'data-access-calls': {
    typescript: fileProducer('data-access-calls', 'typescript', dataAccessProcess),
    tsx: fileProducer('data-access-calls', 'tsx', dataAccessProcess),
    javascript: fileProducer('data-access-calls', 'javascript', dataAccessProcess),
  },
} satisfies ProducerMap;

// ── Corpus producers producing derived facts (no format) ─────────────────────
// `table-catalog` reduces the DDL declarations into the flat known-table set
// the `missing-org-filter` and `unknown-table` rules read. `needs` forms the
// DAG edge ddl-declarations → table-catalog. Corpus producers are a separate
// map because the (kind, format) key cannot express a derived fact.
export const CORPUS_PRODUCERS = {
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
} satisfies CorpusProducerMap;

/**
 * The producer that serves `kind` from `format`, or `undefined` when that
 * format cannot supply the concept (which is not a defect — the caller skips
 * the file and §8 reports the rule `notApplicable` for it). The dynamic format
 * in a parsed file is a full {@link Format}, so the lookup is a guarded cast.
 */
export function fileProducerFor<K extends FileFactKind>(
  kind: K,
  format: Format,
): FileProcessor<K, SupplyingFormats[K]> | undefined {
  const formats = PRODUCERS[kind] as unknown as Partial<Record<Format, FileProcessor<K, SupplyingFormats[K]>>>;
  return formats[format];
}

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
