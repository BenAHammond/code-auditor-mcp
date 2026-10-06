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
  ResolutionFact,
  ResolutionTable,
  ResolutionClass,
  ResolutionInterface,
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
  ColorValuesFact,
  ReceiverProvenanceFact,
  QuerySiteFact,
  SchemaUsageFact,
  ResolvedQuery,
  LoopQueryFact,
} from './types.js';
import type { IndexHandle } from '../types.js';
import {
  countOracle,
  noOracle,
  countFileSymbols,
  countImports,
  countExportForm,
  countExportSymbols,
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
  countGoPackageBindings,
  countSchemaObjects,
  countDdlOps,
  countCssDeclarations,
  countSecretCandidates,
  countSecurityCandidates,
  countDataAccessCalls,
  countLoopQueries,
  countDynamicSql,
  countQuerySites,
  countSchemaUsage,
  measuredDdlOps,
  measuredStyleDeclarations,
  measuredJsxElements,
  measuredFileImports,
  measuredGoPackageBindings,
  measuredQuerySites,
  measuredSchemaUsageCandidates,
} from './oracles.js';
import { extractFileSymbols } from './fileSymbols.js';
import { extractFunctionIndex } from './functionIndex.js';
import { extractQuerySiteCandidates } from './querySiteCandidates.js';
import { extractReactComponents } from './reactComponents.js';
import { extractFileHeader } from './fileHeader.js';
import { extractCodeBlocks } from './codeBlocks.js';
import { extractBatchFunctions } from './batchFunctions.js';
import { extractJsonDocument } from './jsonDocument.js';
import { buildSchemaValidations } from './schemaValidations.js';
import { extractImports } from './imports.js';
import { extractImportSpecifiers } from './importSpecifiers.js';
import { extractExportSymbols } from './exportSymbols.js';
import { extractExportForm } from './exportForm.js';
import { extractImportForm } from './importForm.js';
import { extractStringLiterals } from './stringLiterals.js';
import { extractSecretCandidates } from './secretCandidates.js';
import { extractSecurityCandidates } from './securityCandidates.js';
import { extractStylesCss } from './stylesCss.js';
import { extractStylesSource } from './stylesSource.js';
import { extractStylesMarkup } from './stylesMarkup.js';
import { extractDataAccessCallCandidates } from './dataAccessCallsCandidates.js';
import { extractLoopQueryRawCandidates } from './loopQueryCandidates.js';
import { extractDynamicSql } from './dynamicSql.js';
import { extractSchemaUsageCandidates } from './schemaUsageCandidates.js';
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
import { extractGoPackageBindings } from './goPackageBindings.js';
import { extractWithinFileProvenance, evidenceToFact } from './withinFileProvenance.js';
import { extractReceiverActivity } from './receiverActivity.js';
import { computeReceiverProvenance } from './receiverProvenance.js';
import { classifyQuerySites, classifySchemaUsage, classifyDataAccessCalls, classifyLoopQueries } from './receiverConsumers.js';
import { extractErrorBindings, extractConcurrencyPrimitives, extractChannelOperations } from './goFunctionAnalysis.js';
import { computeReachability } from './reachability.js';
import { DEFAULT_VIRTUAL_MODULES } from '../graph/importClassification.js';
import { parseColorToRGB, rgbToLab } from './colorMath.js';

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
const querySiteCandidatesProcess = (file: ParsedFile): FactFragment<'query-site-candidates'> => extractQuerySiteCandidates(file as AstFile);
const importsProcess = (file: ParsedFile): FactFragment<'imports'> => extractImports(file as AstFile);
const importSpecifiersProcess = (file: ParsedFile): FactFragment<'import-specifiers'> => extractImportSpecifiers(file as AstFile);
const exportSymbolsProcess = (file: ParsedFile): FactFragment<'export-symbols'> => extractExportSymbols(file as AstFile);
const exportFormProcess = (file: ParsedFile): FactFragment<'export-form'> => extractExportForm(file as AstFile);
const importFormProcess = (file: ParsedFile): FactFragment<'import-form'> => extractImportForm(file);
const stringLiteralsProcess = (file: ParsedFile): FactFragment<'string-literals'> => extractStringLiterals(file as AstFile);
const secretCandidatesProcess = (file: ParsedFile): FactFragment<'secret-candidates'> => extractSecretCandidates(file as AstFile);
const securityCandidatesProcess = (file: ParsedFile): FactFragment<'security-candidates'> => extractSecurityCandidates(file as AstFile);
const ddlProcess = (file: ParsedFile): FactFragment<'ddl-declarations'> => extractSchemaCode(file);
const schemaUsageCandidatesProcess = (file: ParsedFile): FactFragment<'schema-usage-candidates'> =>
  extractSchemaUsageCandidates(file as AstFile);
const schemaObjectsProcess = (file: ParsedFile): FactFragment<'schema-objects'> => extractSchemaObjects(file);
const styleProcess = (file: ParsedFile): FactFragment<'style-declarations'> => [extractStylesCss(file as AstFile)];
const styleSourceProcess = (file: ParsedFile): FactFragment<'style-declarations'> => extractStylesSource(file as AstFile);
const styleMarkupProcess = (file: ParsedFile): FactFragment<'style-declarations'> => extractStylesMarkup(file);
const crossLangProcess = (file: ParsedFile): FactFragment<'cross-language-entities'> =>
  extractCrossLanguageEntities((file as AstFile).ast, file.file, file.source, getLanguageFromPath(file.file));
const dataAccessCandidatesProcess = (file: ParsedFile): FactFragment<'data-access-calls-candidates'> =>
  extractDataAccessCallCandidates(file as AstFile);
const loopQueryCandidatesProcess = (file: ParsedFile): FactFragment<'loop-query-candidates'> =>
  extractLoopQueryRawCandidates(file as AstFile);
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
const goPackageBindingsProcess = (file: ParsedFile): FactFragment<'go-package-bindings'> => extractGoPackageBindings(file as AstFile);
const withinFileProvenanceProcess = (file: ParsedFile): FactFragment<'within-file-provenance'> => extractWithinFileProvenance(file as AstFile);
const receiverActivityProcess = (file: ParsedFile): FactFragment<'receiver-activity'> => extractReceiverActivity(file as AstFile);
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
// regardless of residual size. The split is now 80 counted / 15 none.
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
const WITHIN_FILE_PROVENANCE = noOracle(
  'projects several distinct node families (imports, six function-node types, three class-node types, four propagation-rule node shapes) into six heterogeneous lists, and one named function node contributes to three of them at once (wrapper, returning, local-function) — so no cheap node-type count upper-bounds the total unit count without a weighted per-family multiplier, and any unweighted count either under-bounds (a dead oracle) or counts a different unit (total nodes) than the R1 "same unit" rule allows; the fact is an intermediate projection whose completeness is pinned byte-for-byte by the corpus-level parity assertion against resolveCorpusReceivers, which is the stronger guard',
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
  // Spec 70 Item 4 (step 3) — the un-gated per-file query-site candidates. The
  // `query-sites` corpus producer re-applies the file gate once the
  // `receiver-provenance` fixed point supplies the cross-file seed. Emits one
  // fragment per TS-family file (null-or-value) carrying the located `sites`
  // array, so the oracle counts the site units inside it: `countQuerySites` is
  // the same every-member-call + every-SQL-keyword upper bound the resolved
  // producer used, measured as the summed `sites.length` — not the fragment
  // count (which would be a 1-against-1 empty oracle).
  'query-site-candidates': {
    typescript: fileProducer('query-site-candidates', 'typescript', querySiteCandidatesProcess, countOracle(countQuerySites, measuredQuerySites)),
    tsx: fileProducer('query-site-candidates', 'tsx', querySiteCandidatesProcess, countOracle(countQuerySites, measuredQuerySites)),
    javascript: fileProducer('query-site-candidates', 'javascript', querySiteCandidatesProcess, countOracle(countQuerySites, measuredQuerySites)),
  },
  'imports': {
    typescript: fileProducer('imports', 'typescript', importsProcess, countOracle(countImports)),
    tsx: fileProducer('imports', 'tsx', importsProcess, countOracle(countImports)),
    javascript: fileProducer('imports', 'javascript', importsProcess, countOracle(countImports)),
    go: fileProducer('imports', 'go', goImportsProcess, countOracle(countGoImports)),
  },
  'import-specifiers': {
    typescript: fileProducer('import-specifiers', 'typescript', importSpecifiersProcess, countOracle(countImports)),
    tsx: fileProducer('import-specifiers', 'tsx', importSpecifiersProcess, countOracle(countImports)),
    javascript: fileProducer('import-specifiers', 'javascript', importSpecifiersProcess, countOracle(countImports)),
  },
  'export-symbols': {
    typescript: fileProducer('export-symbols', 'typescript', exportSymbolsProcess, countOracle(countExportSymbols)),
    tsx: fileProducer('export-symbols', 'tsx', exportSymbolsProcess, countOracle(countExportSymbols)),
    javascript: fileProducer('export-symbols', 'javascript', exportSymbolsProcess, countOracle(countExportSymbols)),
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
  // Spec 70 Item 4 (step 3) — the un-gated per-file schema-usage candidates. The
  // `schema-usage` corpus producer re-applies the file gate and re-admits the
  // provenance-dependent references once the `receiver-provenance` fixed point
  // supplies the cross-file seed. Emits one fragment per TS-family file
  // (null-or-value) carrying the five candidate arrays, so the oracle counts the
  // candidate units inside it: `countSchemaUsage` is the same call+string+
  // template upper bound the resolved producer used, measured as the summed
  // candidate lengths — not the fragment count (which would be a 1-against-1
  // empty oracle).
  'schema-usage-candidates': {
    typescript: fileProducer('schema-usage-candidates', 'typescript', schemaUsageCandidatesProcess, countOracle(countSchemaUsage, measuredSchemaUsageCandidates)),
    tsx: fileProducer('schema-usage-candidates', 'tsx', schemaUsageCandidatesProcess, countOracle(countSchemaUsage, measuredSchemaUsageCandidates)),
    javascript: fileProducer('schema-usage-candidates', 'javascript', schemaUsageCandidatesProcess, countOracle(countSchemaUsage, measuredSchemaUsageCandidates)),
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
  // Spec 70 Item 4 (step 3) — the raw, provenance-free candidate half of the
  // `data-access-calls` collapse. Extracted while the AST lives on the
  // empty-provenance scan; the corpus `data-access-calls` producer re-folds the
  // provenance-dependent half (handle verdict → admission + injection gate, site
  // dialect → SQL parse) once the `receiver-provenance` fixed point supplies the
  // seed. The oracle is the same `call_expression` + `template_string` upper bound
  // the resolved-call producer used: every candidate is a call or a tagged
  // template (a variable-assignment candidate is a `variable_declaration`, the same
  // residual the old producer carried).
  'data-access-calls-candidates': {
    typescript: fileProducer('data-access-calls-candidates', 'typescript', dataAccessCandidatesProcess, countOracle(countDataAccessCalls)),
    tsx: fileProducer('data-access-calls-candidates', 'tsx', dataAccessCandidatesProcess, countOracle(countDataAccessCalls)),
    javascript: fileProducer('data-access-calls-candidates', 'javascript', dataAccessCandidatesProcess, countOracle(countDataAccessCalls)),
    go: fileProducer('data-access-calls-candidates', 'go', dataAccessCandidatesProcess, countOracle(countDataAccessCalls)),
  },
  // Spec 70 Item 4 (step 3) — the raw, provenance-free candidate half of the
  // `loop-queries` collapse. No dedup and no symbol happen here (both depend on
  // the re-folded handle set); the corpus `loop-queries` producer re-folds the
  // strict-handle filter, dedups by loop byte-offset, and assigns the symbol.
  'loop-query-candidates': {
    typescript: fileProducer('loop-query-candidates', 'typescript', loopQueryCandidatesProcess, countOracle(countLoopQueries)),
    tsx: fileProducer('loop-query-candidates', 'tsx', loopQueryCandidatesProcess, countOracle(countLoopQueries)),
    javascript: fileProducer('loop-query-candidates', 'javascript', loopQueryCandidatesProcess, countOracle(countLoopQueries)),
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
  // Spec 70 Item 4 (2a) — the per-file Go package-scope symbol table. The
  // cross-file receiver-provenance fixed point groups these by directory and
  // merges first-wins. The oracle is the *pre-dedup* binding-declaration count
  // (top-level function/method/type/var declarations with a name) — the same
  // number `buildGoFileBindings` emits before its first-wins dedup, which is a
  // no-op within a single valid Go file, so it bounds the deduped
  // `bindings.length` exactly.
  'go-package-bindings': {
    go: fileProducer('go-package-bindings', 'go', goPackageBindingsProcess, countOracle(countGoPackageBindings, measuredGoPackageBindings)),
  },
  // Spec 70 Item 4 (2a) — the per-file within-file-provenance projection. The
  // extract half of the TS/Go split; the corpus `receiver-provenance` fixed
  // point rehydrates it with no AST. Completeness is pinned by the parity
  // assertion (classify(extract) ≡ compute), not by a per-file node count, so
  // the oracle is a `none` (see WITHIN_FILE_PROVENANCE).
  'within-file-provenance': {
    typescript: fileProducer('within-file-provenance', 'typescript', withinFileProvenanceProcess, WITHIN_FILE_PROVENANCE),
    tsx: fileProducer('within-file-provenance', 'tsx', withinFileProvenanceProcess, WITHIN_FILE_PROVENANCE),
    javascript: fileProducer('within-file-provenance', 'javascript', withinFileProvenanceProcess, WITHIN_FILE_PROVENANCE),
    go: fileProducer('within-file-provenance', 'go', withinFileProvenanceProcess, WITHIN_FILE_PROVENANCE),
  },
  // Spec 70 Item 4 (step 3) — the per-file receiver-resolution inputs (bindings +
  // R3 sites + DB activity) the corpus-side `dbProvenanced` re-derivation reads.
  // Emits exactly one fragment per TS-family file (null-or-value), so the oracle
  // is the single-object one; completeness is pinned by the corpus parity assertion
  // against `buildProvenanceContext`, not by a per-file count.
  'receiver-activity': {
    typescript: fileProducer('receiver-activity', 'typescript', receiverActivityProcess, SINGLE_OBJECT),
    tsx: fileProducer('receiver-activity', 'tsx', receiverActivityProcess, SINGLE_OBJECT),
    javascript: fileProducer('receiver-activity', 'javascript', receiverActivityProcess, SINGLE_OBJECT),
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
// `resolution` and `migration-history` reduce the `ddl-declarations` fact
// through the ONE shared `replayDdlDeclarations` — so the known-table set and
// the drop provenance can never disagree about which table a migration dropped.
// `needs` forms the DAG edges ddl-declarations → {resolution,
// migration-history}. Corpus producers are a separate map because the
// (kind, format) key cannot express a derived fact.

export const CORPUS_PRODUCERS = {
  'resolution': {
    id: 'resolution',
    produces: 'resolution',
    needs: ['ddl-declarations', 'schema-objects', 'file-symbols'],
    process(facts, ctx?): ResolutionFact {
      // The known-table set is the *net* set after replaying DDL across files
      // in migration order — a table dropped in a later migration is a stale
      // reference, not a known table. `replayDdlDeclarations` returns that net
      // set with each table's last-CREATE source file, its columns, and its four
      // per-column constraint maps (UNIQUE, PRIMARY KEY, NOT NULL, foreign key)
      // recorded *separately* so PK and natural UNIQUE stay distinguishable.
      const { netTables } = replayDdlDeclarations(
        facts['ddl-declarations'].map((d) => ({
          filePath: d.file,
          ops: d.ops,
          tableColumns: d.tableColumns,
          uniqueColumns: d.uniqueColumns,
          primaryKeyColumns: d.primaryKeyColumns,
          notNullColumns: d.notNullColumns,
          foreignKeys: d.foreignKeys,
        })),
      );
      const tables: ResolutionTable[] = netTables.map((t) => {
        const pk = new Set(t.primaryKeyColumns.map((c) => c.toLowerCase()));
        const uniq = new Set(t.uniqueColumns.map((c) => c.toLowerCase()));
        const nn = new Set(t.notNullColumns.map((c) => c.toLowerCase()));
        const fk = new Map<string, { table: string; column: string }>();
        for (const ref of t.foreignKeys) {
          if (!fk.has(ref.column.toLowerCase())) fk.set(ref.column.toLowerCase(), { table: ref.refTable, column: ref.refColumn });
        }
        const columns = t.columns.map((c) => ({
          name: c,
          primaryKey: pk.has(c.toLowerCase()),
          unique: uniq.has(c.toLowerCase()),
          notNull: nn.has(c.toLowerCase()),
          foreignKey: fk.get(c.toLowerCase()) ?? null,
        }));
        return { name: t.name, source: t.source, columns };
      });
      // §5 parity: merge the config-declared external tables the legacy schema
      // reducer added to the known-table set (`knownTables` + `schemas`). Without
      // them a config-only schema is a 0-table catalog and `unknown-table`'s
      // fail-open guard silently never fires — exactly the sql-cte regression.
      // Config-declared tables carry no column metadata, so no constraints.
      for (const t of ctx?.externalTables ?? []) {
        tables.push({
          name: t.name,
          source: t.source,
          columns: t.columns.map((c) => ({ name: c, primaryKey: false, unique: false, notNull: false, foreignKey: null })),
        });
      }
      // The ORM schema-object alias map: `.from(sampleOwnership)` names the JS
      // identifier, not the SQL table. Resolve it through the pgTable/mysqlTable/
      // sqliteTable bindings so a query referencing a schema object reaches the
      // catalog entry (and Tier-3 tenancy) the identifier declares. The `.unique()`
      // and `.primaryKey()` markers are merged into the matching table's columns
      // as *separate* `unique` / `primaryKey` flags (both JS and SQL spelling), so
      // the natural-UNIQUE quiet set and the PK surface never collapse into one.
      const aliases: Record<string, string> = {};
      for (const obj of facts['schema-objects']) {
        if (!(obj.identifier in aliases)) aliases[obj.identifier] = obj.table;
        const entry = tables.find((t) => t.name === obj.table);
        if (!entry) continue;
        const merged = [...entry.columns];
        for (const name of obj.uniqueColumns) {
          const key = name.toLowerCase();
          const existing = merged.find((c) => c.name.toLowerCase() === key);
          if (existing) existing.unique = true;
          else merged.push({ name, primaryKey: false, unique: true, notNull: false, foreignKey: null });
        }
        for (const name of obj.primaryKeyColumns) {
          const key = name.toLowerCase();
          const existing = merged.find((c) => c.name.toLowerCase() === key);
          if (existing) existing.primaryKey = true;
          else merged.push({ name, primaryKey: true, unique: false, notNull: false, foreignKey: null });
        }
        entry.columns = merged;
      }
      // Class/interface declarations → what they extend/implements, resolved in
      // repo (Spec 69 R3 criterion 7c). `open-closed` reads these instead of
      // walking the `file-symbols` classes itself.
      const classes: ResolutionClass[] = [];
      const interfaces: ResolutionInterface[] = [];
      for (const sym of facts['file-symbols']) {
        if (sym.kind === 'class') {
          classes.push({
            name: sym.name,
            file: sym.file,
            extends: sym.extends ?? null,
            implements: [...(sym.implements ?? [])],
          });
        } else if (sym.kind === 'interface') {
          interfaces.push({ name: sym.name, file: sym.file, extends: [...(sym.extends ?? [])] });
        }
      }
      return { tables, aliases, classes, interfaces };
    },
  } satisfies CorpusProcessor<'resolution', readonly ['ddl-declarations', 'schema-objects', 'file-symbols']>,
  // `migration-history` reduces the DDL declarations into the cross-file drop
  // provenance (dropped-table → dropping migration + what it created). `needs`
  // forms the DAG edge ddl-declarations → migration-history, parallel to
  // resolution. The provenance is the same `replayDdlDeclarations` pass the
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
  // `color-values` reduces the `style-declarations` fact into the CIELAB-converted
  // color set the `styles/value-drift` rule reads (Spec 69 R4). The conversion —
  // raw string → sRGB → Lab — was the one computation R4 found still living in a
  // rule body; it moves here so the rule's clustering and flagging read
  // pre-computed Lab triples and never re-parse a color. `needs` forms the DAG
  // edge style-declarations → color-values.
  'color-values': {
    id: 'color-values',
    produces: 'color-values',
    needs: ['style-declarations'],
    process(facts): ColorValuesFact[] {
      const out: ColorValuesFact[] = [];
      for (const f of facts['style-declarations']) {
        for (const d of f.declarations) {
          const rgb = parseColorToRGB(d.rawValue);
          if (!rgb) continue;
          out.push({
            property: d.property,
            filePath: d.filePath,
            line: d.line,
            rawValue: d.rawValue,
            normalizedValue: d.normalizedValue ? JSON.stringify(d.normalizedValue) : null,
            rgb,
            lab: rgbToLab(rgb),
          });
        }
      }
      return out;
    },
  } satisfies CorpusProcessor<'color-values', readonly ['style-declarations']>,
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
  // `call-graph` (§2.2) — the function catalog + call edges the cross-domain
  // rules' depth-1 callee expansion reads. The functions and `callEdges` remain
  // index reads (`functions` + `graph_cache`), per "reading the index is always
  // fine" — re-deriving the edges here from `functionCalls` would turn on the
  // depth-1 expansion during a plain audit (the sync-only `graph_cache` is empty
  // there), moving `multi-table-write`. Only `usedImports` moves (Item 4 2b): it
  // was the one field the index column could not supply without the sync path's
  // second parse, so it now comes from the `function-index` fact, joined by the
  // `(file, name, line)` identity the index conflictKey uses.
  'call-graph': {
    id: 'call-graph',
    produces: 'call-graph',
    needs: ['function-index'],
    process(facts, ctx): CallGraphFact {
      const usedImportsByFn = new Map<string, readonly string[]>();
      for (const f of facts['function-index']) {
        usedImportsByFn.set(`${f.file}::${f.name}::${f.line}`, f.usedImports);
      }
      const ih: IndexHandle | undefined = ctx?.indexHandle;
      if (!ih) return { functions: [], callEdges: [] };
      let funcs: Array<{ id: number; name: string; file_path: string; line_number: number | null; is_exported: number }> = [];
      let edges: Array<{ node_key: string; neighbor_key: string }> = [];
      try {
        funcs = ih.query('SELECT id, name, file_path, line_number, is_exported FROM functions') as Array<{ id: number; name: string; file_path: string; line_number: number | null; is_exported: number }>;
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
          usedImports: usedImportsByFn.get(`${f.file_path}::${f.name}::${f.line_number}`) ?? [],
          isExported: f.is_exported === 1,
        })),
        callEdges,
      };
    },
  } satisfies CorpusProcessor<'call-graph', readonly ['function-index']>,
  // `hotspot` (R4 uncovered-risk) — the `hotspot_scores` rows the uncovered-risk
  // ranking LEFT-JOINs on (target = file_path || ':' || name, type = 'function').
  'hotspot': {
    id: 'hotspot',
    produces: 'hotspot',
    needs: [],
    process(_facts, ctx): HotspotFact[] {
      const ih: IndexHandle | undefined = ctx?.indexHandle;
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
      const ih: IndexHandle | undefined = ctx?.indexHandle;
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
      const ih: IndexHandle | undefined = ctx?.indexHandle;
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
  // `defined-classes` (styles/undefined-class) — re-derived from the
  // `style-declarations` phase fact rather than the `style_defined_classes`
  // index table (Item 4 2b: style-declarations → defined-classes). Every writer
  // of `style_defined_classes` (source CSS-in-JS, compiled CSS, other extractable
  // files) derives the class name by the SAME regex `/\.([a-zA-Z0-9_-]+)/g` over
  // the declaration's selector `context`, so the phase fact reproduces the table
  // byte-for-byte: group by class name, keep MIN(file_path). `context`/`filePath`
  // are plain data already on `StylesDeclaration`.
  //
  // Parity notes: (1) the index producer's MIN(file_path) used SQLite BINARY
  // collation (UTF-8 byte order); JS `<` is UTF-16 code-unit order — identical
  // for the ASCII paths these corpora use. (2) The catalog is sorted by
  // `className` so the undefined-class near-miss tie-break (`dist < bestDist`,
  // styles.ts) sees the same iteration order the `GROUP BY class_name` index scan
  // produced (ascending class_name). Membership lookups are order-independent.
  'defined-classes': {
    id: 'defined-classes',
    produces: 'defined-classes',
    needs: ['style-declarations'],
    process(facts): DefinedClassesFact[] {
      const byClass = new Map<string, string>(); // className -> MIN(file_path)
      for (const f of facts['style-declarations']) {
        for (const d of f.declarations) {
          const ctx = d.context;
          if (!ctx) continue;
          for (const m of ctx.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
            const className = m[1];
            const fp = d.filePath;
            const prev = byClass.get(className);
            if (prev === undefined || fp < prev) byClass.set(className, fp);
          }
        }
      }
      return [...byClass.entries()]
        .map(([className, filePath]) => ({ className, filePath }))
        .sort((a, b) => (a.className < b.className ? -1 : a.className > b.className ? 1 : 0));
    },
  } satisfies CorpusProcessor<'defined-classes', readonly ['style-declarations']>,
  // `unread-style-sources` (styles/undefined-class) — the content-level
  // `<style lang="…">` reasons, flattened from the markup producer's
  // `style-declarations` fact (`extractStylesMarkup` collects them into each
  // file's `unreadSources` during its `extractDeclarations` pass). One entry per
  // markup file whose embedded style block uses a dialect the regex path cannot
  // read (Spec 45 R5). The rule carries the list as
  // `details.incompleteDefinitions` so "undefined" reads as "not defined in any
  // *read* stylesheet". The walk-level reasons (`.less`/`.styl`/`.sass`
  // dialects, read failures, unknown extensions) are produced by the traverse
  // phase and merged ahead of this in `buildFacts`; this producer contributes
  // only the content-level half. Degrades to an empty fact when no markup file
  // carries an unread embedded block.
  'unread-style-sources': {
    id: 'unread-style-sources',
    produces: 'unread-style-sources',
    needs: ['style-declarations'],
    process(facts): UnreadStyleSourceFact[] {
      const seen = new Set<string>();
      const out: UnreadStyleSourceFact[] = [];
      for (const f of facts['style-declarations']) {
        for (const s of f.unreadSources) {
          if (seen.has(s.filePath)) continue;
          seen.add(s.filePath);
          out.push(s);
        }
      }
      return out;
    },
  } satisfies CorpusProcessor<'unread-style-sources', readonly ['style-declarations']>,
  // `receiver-provenance` (Spec 70 Item 4, 2a) — the cross-file DB-receiver
  // provenance fixed point, re-derived from the four additive file facts with no
  // AST. This is the phase-side replacement for `resolveCorpusReceivers`'
  // `fileProvenance` + `unresolvedImports` halves. `needs` forms the DAG edges
  // {within-file-provenance, import-specifiers, export-symbols,
  // go-package-bindings} → receiver-provenance. The core (`computeReceiverProvenance`)
  // returns the legacy `FileProvenance`/`FileExports`/`UnresolvedImport` types so
  // the parity assertion can diff it byte-for-byte against `resolveReceiverProvenance`;
  // the fact itself projects only the two consumer-facing halves (`files` +
  // `unresolvedImports`), dropping the Phase-2 `fileExports` intermediate no
  // consumer reads.
  'receiver-provenance': {
    id: 'receiver-provenance',
    produces: 'receiver-provenance',
    needs: ['within-file-provenance', 'import-specifiers', 'export-symbols', 'go-package-bindings'],
    process(facts, ctx?): ReceiverProvenanceFact {
      const { fileProvenance, unresolvedImports } = computeReceiverProvenance(
        facts['within-file-provenance'],
        facts['import-specifiers'],
        facts['export-symbols'],
        facts['go-package-bindings'],
        ctx?.projectRoot,
      );
      return {
        files: [...fileProvenance.entries()].map(([file, prov]) => ({
          file,
          provenance: [...prov.values()].map(evidenceToFact),
        })),
        unresolvedImports: unresolvedImports.map((u) => ({ importer: u.importer, source: u.source, names: u.names })),
      };
    },
  } satisfies CorpusProcessor<'receiver-provenance', readonly ['within-file-provenance', 'import-specifiers', 'export-symbols', 'go-package-bindings']>,
  // Spec 70 Item 4 (step 3) — the first of the four receiver consumers converted
  // to a corpus producer. The legacy `query-sites` producer did two jobs: locate
  // each DB-query site (a provenance-free text + function scan) and gate the file
  // on DB context (`passesFileGate`, which needs the cross-file `dbProvenanced`
  // seed). The collapse splits them: `query-site-candidates` runs the location
  // job un-gated while the AST lives, and this producer re-derives each file's
  // `dbProvenanced` (via `classifyBuildProvenance`) from the `within-file-provenance`
  // extract + the `receiver-provenance` fixed point + the `receiver-activity`
  // inputs, then re-applies the gate. `needs` forms the DAG edges
  // {query-site-candidates, within-file-provenance, receiver-provenance,
  // receiver-activity} → query-sites.
  'query-sites': {
    id: 'query-sites',
    produces: 'query-sites',
    needs: ['query-site-candidates', 'within-file-provenance', 'receiver-provenance', 'receiver-activity'],
    process(facts, ctx): QuerySiteFact[] {
      return classifyQuerySites(
        facts['query-site-candidates'],
        facts['within-file-provenance'],
        facts['receiver-provenance'],
        facts['receiver-activity'],
        ctx?.sqlDialect ?? null,
      );
    },
  } satisfies CorpusProcessor<'query-sites', readonly ['query-site-candidates', 'within-file-provenance', 'receiver-provenance', 'receiver-activity']>,
  // Spec 70 Item 4 (step 3) — the second of the four receiver consumers. The
  // legacy `schema-usage` producer ran `findTableReferences` (six strategies) and
  // re-homed each reference. The collapse splits it: `schema-usage-candidates`
  // extracts the provenance-free references (ORM / query-builder /
  // collection-adapter, already re-homed) plus raw tagged/DB-call candidates while
  // the AST lives, and this producer re-derives each file's `dbProvenanced` (via
  // `classifyBuildProvenance`), re-applies the gate, re-admits the two
  // provenance-dependent strategies (`identifyHandle` over the re-derived
  // provenance), and re-homes their references from the projected function +
  // string-fragment spans. `needs` forms the DAG edges {schema-usage-candidates,
  // within-file-provenance, receiver-provenance, receiver-activity} →
  // schema-usage.
  'schema-usage': {
    id: 'schema-usage',
    produces: 'schema-usage',
    needs: ['schema-usage-candidates', 'within-file-provenance', 'receiver-provenance', 'receiver-activity'],
    process(facts, ctx): SchemaUsageFact[] {
      return classifySchemaUsage(
        facts['schema-usage-candidates'],
        facts['within-file-provenance'],
        facts['receiver-provenance'],
        facts['receiver-activity'],
        ctx?.sqlDialect ?? null,
      );
    },
  } satisfies CorpusProcessor<'schema-usage', readonly ['schema-usage-candidates', 'within-file-provenance', 'receiver-provenance', 'receiver-activity']>,
  // Spec 70 Item 4 (step 3) — the third of the four receiver consumers. The
  // legacy `data-access-calls` producer did two jobs: extract the resolved DB
  // calls (an AST scan) and fold the provenance-dependent half of
  // `buildDatabaseCall` (the `identifyHandle` admission verdict → the injection
  // gate, and the per-site dialect → the SQL parse) over the cross-file
  // `dbProvenanced` seed. The collapse splits them: `data-access-calls-candidates`
  // extracts the provenance-free half while the AST lives, and this producer
  // re-derives each file's `dbProvenanced` (TS via `classifyBuildProvenance`; Go
  // via the fixed-point seed) and re-folds the discovery filter → line dedup →
  // `buildDatabaseCall` with no AST. `needs` forms the DAG edges
  // {data-access-calls-candidates, within-file-provenance, receiver-provenance,
  // receiver-activity} → data-access-calls.
  'data-access-calls': {
    id: 'data-access-calls',
    produces: 'data-access-calls',
    needs: ['data-access-calls-candidates', 'within-file-provenance', 'receiver-provenance', 'receiver-activity'],
    process(facts, ctx): ResolvedQuery[] {
      return classifyDataAccessCalls(
        facts['data-access-calls-candidates'],
        facts['within-file-provenance'],
        facts['receiver-provenance'],
        facts['receiver-activity'],
        ctx?.sqlDialect ?? null,
      );
    },
  } satisfies CorpusProcessor<'data-access-calls', readonly ['data-access-calls-candidates', 'within-file-provenance', 'receiver-provenance', 'receiver-activity']>,
  // Spec 70 Item 4 (step 3) — the fourth of the four receiver consumers. The
  // legacy `loop-queries` producer ran `collectLoopQueryCandidates` (discovery +
  // provenance-free discriminators + strict-handle filter + loop dedup + symbol)
  // over the AST. The collapse splits it: `loop-query-candidates` runs the
  // discovery + provenance-free discriminators while the AST lives, and this
  // producer re-derives `dbProvenanced` and re-folds the strict-handle filter,
  // the per-loop dedup, and the stable symbol with no AST.
  'loop-queries': {
    id: 'loop-queries',
    produces: 'loop-queries',
    needs: ['loop-query-candidates', 'within-file-provenance', 'receiver-provenance', 'receiver-activity'],
    process(facts, ctx): LoopQueryFact[] {
      return classifyLoopQueries(
        facts['loop-query-candidates'],
        facts['within-file-provenance'],
        facts['receiver-provenance'],
        facts['receiver-activity'],
        ctx?.sqlDialect ?? null,
      );
    },
  } satisfies CorpusProcessor<'loop-queries', readonly ['loop-query-candidates', 'within-file-provenance', 'receiver-provenance', 'receiver-activity']>,
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
 *
 * @returns The `${kind}.${format}` id and reason for every oracle-less processor.
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
  'query-sites': true,
  'query-site-candidates': true,
  'imports': true,
  'import-specifiers': true,
  'export-symbols': true,
  'export-form': true,
  'import-form': true,
  'string-literals': true,
  'secret-candidates': true,
  'security-candidates': true,
  'ddl-declarations': true,
  'schema-usage': true,
  'schema-usage-candidates': true,
  'schema-objects': true,
  'style-declarations': true,
  'color-values': true,
  'cross-language-entities': true,
  'data-access-calls': true,
  'data-access-calls-candidates': true,
  'loop-queries': true,
  'loop-query-candidates': true,
  'dynamic-sql': true,
  'resolution': true,
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
  'go-package-bindings': true,
  'within-file-provenance': true,
  'receiver-activity': true,
  'receiver-provenance': true,
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
