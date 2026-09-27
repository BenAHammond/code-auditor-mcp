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
  AstFile,
  FactFragment,
  TableCatalog,
  MinedConvention,
  Format,
} from './types.js';
import { extractFileSymbols } from './fileSymbols.js';
import { extractFunctionIndex } from './functionIndex.js';
import { extractFunctionBodies } from './functionBodies.js';
import { extractImports } from './imports.js';
import { extractStringLiterals } from './stringLiterals.js';
import { extractSecretCandidates } from './secretCandidates.js';
import { extractSecurityCandidates } from './securityCandidates.js';
import { extractStylesCss } from './stylesCss.js';
import { extractStylesSource } from './stylesSource.js';
import { extractDataAccessCalls } from './dataAccessCalls.js';
import { extractSchemaUsage } from './schemaUsage.js';
import { extractSchemaCode } from './schemaCode.js';
import { extractCrossLanguageEntities } from '../pipelineAdapters.js';
import { getLanguageFromPath } from '../utils/fileDiscovery.js';
import { mineConventionsFromFunctionIndex } from './conventionMining.js';

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
// one format-agnostic `process` for the formats that share an adapter. Every
// AST-reading extractor narrows `ParsedFile` to `AstFile`: the ProducerMap type
// only ever registers these under adapter-backed formats (a `sql` key exists on
// `ddl-declarations` alone, and `extractSchemaCode` reads `.source`, not the
// AST), so the cast is the one boundary where a text-only file cannot reach an
// AST consumer.
const fileSymbolsProcess = (file: ParsedFile): FactFragment<'file-symbols'> => extractFileSymbols(file as AstFile);
const functionIndexProcess = (file: ParsedFile): FactFragment<'function-index'> => extractFunctionIndex(file as AstFile);
const functionBodiesProcess = (file: ParsedFile): FactFragment<'function-bodies'> => extractFunctionBodies(file as AstFile);
const importsProcess = (file: ParsedFile): FactFragment<'imports'> => extractImports(file as AstFile);
const stringLiteralsProcess = (file: ParsedFile): FactFragment<'string-literals'> => extractStringLiterals(file as AstFile);
const secretCandidatesProcess = (file: ParsedFile): FactFragment<'secret-candidates'> => extractSecretCandidates(file as AstFile);
const securityCandidatesProcess = (file: ParsedFile): FactFragment<'security-candidates'> => extractSecurityCandidates(file as AstFile);
const ddlProcess = (file: ParsedFile): FactFragment<'ddl-declarations'> => extractSchemaCode(file);
const schemaUsageProcess = (file: ParsedFile): FactFragment<'schema-usage'> => extractSchemaUsage(file as AstFile);
const styleProcess = (file: ParsedFile): FactFragment<'style-declarations'> => [extractStylesCss(file as AstFile)];
const styleSourceProcess = (file: ParsedFile): FactFragment<'style-declarations'> => extractStylesSource(file as AstFile);
const crossLangProcess = (file: ParsedFile): FactFragment<'cross-language-entities'> =>
  extractCrossLanguageEntities((file as AstFile).ast, file.file, file.source, getLanguageFromPath(file.file));
const dataAccessProcess = (file: ParsedFile): FactFragment<'data-access-calls'> => extractDataAccessCalls(file as AstFile);

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
  'function-bodies': {
    typescript: fileProducer('function-bodies', 'typescript', functionBodiesProcess),
    tsx: fileProducer('function-bodies', 'tsx', functionBodiesProcess),
    javascript: fileProducer('function-bodies', 'javascript', functionBodiesProcess),
  },
  'imports': {
    typescript: fileProducer('imports', 'typescript', importsProcess),
    tsx: fileProducer('imports', 'tsx', importsProcess),
    javascript: fileProducer('imports', 'javascript', importsProcess),
  },
  'string-literals': {
    typescript: fileProducer('string-literals', 'typescript', stringLiteralsProcess),
    tsx: fileProducer('string-literals', 'tsx', stringLiteralsProcess),
    javascript: fileProducer('string-literals', 'javascript', stringLiteralsProcess),
  },
  'secret-candidates': {
    typescript: fileProducer('secret-candidates', 'typescript', secretCandidatesProcess),
    tsx: fileProducer('secret-candidates', 'tsx', secretCandidatesProcess),
    javascript: fileProducer('secret-candidates', 'javascript', secretCandidatesProcess),
  },
  'security-candidates': {
    typescript: fileProducer('security-candidates', 'typescript', securityCandidatesProcess),
    tsx: fileProducer('security-candidates', 'tsx', securityCandidatesProcess),
    javascript: fileProducer('security-candidates', 'javascript', securityCandidatesProcess),
  },
  // `ddl-declarations` was `schema-code`: DDL declarations parsed from code.
  // `sql` is the text-only supplier — the whole file is DDL (a migration), so
  // the same extractor runs over `.source` (it never reads the AST).
  'ddl-declarations': {
    typescript: fileProducer('ddl-declarations', 'typescript', ddlProcess),
    tsx: fileProducer('ddl-declarations', 'tsx', ddlProcess),
    javascript: fileProducer('ddl-declarations', 'javascript', ddlProcess),
    sql: fileProducer('ddl-declarations', 'sql', ddlProcess),
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
    typescript: fileProducer('style-declarations', 'typescript', styleSourceProcess),
    tsx: fileProducer('style-declarations', 'tsx', styleSourceProcess),
    javascript: fileProducer('style-declarations', 'javascript', styleSourceProcess),
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
      const tables: { name: string; source: string; columns: string[] }[] = [];
      const seen = new Set<string>();
      for (const schema of facts['ddl-declarations']) {
        if (!schema.name || seen.has(schema.name)) continue;
        seen.add(schema.name);
        tables.push({
          name: schema.name,
          source: schema.file,
          columns: (schema.columns ?? []).map((c) => c.name),
        });
      }
      return { tables };
    },
  } satisfies CorpusProcessor<'table-catalog', readonly ['ddl-declarations']>,
  // `mined-conventions` reduces the function index into the mined-convention
  // set the three function-index-servable convention rules read. `needs` forms
  // the DAG edge function-index → mined-conventions.
  'mined-conventions': {
    id: 'mined-conventions',
    produces: 'mined-conventions',
    needs: ['function-index'],
    process(facts): MinedConvention[] {
      return mineConventionsFromFunctionIndex(facts['function-index']);
    },
  } satisfies CorpusProcessor<'mined-conventions', readonly ['function-index']>,
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
  'function-bodies': true,
  'imports': true,
  'string-literals': true,
  'secret-candidates': true,
  'security-candidates': true,
  'ddl-declarations': true,
  'schema-usage': true,
  'style-declarations': true,
  'cross-language-entities': true,
  'data-access-calls': true,
  'table-catalog': true,
  'mined-conventions': true,
} satisfies Record<FactKind, true>;
