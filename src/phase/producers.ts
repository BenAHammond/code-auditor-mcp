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
  CompletenessOracle,
  TableCatalog,
  MigrationHistory,
  MinedConvention,
  Format,
  SchemaValidationFact,
  ReachabilityFact,
  CallGraphFact,
  HotspotFact,
  CoverageFact,
  ClonePairHistoryFact,
  DefinedClassesFact,
  UnreadStyleSourceFact,
} from './types.js';
import {
  countOracle,
  noOracle,
  countFileSymbols,
  countImports,
  countExportForm,
  countFunctionIndex,
  countStringLiterals,
  countCrossLanguageEntities,
  countCodeBlocks,
  countFileImports,
  countJsxElements,
  countBatchFunctions,
  countGoImports,
  countGoFunctions,
  countGoSwitches,
  countTypeDeclarations,
  countSchemaObjects,
  countDdlOps,
  countCssDeclarations,
  countSecretCandidates,
  countSecurityCandidates,
  countDataAccessCalls,
  countLoopQueries,
  countDynamicSql,
  countFunctionBodies,
  countSchemaUsage,
  measuredDdlOps,
  measuredStyleDeclarations,
  measuredJsxElements,
  measuredFileImports,
} from './oracles.js';
import { extractFileSymbols } from './fileSymbols.js';
import { extractFunctionIndex } from './functionIndex.js';
import { extractFunctionBodies } from './functionBodies.js';
import { extractReactComponents } from './reactComponents.js';
import { extractFileHeader } from './fileHeader.js';
import { extractCodeBlocks } from './codeBlocks.js';
import { extractBatchFunctions } from './batchFunctions.js';
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
import { extractStylesMarkup } from './stylesMarkup.js';
import { extractDataAccessCalls } from './dataAccessCalls.js';
import { extractLoopQueries } from './loopQueries.js';
import { extractDynamicSql } from './dynamicSql.js';
import { extractSchemaUsage } from './schemaUsage.js';
import { extractSchemaCode } from './schemaCode.js';
import { extractSchemaObjects } from './schemaObjects.js';
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
  oracle: CompletenessOracle,
): FileProcessor<K, F> {
  return { id: `${kind}.${format}`, produces: kind, format, process, oracle };
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
const schemaObjectsProcess = (file: ParsedFile): FactFragment<'schema-objects'> => extractSchemaObjects(file);
const styleProcess = (file: ParsedFile): FactFragment<'style-declarations'> => [extractStylesCss(file as AstFile)];
const styleSourceProcess = (file: ParsedFile): FactFragment<'style-declarations'> => extractStylesSource(file as AstFile);
const styleMarkupProcess = (file: ParsedFile): FactFragment<'style-declarations'> => extractStylesMarkup(file);
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
const batchFunctionsProcess = (file: ParsedFile): FactFragment<'batch-functions'> => extractBatchFunctions(file as AstFile);

// ── Spec 69 R1 — the `none` residues (every one enumerated in the run, criterion 3) ──
// The R1 correction re-examined every `none` against an *upper-bound* bar, not an
// exact-count bar: an oracle that over-counts is still an oracle, because the
// residual is pinned and a movement in it is the signal (the `batch-functions`
// / `countCssDeclarations` precedent). That converted all 22 of the old
// CLASSIFICATION/GATED `none`s to coarse counted oracles — "no exact counter"
// and "the residual drowns the signal" were judgements, not measurements, and
// the aggregate gate pins `actual` exactly so any producer regression shows
// regardless of residual size. The split is now 73 counted / 8 none.
//   • STYLE_SOURCE / STYLE_MARKUP — the declaration unit is the *expansion* of a
//     union of source mechanisms (Tailwind utility classes, inline-style object
//     pairs, CSS-in-JS templates). Tailwind-utility and shorthand expansion make
//     the emitted declaration count exceed any cheap count of source syntactic
//     features, so no source-feature count upper-bounds it (a class token expands
//     to ≥1 declaration; `margin: 4px` to 4). Any cheap count would *under*-bound
//     and never fire — a dead oracle, not a noisy one. This is a genuine `none`:
//     not "no exact counter" but "no cheap *upper* bound exists".
//   • SINGLE_OBJECT — the producer emits exactly one fragment per file
//     (null-or-value), so there is no partial-extraction failure mode for an
//     oracle to guard: a count of 1 against 1 is the empty oracle.
const STYLE_SOURCE = noOracle(
  'declarations are the expansion of a union of source mechanisms (Tailwind utility classes, inline-style object pairs, CSS-in-JS templates); Tailwind-utility and shorthand expansion make the emitted count exceed any cheap count of source features, so every cheap count under-bounds and would never fire a shortfall',
);
const STYLE_MARKUP = noOracle(
  'declarations are extracted by regex over markup source with no AST and are the expansion of class/style/block mechanisms; Tailwind-utility and shorthand expansion make the emitted count exceed any cheap count of source features, so every cheap count under-bounds and would never fire a shortfall',
);
const SINGLE_OBJECT = noOracle(
  'emits exactly one fragment per file (null-or-value); there is no partial-extraction failure mode to guard, so a count of 1 against 1 is the empty oracle',
);

export const PRODUCERS = {
  'file-symbols': {
    typescript: fileProducer('file-symbols', 'typescript', fileSymbolsProcess, countOracle(countFileSymbols)),
    tsx: fileProducer('file-symbols', 'tsx', fileSymbolsProcess, countOracle(countFileSymbols)),
    javascript: fileProducer('file-symbols', 'javascript', fileSymbolsProcess, countOracle(countFileSymbols)),
  },
  'function-index': {
    typescript: fileProducer('function-index', 'typescript', functionIndexProcess, countOracle(countFunctionIndex)),
    tsx: fileProducer('function-index', 'tsx', functionIndexProcess, countOracle(countFunctionIndex)),
    javascript: fileProducer('function-index', 'javascript', functionIndexProcess, countOracle(countFunctionIndex)),
  },
  'function-bodies': {
    typescript: fileProducer('function-bodies', 'typescript', functionBodiesProcess, countOracle(countFunctionBodies)),
    tsx: fileProducer('function-bodies', 'tsx', functionBodiesProcess, countOracle(countFunctionBodies)),
    javascript: fileProducer('function-bodies', 'javascript', functionBodiesProcess, countOracle(countFunctionBodies)),
  },
  'imports': {
    typescript: fileProducer('imports', 'typescript', importsProcess, countOracle(countImports)),
    tsx: fileProducer('imports', 'tsx', importsProcess, countOracle(countImports)),
    javascript: fileProducer('imports', 'javascript', importsProcess, countOracle(countImports)),
    go: fileProducer('imports', 'go', goImportsProcess, countOracle(countGoImports)),
  },
  'export-form': {
    typescript: fileProducer('export-form', 'typescript', exportFormProcess, countOracle(countExportForm)),
    tsx: fileProducer('export-form', 'tsx', exportFormProcess, countOracle(countExportForm)),
    javascript: fileProducer('export-form', 'javascript', exportFormProcess, countOracle(countExportForm)),
  },
  'import-form': {
    typescript: fileProducer('import-form', 'typescript', importFormProcess, countOracle(countImports)),
    tsx: fileProducer('import-form', 'tsx', importFormProcess, countOracle(countImports)),
    javascript: fileProducer('import-form', 'javascript', importFormProcess, countOracle(countImports)),
  },
  'string-literals': {
    typescript: fileProducer('string-literals', 'typescript', stringLiteralsProcess, countOracle(countStringLiterals)),
    tsx: fileProducer('string-literals', 'tsx', stringLiteralsProcess, countOracle(countStringLiterals)),
    javascript: fileProducer('string-literals', 'javascript', stringLiteralsProcess, countOracle(countStringLiterals)),
  },
  'secret-candidates': {
    typescript: fileProducer('secret-candidates', 'typescript', secretCandidatesProcess, countOracle(countSecretCandidates)),
    tsx: fileProducer('secret-candidates', 'tsx', secretCandidatesProcess, countOracle(countSecretCandidates)),
    javascript: fileProducer('secret-candidates', 'javascript', secretCandidatesProcess, countOracle(countSecretCandidates)),
  },
  'security-candidates': {
    typescript: fileProducer('security-candidates', 'typescript', securityCandidatesProcess, countOracle(countSecurityCandidates)),
    tsx: fileProducer('security-candidates', 'tsx', securityCandidatesProcess, countOracle(countSecurityCandidates)),
    javascript: fileProducer('security-candidates', 'javascript', securityCandidatesProcess, countOracle(countSecurityCandidates)),
  },
  // `ddl-declarations` was `schema-code`: DDL declarations parsed from code.
  // `sql` is the text-only supplier — the whole file is DDL (a migration), so
  // the same extractor runs over `.source` (it never reads the AST).
  'ddl-declarations': {
    typescript: fileProducer('ddl-declarations', 'typescript', ddlProcess, countOracle(countDdlOps, measuredDdlOps)),
    tsx: fileProducer('ddl-declarations', 'tsx', ddlProcess, countOracle(countDdlOps, measuredDdlOps)),
    javascript: fileProducer('ddl-declarations', 'javascript', ddlProcess, countOracle(countDdlOps, measuredDdlOps)),
    sql: fileProducer('ddl-declarations', 'sql', ddlProcess, countOracle(countDdlOps, measuredDdlOps)),
  },
  'schema-usage': {
    typescript: fileProducer('schema-usage', 'typescript', schemaUsageProcess, countOracle(countSchemaUsage)),
    tsx: fileProducer('schema-usage', 'tsx', schemaUsageProcess, countOracle(countSchemaUsage)),
    javascript: fileProducer('schema-usage', 'javascript', schemaUsageProcess, countOracle(countSchemaUsage)),
  },
  // `schema-objects` — ORM `const <id> = pgTable('name', …)` bindings, the
  // identifier → SQL-name half of the known-table catalog's alias map. Text-only
  // projection (no AST), like `ddl-declarations`, so it reads `ParsedFile`.
  'schema-objects': {
    typescript: fileProducer('schema-objects', 'typescript', schemaObjectsProcess, countOracle(countSchemaObjects)),
    tsx: fileProducer('schema-objects', 'tsx', schemaObjectsProcess, countOracle(countSchemaObjects)),
    javascript: fileProducer('schema-objects', 'javascript', schemaObjectsProcess, countOracle(countSchemaObjects)),
  },
  // `style-declarations` was `styles-css` (named for the declaration, not the format).
  'style-declarations': {
    css: fileProducer('style-declarations', 'css', styleProcess, countOracle(countCssDeclarations, measuredStyleDeclarations)),
    scss: fileProducer('style-declarations', 'scss', styleProcess, countOracle(countCssDeclarations, measuredStyleDeclarations)),
    typescript: fileProducer('style-declarations', 'typescript', styleSourceProcess, STYLE_SOURCE),
    tsx: fileProducer('style-declarations', 'tsx', styleSourceProcess, STYLE_SOURCE),
    javascript: fileProducer('style-declarations', 'javascript', styleSourceProcess, STYLE_SOURCE),
    markup: fileProducer('style-declarations', 'markup', styleMarkupProcess, STYLE_MARKUP),
  },
  'cross-language-entities': {
    typescript: fileProducer('cross-language-entities', 'typescript', crossLangProcess, countOracle(countCrossLanguageEntities)),
    tsx: fileProducer('cross-language-entities', 'tsx', crossLangProcess, countOracle(countCrossLanguageEntities)),
    javascript: fileProducer('cross-language-entities', 'javascript', crossLangProcess, countOracle(countCrossLanguageEntities)),
    go: fileProducer('cross-language-entities', 'go', crossLangProcess, countOracle(countCrossLanguageEntities)),
  },
  'data-access-calls': {
    typescript: fileProducer('data-access-calls', 'typescript', dataAccessProcess, countOracle(countDataAccessCalls)),
    tsx: fileProducer('data-access-calls', 'tsx', dataAccessProcess, countOracle(countDataAccessCalls)),
    javascript: fileProducer('data-access-calls', 'javascript', dataAccessProcess, countOracle(countDataAccessCalls)),
    go: fileProducer('data-access-calls', 'go', dataAccessProcess, countOracle(countDataAccessCalls)),
  },
  'loop-queries': {
    typescript: fileProducer('loop-queries', 'typescript', loopQueriesProcess, countOracle(countLoopQueries)),
    tsx: fileProducer('loop-queries', 'tsx', loopQueriesProcess, countOracle(countLoopQueries)),
    javascript: fileProducer('loop-queries', 'javascript', loopQueriesProcess, countOracle(countLoopQueries)),
  },
  'dynamic-sql': {
    typescript: fileProducer('dynamic-sql', 'typescript', dynamicSqlProcess, countOracle(countDynamicSql)),
    tsx: fileProducer('dynamic-sql', 'tsx', dynamicSqlProcess, countOracle(countDynamicSql)),
    javascript: fileProducer('dynamic-sql', 'javascript', dynamicSqlProcess, countOracle(countDynamicSql)),
  },
  'react-component': {
    typescript: fileProducer('react-component', 'typescript', reactComponentProcess, countOracle(countJsxElements, measuredJsxElements)),
    tsx: fileProducer('react-component', 'tsx', reactComponentProcess, countOracle(countJsxElements, measuredJsxElements)),
    javascript: fileProducer('react-component', 'javascript', reactComponentProcess, countOracle(countJsxElements, measuredJsxElements)),
  },
  'file-header': {
    typescript: fileProducer('file-header', 'typescript', fileHeaderProcess, SINGLE_OBJECT),
    tsx: fileProducer('file-header', 'tsx', fileHeaderProcess, SINGLE_OBJECT),
    javascript: fileProducer('file-header', 'javascript', fileHeaderProcess, SINGLE_OBJECT),
  },
  'code-block': {
    typescript: fileProducer('code-block', 'typescript', codeBlockProcess, countOracle(countCodeBlocks)),
    tsx: fileProducer('code-block', 'tsx', codeBlockProcess, countOracle(countCodeBlocks)),
    javascript: fileProducer('code-block', 'javascript', codeBlockProcess, countOracle(countCodeBlocks)),
  },
  // `json-document` was the Amendment-1 "json is a format" producer: a `.json`
  // file's parsed value, read for the `schema-validations` corpus reduction.
  // It reads `.source` only (the JsonAdapter has no code constructs), so it
  // takes `ParsedFile`, not `AstFile` — like the text-only `sql` DDL producer.
  'json-document': {
    json: fileProducer('json-document', 'json', jsonDocumentProcess, SINGLE_OBJECT),
  },
  'file-imports': {
    typescript: fileProducer('file-imports', 'typescript', fileImportsProcess, countOracle(countFileImports, measuredFileImports)),
    tsx: fileProducer('file-imports', 'tsx', fileImportsProcess, countOracle(countFileImports, measuredFileImports)),
    javascript: fileProducer('file-imports', 'javascript', fileImportsProcess, countOracle(countFileImports, measuredFileImports)),
    go: fileProducer('file-imports', 'go', fileImportsProcess, countOracle(countFileImports, measuredFileImports)),
  },
  // §9 — Go named struct/interface declarations, served only for the `go`
  // format (the Go grammar is the only supplier). `struct-size` and the Go arm
  // of `interface-size` read it.
  'type-declarations': {
    go: fileProducer('type-declarations', 'go', typeDeclarationsProcess, countOracle(countTypeDeclarations)),
  },
  // §9 — Go function metrics + switch case counts, served only for the `go`
  // format. `function-size` + `liskov-substitution` read `go-functions`;
  // `switch-size` reads `go-switches`.
  'go-functions': {
    go: fileProducer('go-functions', 'go', goFunctionsProcess, countOracle(countGoFunctions)),
  },
  'go-switches': {
    go: fileProducer('go-switches', 'go', goSwitchesProcess, countOracle(countGoSwitches)),
  },
  // §9 — the three function-level Go producers (error-binding positions,
  // goroutine-synchronization signal, channel-operation counts). `error-handling`
  // reads `error-bindings`; `concurrency` reads `concurrency-primitives`;
  // `channel-deadlock` reads `channel-operations`.
  'error-bindings': {
    go: fileProducer('error-bindings', 'go', errorBindingsProcess, countOracle(countGoFunctions)),
  },
  'concurrency-primitives': {
    go: fileProducer('concurrency-primitives', 'go', concurrencyPrimitivesProcess, countOracle(countGoFunctions)),
  },
  'channel-operations': {
    go: fileProducer('channel-operations', 'go', channelOperationsProcess, countOracle(countGoFunctions)),
  },
  // `batch-functions` — the functions whose full span contains `.batch(` (a
  // Cloudflare D1 / SQLite transaction-batching commit). `multi-table-write`
  // reads it to skip the transaction-boundary flag for batched commits; the
  // producer re-homes the legacy `enclosingFunctionBatches` re-parse.
  'batch-functions': {
    typescript: fileProducer('batch-functions', 'typescript', batchFunctionsProcess, countOracle(countBatchFunctions)),
    tsx: fileProducer('batch-functions', 'tsx', batchFunctionsProcess, countOracle(countBatchFunctions)),
    javascript: fileProducer('batch-functions', 'javascript', batchFunctionsProcess, countOracle(countBatchFunctions)),
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
    needs: ['ddl-declarations', 'schema-objects'],
    process(facts, ctx?): TableCatalog {
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
          uniqueColumns: d.uniqueColumns,
        })),
      );
      const tables = netTables.map((t) => ({
        name: t.name,
        source: t.source,
        columns: t.columns,
        uniqueColumns: [...t.uniqueColumns],
      }));
      // §5 parity: merge the config-declared external tables the legacy schema
      // reducer added to the known-table set (`knownTables` + `schemas`). Without
      // them a config-only schema is a 0-table catalog and `unknown-table`'s
      // fail-open guard silently never fires — exactly the sql-cte regression.
      // Config-declared tables carry no column metadata, so no UNIQUE columns.
      for (const t of ctx?.externalTables ?? []) {
        tables.push({ name: t.name, source: t.source, columns: [...t.columns], uniqueColumns: [] });
      }
      // The ORM schema-object alias map: `.from(sampleOwnership)` names the JS
      // identifier, not the SQL table. Resolve it through the pgTable/mysqlTable/
      // sqliteTable bindings so a query referencing a schema object reaches the
      // catalog entry (and Tier-3 tenancy) the identifier declares.
      const aliases: Record<string, string> = {};
      for (const obj of facts['schema-objects']) {
        if (!(obj.identifier in aliases)) aliases[obj.identifier] = obj.table;
        // Merge the Drizzle `.unique()` / `.primaryKey()` columns (JS field name
        // + SQL name) into the matching catalog entry, so a query filtering on
        // either spelling is recognised as a structurally-scoped (bootstrap)
        // lookup by `missing-org-filter`. A DDL-only table with no schema-object
        // binding keeps just its DDL-declared UNIQUE columns.
        const entry = tables.find((t) => t.name === obj.table);
        if (entry && obj.uniqueColumns.length > 0) {
          entry.uniqueColumns = [...new Set([...entry.uniqueColumns, ...obj.uniqueColumns])];
        }
      }
      return { tables, aliases };
    },
  } satisfies CorpusProcessor<'table-catalog', readonly ['ddl-declarations', 'schema-objects']>,
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
  // `call-graph` (§2.2) — the index-backed function catalog + call edges the
  // cross-domain rules' depth-1 callee expansion reads. The legacy
  // `CrossDomainAnalyzer` queried `graph_cache` + `functions` directly; here that
  // read is a corpus producer reading `ctx.indexHandle`, projecting plain data.
  // With no handle (slice tests) or an unpopulated index, it degrades to an
  // empty fact — matching the legacy graceful-degradation (direct writes only).
  'call-graph': {
    id: 'call-graph',
    produces: 'call-graph',
    needs: [],
    process(_facts, ctx): CallGraphFact {
      const ih = ctx?.indexHandle;
      if (!ih) return { functions: [], callEdges: [] };
      let funcs: Array<{ id: number; name: string; file_path: string; line_number: number | null; used_imports: string | null; is_exported: number }> = [];
      let edges: Array<{ node_key: string; neighbor_key: string }> = [];
      try {
        funcs = ih.query('SELECT id, name, file_path, line_number, used_imports, is_exported FROM functions') as Array<{ id: number; name: string; file_path: string; line_number: number | null; used_imports: string | null; is_exported: number }>;
        edges = ih.query("SELECT node_key, neighbor_key FROM graph_cache WHERE graph_type = 'call'") as Array<{ node_key: string; neighbor_key: string }>;
      } catch {
        // `functions`/`graph_cache` may not exist or be unpopulated — degrade.
      }
      const callEdges: Array<{ fromId: number; toId: number }> = [];
      for (const e of edges) {
        const fromId = parseInt(e.node_key, 10);
        const toId = parseInt(e.neighbor_key, 10);
        if (!isNaN(fromId) && !isNaN(toId)) callEdges.push({ fromId, toId });
      }
      return {
        functions: funcs.map((f) => ({
          id: f.id,
          name: f.name,
          filePath: f.file_path,
          lineNumber: f.line_number ?? null,
          usedImports: f.used_imports ?? null,
          isExported: f.is_exported === 1,
        })),
        callEdges,
      };
    },
  } satisfies CorpusProcessor<'call-graph', readonly []>,
  // `hotspot` (R4 uncovered-risk) — the `hotspot_scores` rows the uncovered-risk
  // ranking LEFT-JOINs on (target = file_path || ':' || name, type = 'function').
  'hotspot': {
    id: 'hotspot',
    produces: 'hotspot',
    needs: [],
    process(_facts, ctx): HotspotFact[] {
      const ih = ctx?.indexHandle;
      if (!ih) return [];
      let rows: Array<{ target: string; type: string; score: number }> = [];
      try {
        rows = ih.query('SELECT target, type, score FROM hotspot_scores') as Array<{ target: string; type: string; score: number }>;
      } catch {
        // `hotspot_scores` may not exist — degrade to an empty fact.
      }
      return rows.map((r) => ({ target: r.target, type: r.type, score: r.score }));
    },
  } satisfies CorpusProcessor<'hotspot', readonly []>,
  // `coverage` (R4 uncovered-risk) — the `coverage_data` identity projection plus
  // the two measured-path metadata reads the legacy `detectMeasuredUncovered`
  // made (source/imported_at LIMIT 1, and `last_full_sync_timestamp` for stale
  // detection). Degrades to an empty fact with no handle.
  'coverage': {
    id: 'coverage',
    produces: 'coverage',
    needs: [],
    process(_facts, ctx): CoverageFact {
      const ih = ctx?.indexHandle;
      if (!ih) return { measuredCount: 0, source: null, importedAt: null, lastFullSync: null, entries: [] };
      try {
        const measuredRow = ih.query("SELECT COUNT(*) AS cnt FROM coverage_data WHERE basis = 'measured'")[0] as { cnt: number } | undefined;
        const measuredCount = measuredRow?.cnt ?? 0;
        const sourceRow = ih.query("SELECT source, imported_at FROM coverage_data WHERE basis = 'measured' LIMIT 1")[0] as { source: string | null; imported_at: string | null } | undefined;
        const lastFullSync = (ih.getMeta?.('last_full_sync_timestamp') as string | null) ?? null;
        const entries = ih.query('SELECT function_name, file_path, covered FROM coverage_data') as Array<{ function_name: string; file_path: string; covered: number }>;
        return {
          measuredCount,
          source: sourceRow?.source ?? null,
          importedAt: sourceRow?.imported_at ?? null,
          lastFullSync,
          entries: entries.map((e) => ({ functionName: e.function_name, filePath: e.file_path, covered: e.covered === 1 })),
        };
      } catch {
        return { measuredCount: 0, source: null, importedAt: null, lastFullSync: null, entries: [] };
      }
    },
  } satisfies CorpusProcessor<'coverage', readonly []>,
  // `clone-pair-history` (R5 diverging-clone) — the `dry_pair_history` rows the
  // diverging-clone rule's cross-run pass reads, grouped by fingerprint. The
  // file/line anchors are the most recent row's (ORDER BY timestamp ASC, last
  // wins). Degrades to an empty fact with no handle or an absent table.
  'clone-pair-history': {
    id: 'clone-pair-history',
    produces: 'clone-pair-history',
    needs: [],
    process(_facts, ctx): ClonePairHistoryFact {
      const ih = ctx?.indexHandle;
      if (!ih) return [];
      let rows: Array<{ pair_fingerprint: string; file1: string; file2: string; line1: number; line2: number; similarity: number; timestamp: string }> = [];
      try {
        rows = ih.query(
          'SELECT pair_fingerprint, file1, file2, line1, line2, similarity, timestamp FROM dry_pair_history ORDER BY pair_fingerprint, timestamp ASC',
        ) as Array<{ pair_fingerprint: string; file1: string; file2: string; line1: number; line2: number; similarity: number; timestamp: string }>;
      } catch {
        // `dry_pair_history` may not exist — degrade to an empty fact.
      }
      const byFingerprint = new Map<string, { file1: string; file2: string; line1: number; line2: number; rows: Array<{ similarity: number; timestamp: string }> }>();
      for (const r of rows) {
        const g = byFingerprint.get(r.pair_fingerprint) ?? { file1: r.file1, file2: r.file2, line1: r.line1, line2: r.line2, rows: [] };
        // Last row in the ASC ordering wins — the most recent measurement's anchors.
        g.file1 = r.file1;
        g.file2 = r.file2;
        g.line1 = r.line1;
        g.line2 = r.line2;
        g.rows.push({ similarity: r.similarity, timestamp: r.timestamp });
        byFingerprint.set(r.pair_fingerprint, g);
      }
      return [...byFingerprint.entries()].map(([fingerprint, g]) => ({
        fingerprint,
        file1: g.file1,
        file2: g.file2,
        line1: g.line1,
        line2: g.line2,
        rows: g.rows,
      }));
    },
  } satisfies CorpusProcessor<'clone-pair-history', readonly []>,
  // `defined-classes` (styles/undefined-class) — the `style_defined_classes`
  // catalog, one row per defined `.class` selector (MIN(file_path) per class name
  // so a class defined in several files collapses to one entry). The rule resolves
  // candidate class names against this set in memory and near-miss-suggests against
  // it via Levenshtein. Degrades to an empty fact with no handle or an absent table.
  'defined-classes': {
    id: 'defined-classes',
    produces: 'defined-classes',
    needs: [],
    process(_facts, ctx): DefinedClassesFact[] {
      const ih = ctx?.indexHandle;
      if (!ih) return [];
      let rows: Array<{ class_name: string; file_path: string }> = [];
      try {
        rows = ih.query(
          'SELECT class_name, MIN(file_path) AS file_path FROM style_defined_classes GROUP BY class_name',
        ) as Array<{ class_name: string; file_path: string }>;
      } catch {
        // `style_defined_classes` may not exist — degrade to an empty fact.
      }
      return rows.map((r) => ({ className: r.class_name, filePath: r.file_path }));
    },
  } satisfies CorpusProcessor<'defined-classes', readonly []>,
  // `unread-style-sources` (styles/undefined-class) — the `style_unread_sources`
  // catalog, one row per stylesheet the indexer could not read (Spec 45 R5). The
  // rule carries the list as `details.incompleteDefinitions` so "undefined" reads
  // as "not defined in any *read* stylesheet". Degrades to an empty fact with no
  // handle or an absent table — mirroring the legacy `unreadStyleSources` [].
  'unread-style-sources': {
    id: 'unread-style-sources',
    produces: 'unread-style-sources',
    needs: [],
    process(_facts, ctx): UnreadStyleSourceFact[] {
      const ih = ctx?.indexHandle;
      if (!ih) return [];
      let rows: Array<{ file_path: string; reason: string }> = [];
      try {
        rows = ih.query(
          'SELECT file_path, reason FROM style_unread_sources',
        ) as Array<{ file_path: string; reason: string }>;
      } catch {
        // `style_unread_sources` may not exist — degrade to an empty fact.
      }
      return rows.map((r) => ({ filePath: r.file_path, reason: r.reason }));
    },
  } satisfies CorpusProcessor<'unread-style-sources', readonly []>,
} satisfies CorpusProducerMap;

/**
 * The producer that serves `kind` from `format`, or `undefined` when that
 * format cannot supply the concept (which is not a defect — the caller skips
 * the file and §8 reports the rule `notApplicable` for it). The dynamic format
 * in a parsed file is a full {@link Format}, so the lookup is a guarded cast.
 *
 * @param kind - The fact kind whose producer is looked up.
 * @param format - The format the parsed file declares.
 * @returns The producer for `(kind, format)`, or `undefined` when unsupplied.
 */
export function fileProducerFor<K extends FileFactKind>(
  kind: K,
  format: Format,
): FileProcessor<K, SupplyingFormats[K]> | undefined {
  const formats = PRODUCERS[kind] as unknown as Partial<Record<Format, FileProcessor<K, SupplyingFormats[K]>>>;
  return formats[format];
}

/**
 * Spec 69 R1 (criterion 3) — every file processor with no statable oracle,
 * named by its `${kind}.${format}` id with the reason. The run enumerates these
 * so an unprovable fact is reported, never silently assumed complete. The list
 * is static because `oracle` is a static property of the processor contract,
 * not a per-run state: a processor that *could* state an oracle but does not is
 * caught at compile time (the `oracle` field is required), so this is only ever
 * the processors that genuinely have none.
 */
export function noOracleProcessors(): readonly { processor: string; reason: string }[] {
  const out: { processor: string; reason: string }[] = [];
  for (const [kind, formats] of Object.entries(PRODUCERS)) {
    for (const p of Object.values(formats as Record<string, FileProcessor<FileFactKind, any>>)) {
      if (p.oracle.status === 'none') out.push({ processor: p.id, reason: p.oracle.reason });
    }
  }
  return out;
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
  'schema-objects': true,
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
  'call-graph': true,
  'batch-functions': true,
  'hotspot': true,
  'coverage': true,
  'clone-pair-history': true,
  'defined-classes': true,
  'unread-style-sources': true,
} satisfies Record<FactKind, true>;
