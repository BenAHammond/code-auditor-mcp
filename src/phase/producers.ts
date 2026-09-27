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
  MigrationHistory,
  MinedConvention,
  Format,
  SchemaValidationFact,
  ReachabilityFact,
} from './types.js';
import { extractFileSymbols } from './fileSymbols.js';
import { extractFunctionIndex } from './functionIndex.js';
import { extractFunctionBodies } from './functionBodies.js';
import { extractReactComponents } from './reactComponents.js';
import { extractFileHeader } from './fileHeader.js';
import { extractCodeBlocks } from './codeBlocks.js';
import { extractJsonDocument } from './jsonDocument.js';
import { buildSchemaValidations } from './schemaValidations.js';
import { extractImports } from './imports.js';
import { extractExportForm } from './exportForm.js';
import { extractImportForm } from './importForm.js';
import { extractStringLiterals } from './stringLiterals.js';
import { extractSecretCandidates } from './secretCandidates.js';
import { extractSecurityCandidates } from './securityCandidates.js';
import { extractStylesCss } from './stylesCss.js';
import { extractStylesSource } from './stylesSource.js';
import { extractDataAccessCalls } from './dataAccessCalls.js';
import { extractLoopQueries } from './loopQueries.js';
import { extractDynamicSql } from './dynamicSql.js';
import { extractSchemaUsage } from './schemaUsage.js';
import { extractSchemaCode } from './schemaCode.js';
import { extractCrossLanguageEntities } from '../pipelineAdapters.js';
import { getLanguageFromPath } from '../utils/fileDiscovery.js';
import { mineConventionsFromFunctionIndex } from './conventionMining.js';
import { replayDdlDeclarations } from '../analyzers/universal/schema/migrations.js';
import { extractFileImports } from './fileImports.js';
import { extractTypeDeclarations } from './typeDeclarations.js';
import { extractGoFunctions } from './goFunctions.js';
import { extractGoSwitches } from './goSwitches.js';
import { extractGoImports } from './goImports.js';
import { extractErrorBindings, extractConcurrencyPrimitives, extractChannelOperations } from './goFunctionAnalysis.js';
import { computeReachability } from './reachability.js';
import { DEFAULT_VIRTUAL_MODULES } from '../graph/importClassification.js';

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
const exportFormProcess = (file: ParsedFile): FactFragment<'export-form'> => extractExportForm(file as AstFile);
const importFormProcess = (file: ParsedFile): FactFragment<'import-form'> => extractImportForm(file);
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
const loopQueriesProcess = (file: ParsedFile): FactFragment<'loop-queries'> => extractLoopQueries(file as AstFile);
const dynamicSqlProcess = (file: ParsedFile): FactFragment<'dynamic-sql'> => extractDynamicSql(file as AstFile);
const reactComponentProcess = (file: ParsedFile): FactFragment<'react-component'> => [extractReactComponents(file as AstFile)];
const fileHeaderProcess = (file: ParsedFile): FactFragment<'file-header'> => extractFileHeader(file as AstFile);
const codeBlockProcess = (file: ParsedFile): FactFragment<'code-block'> => extractCodeBlocks(file as AstFile);
const jsonDocumentProcess = (file: ParsedFile): FactFragment<'json-document'> => extractJsonDocument(file);
const fileImportsProcess = (file: ParsedFile): FactFragment<'file-imports'> =>
  [extractFileImports((file as AstFile).ast, file.file, file.source, getLanguageFromPath(file.file))];
const typeDeclarationsProcess = (file: ParsedFile): FactFragment<'type-declarations'> => extractTypeDeclarations(file as AstFile);
const goFunctionsProcess = (file: ParsedFile): FactFragment<'go-functions'> => extractGoFunctions(file as AstFile);
const goSwitchesProcess = (file: ParsedFile): FactFragment<'go-switches'> => extractGoSwitches(file as AstFile);
const goImportsProcess = (file: ParsedFile): FactFragment<'imports'> => extractGoImports(file as AstFile);
const errorBindingsProcess = (file: ParsedFile): FactFragment<'error-bindings'> => extractErrorBindings(file as AstFile);
const concurrencyPrimitivesProcess = (file: ParsedFile): FactFragment<'concurrency-primitives'> => extractConcurrencyPrimitives(file as AstFile);
const channelOperationsProcess = (file: ParsedFile): FactFragment<'channel-operations'> => extractChannelOperations(file as AstFile);

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
    go: fileProducer('imports', 'go', goImportsProcess),
  },
  'export-form': {
    typescript: fileProducer('export-form', 'typescript', exportFormProcess),
    tsx: fileProducer('export-form', 'tsx', exportFormProcess),
    javascript: fileProducer('export-form', 'javascript', exportFormProcess),
  },
  'import-form': {
    typescript: fileProducer('import-form', 'typescript', importFormProcess),
    tsx: fileProducer('import-form', 'tsx', importFormProcess),
    javascript: fileProducer('import-form', 'javascript', importFormProcess),
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
  'loop-queries': {
    typescript: fileProducer('loop-queries', 'typescript', loopQueriesProcess),
    tsx: fileProducer('loop-queries', 'tsx', loopQueriesProcess),
    javascript: fileProducer('loop-queries', 'javascript', loopQueriesProcess),
  },
  'dynamic-sql': {
    typescript: fileProducer('dynamic-sql', 'typescript', dynamicSqlProcess),
    tsx: fileProducer('dynamic-sql', 'tsx', dynamicSqlProcess),
    javascript: fileProducer('dynamic-sql', 'javascript', dynamicSqlProcess),
  },
  'react-component': {
    typescript: fileProducer('react-component', 'typescript', reactComponentProcess),
    tsx: fileProducer('react-component', 'tsx', reactComponentProcess),
    javascript: fileProducer('react-component', 'javascript', reactComponentProcess),
  },
  'file-header': {
    typescript: fileProducer('file-header', 'typescript', fileHeaderProcess),
    tsx: fileProducer('file-header', 'tsx', fileHeaderProcess),
    javascript: fileProducer('file-header', 'javascript', fileHeaderProcess),
  },
  'code-block': {
    typescript: fileProducer('code-block', 'typescript', codeBlockProcess),
    tsx: fileProducer('code-block', 'tsx', codeBlockProcess),
    javascript: fileProducer('code-block', 'javascript', codeBlockProcess),
  },
  // `json-document` was the Amendment-1 "json is a format" producer: a `.json`
  // file's parsed value, read for the `schema-validations` corpus reduction.
  // It reads `.source` only (the JsonAdapter has no code constructs), so it
  // takes `ParsedFile`, not `AstFile` — like the text-only `sql` DDL producer.
  'json-document': {
    json: fileProducer('json-document', 'json', jsonDocumentProcess),
  },
  'file-imports': {
    typescript: fileProducer('file-imports', 'typescript', fileImportsProcess),
    tsx: fileProducer('file-imports', 'tsx', fileImportsProcess),
    javascript: fileProducer('file-imports', 'javascript', fileImportsProcess),
    go: fileProducer('file-imports', 'go', fileImportsProcess),
  },
  // §9 — Go named struct/interface declarations, served only for the `go`
  // format (the Go grammar is the only supplier). `struct-size` and the Go arm
  // of `interface-size` read it.
  'type-declarations': {
    go: fileProducer('type-declarations', 'go', typeDeclarationsProcess),
  },
  // §9 — Go function metrics + switch case counts, served only for the `go`
  // format. `function-size` + `liskov-substitution` read `go-functions`;
  // `switch-size` reads `go-switches`.
  'go-functions': {
    go: fileProducer('go-functions', 'go', goFunctionsProcess),
  },
  'go-switches': {
    go: fileProducer('go-switches', 'go', goSwitchesProcess),
  },
  // §9 — the three function-level Go producers (error-binding positions,
  // goroutine-synchronization signal, channel-operation counts). `error-handling`
  // reads `error-bindings`; `concurrency` reads `concurrency-primitives`;
  // `channel-deadlock` reads `channel-operations`.
  'error-bindings': {
    go: fileProducer('error-bindings', 'go', errorBindingsProcess),
  },
  'concurrency-primitives': {
    go: fileProducer('concurrency-primitives', 'go', concurrencyPrimitivesProcess),
  },
  'channel-operations': {
    go: fileProducer('channel-operations', 'go', channelOperationsProcess),
  },
} satisfies ProducerMap;

// ── Corpus producers producing derived facts (no format) ─────────────────────
// `table-catalog` and `migration-history` reduce the `ddl-declarations` fact
// through the ONE shared `replayDdlDeclarations` — so the known-table set and
// the drop provenance can never disagree about which table a migration dropped.
// `needs` forms the DAG edges ddl-declarations → {table-catalog,
// migration-history}. Corpus producers are a separate map because the
// (kind, format) key cannot express a derived fact.

export const CORPUS_PRODUCERS = {
  'table-catalog': {
    id: 'table-catalog',
    produces: 'table-catalog',
    needs: ['ddl-declarations'],
    process(facts): TableCatalog {
      // The known-table set is the *net* set after replaying DDL across files
      // in migration order — a table dropped in a later migration is a stale
      // reference, not a known table. `replayDdlDeclarations` returns that net
      // set with each table's last-CREATE source file and columns (the shape
      // `missing-org-filter`'s Tier-3 DDL discovery reads).
      const { netTables } = replayDdlDeclarations(
        facts['ddl-declarations'].map((d) => ({
          filePath: d.file,
          ops: d.ops,
          tableColumns: d.tableColumns,
        })),
      );
      return { tables: netTables.map((t) => ({ name: t.name, source: t.source, columns: t.columns })) };
    },
  } satisfies CorpusProcessor<'table-catalog', readonly ['ddl-declarations']>,
  // `migration-history` reduces the DDL declarations into the cross-file drop
  // provenance (dropped-table → dropping migration + what it created). `needs`
  // forms the DAG edge ddl-declarations → migration-history, parallel to
  // table-catalog. The provenance is the same `replayDdlDeclarations` pass the
  // legacy schema reducer ran, so `stale-table-reference` parity holds by
  // construction — the phase rule reads the same map the reducer did.
  'migration-history': {
    id: 'migration-history',
    produces: 'migration-history',
    needs: ['ddl-declarations'],
    process(facts): MigrationHistory {
      const { dropProvenance } = replayDdlDeclarations(
        facts['ddl-declarations'].map((d) => ({
          filePath: d.file,
          ops: d.ops,
          tableColumns: d.tableColumns,
        })),
      );
      const dropped: Record<string, { migrationFile: string; createdInSameMigration: readonly string[] }> = {};
      for (const [table, entry] of dropProvenance) {
        dropped[table] = {
          migrationFile: entry.migrationFile,
          createdInSameMigration: entry.createdInSameMigration,
        };
      }
      return { dropped };
    },
  } satisfies CorpusProcessor<'migration-history', readonly ['ddl-declarations']>,
  // `mined-conventions` reduces the function index into the mined-convention
  // set the three function-index-servable convention rules read. `needs` forms
  // the DAG edge function-index → mined-conventions.
  'mined-conventions': {
    id: 'mined-conventions',
    produces: 'mined-conventions',
    needs: ['function-index', 'export-form', 'import-form'],
    process(facts): MinedConvention[] {
      return mineConventionsFromFunctionIndex(facts['function-index'], facts['export-form'], facts['import-form']);
    },
  } satisfies CorpusProcessor<'mined-conventions', readonly ['function-index', 'export-form', 'import-form']>,
  // `schema-validations` reduces the `json-document` fact through the legacy
  // `analyzeJsonSchemas` free function. `needs` forms the DAG edge
  // json-document → schema-validations.
  'schema-validations': {
    id: 'schema-validations',
    produces: 'schema-validations',
    needs: ['json-document'],
    process(facts): SchemaValidationFact[] {
      return buildSchemaValidations(facts['json-document']);
    },
  } satisfies CorpusProcessor<'schema-validations', readonly ['json-document']>,
  // `reachability` reduces the `file-imports` fact into the reverse import
  // adjacency + package entry-point set (§8). It is the one corpus processor
  // that reads the `CorpusContext` — the discovery list, virtual-module list,
  // tsconfig aliases and package.json entry points are corpus-level inputs the
  // per-file fact cannot carry. Defaults mirror the legacy reducer's fallback
  // (corpus = the file-imports set, no aliases, DEFAULT_VIRTUAL_MODULES, no
  // package entries) so the slice tests stay self-contained.
  'reachability': {
    id: 'reachability',
    produces: 'reachability',
    needs: ['file-imports'],
    process(facts, ctx): ReachabilityFact {
      const fileImports = facts['file-imports'];
      return computeReachability(fileImports, {
        corpusFiles: new Set(ctx?.corpusFiles ?? fileImports.map((f) => f.file)),
        virtualModules: ctx?.virtualModules ?? DEFAULT_VIRTUAL_MODULES,
        tsconfigAliases: ctx?.tsconfigAliases,
        packageEntryPoints: new Set(ctx?.packageEntryPoints ?? []),
        projectRoot: ctx?.projectRoot ?? '',
      });
    },
  } satisfies CorpusProcessor<'reachability', readonly ['file-imports']>,
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
  'export-form': true,
  'import-form': true,
  'string-literals': true,
  'secret-candidates': true,
  'security-candidates': true,
  'ddl-declarations': true,
  'schema-usage': true,
  'style-declarations': true,
  'cross-language-entities': true,
  'data-access-calls': true,
  'loop-queries': true,
  'dynamic-sql': true,
  'table-catalog': true,
  'migration-history': true,
  'mined-conventions': true,
  'react-component': true,
  'file-header': true,
  'code-block': true,
  'json-document': true,
  'schema-validations': true,
  'file-imports': true,
  'reachability': true,
  'type-declarations': true,
  'go-functions': true,
  'go-switches': true,
  'error-bindings': true,
  'concurrency-primitives': true,
  'channel-operations': true,
} satisfies Record<FactKind, true>;
