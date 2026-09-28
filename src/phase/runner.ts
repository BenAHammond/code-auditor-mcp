/**
 * Spec 68 §3.2 vertical slice — the phase runner: Parse → Process → Analyze.
 *
 * This is the in-process proof of the phase model for ONE fact kind
 * (`file-symbols`) and its SOLID rules. It is deliberately not the full §6
 * distributed runner (bounded work queue, parent/worker, index-backed facts);
 * that lands in §6. What this proves, once, is the contract the whole model
 * turns on:
 *
 *   - Parse produces a `ParsedFile` whose `ast` lives only here (it is freed
 *     after the processor runs and never crosses the Process→Analyze boundary).
 *   - Process runs the `file-symbols` producer per file and concatenates the
 *     fragments into the corpus-wide `file-symbols` fact.
 *   - Analyze hands that fact — and nothing else — to each SOLID rule, whose
 *     `analyze` is pure threshold comparison over plain data.
 *
 * §6 replaces the parse loop with fan-out and the `thresholds` literal with
 * resolved config; the three-phase ordering and the "rules read facts, never
 * ASTs" property are already fixed here.
 */

import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { STYLE_MARKUP_EXTENSIONS } from '../utils/fileDiscovery.js';
import { fileProducerFor, CORPUS_PRODUCERS } from './producers.js';
import { solidRules } from './rules/solid.js';
import { dataAccessRules, loopQueryRules } from './rules/dataAccess.js';
import { schemaRules, dynamicSqlRules } from './rules/schema.js';
import { dependencyGraphRules } from './rules/dependencyGraph.js';
import { schemaValidatorRules } from './rules/schemaValidator.js';
import { documentationRules } from './rules/documentation.js';
import { stylesRules } from './rules/styles.js';
import { crossDomainRules } from './rules/crossDomain.js';
import { conventionsRules, conventionsExportShapeRules, conventionsImportFormRules } from './rules/conventions.js';
import { dryRules } from './rules/dry.js';
import { securityRules } from './rules/security.js';
import { secretsRules } from './rules/secrets.js';
import { securityDefectRules } from './rules/securityDefects.js';
import { functionBodyRules } from './rules/functionBodies.js';
import { reactRules } from './rules/react.js';
import { fileDocumentationRules } from './rules/fileDocumentation.js';
import { schemaJsonRules } from './rules/schemaJson.js';
import type {
  ParsedFile,
  FileSymbols,
  ResolvedQuery,
  LoopQueryFact,
  DynamicSqlFact,
  SchemaUsageFact,
  SchemaDeclaration,
  SchemaObject,
  TableCatalog,
  MigrationHistory,
  Entity,
  Format,
  ThresholdValues,
  Finding,
  RuleDefinition,
  StyleDeclarationsFile,
  FunctionIndexFact,
  MinedConvention,
  ExportFormFact,
  ImportFormFact,
  ImportFact,
  StringLiteralFact,
  SecretCandidate,
  SecurityCandidate,
  FunctionBodyFact,
  ReactComponentScan,
  FileHeaderFact,
  CodeBlockFact,
  JsonDocumentFact,
  SchemaValidationFact,
  TypeDeclarationsFact,
  GoFunctionFact,
  GoSwitchFact,
} from './types.js';

/** A file to parse, with its source already read (the CLI reads it in §11). */
export type InputFile = { readonly path: string; readonly content: string };

/**
 * The format a path declares, by extension (matches the liveness fixtures).
 *
 * @param path - The file path whose extension determines the format.
 * @returns The `Format` the path declares.
 */
export function formatFor(path: string): Format {
  if (path.endsWith('.tsx') || path.endsWith('.jsx')) return 'tsx';
  if (path.endsWith('.js')) return 'javascript';
  if (path.endsWith('.go')) return 'go';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.scss')) return 'scss';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.sql')) return 'sql';
  const ext = path.slice(path.lastIndexOf('.'));
  if (STYLE_MARKUP_EXTENSIONS.includes(ext)) return 'markup';
  return 'typescript';
}

/**
 * Parse one file into a `ParsedFile`. Uses `adapter.parse()` (not the sync
 * bridge) so the adapter's source map is populated — `extractFunctions` /
 * `extractClasses` read the real source through it. Returns `null` when no
 * adapter resolves the path or the parse fails; the caller records the drop
 * (§3.3 makes a per-file failure `incomplete`, which is §8's concern).
 *
 * @param input - The file to parse (path + already-read content).
 * @param projectRoot - The optional project root threaded into the parsed file.
 * @returns The parsed file, or `null` when no adapter resolves or the parse fails.
 */
export async function parseOne(input: InputFile, projectRoot?: string): Promise<ParsedFile | null> {
  // `.sql` and markup (`.astro`/`.vue`/`.svelte`/`.html`) are the text-only
  // formats: no grammar, no adapter, no AST. Their sole producers
  // (ddl-declarations, style-declarations) read `.source`/`.file`, so return a
  // ParsedFile with neither `ast` nor `adapter`.
  const format = formatFor(input.path);
  if (format === 'sql' || format === 'markup') {
    return { file: input.path, format, source: input.content, ...(projectRoot ? { projectRoot } : {}) };
  }
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(input.path);
  if (!adapter) return null;
  try {
    const ast = await adapter.parse(input.path, input.content);
    return {
      file: input.path,
      format: formatFor(input.path),
      source: input.content,
      ast,
      adapter,
      ...(projectRoot ? { projectRoot } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Parse → Process for the `file-symbols` fact. Returns the assembled corpus
 * fact (every symbol from every file, files' ASTs already freed).
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `file-symbols` corpus fact.
 */
export async function buildFileSymbols(files: readonly InputFile[]): Promise<FileSymbols[]> {
  const symbols: FileSymbols[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('file-symbols', parsed.format);
      if (producer) symbols.push(...producer.process(parsed));
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return symbols;
}

/**
 * Run one rule array over an assembled fact context and collect its findings.
 * Every `analyzeX` slice reduces to this single loop — the only per-slice
 * difference is which rules, facts, and formats are handed in — so the loop
 * lives here once instead of being duplicated across the ~19 analyze arms.
 *
 * @param rules - The rule array to run.
 * @param facts - The assembled fact context (declared `needs`, union-shaped).
 * @param formats - The format union the rules may read.
 * @param thresholds - The resolved thresholds (defaults to `{}`).
 * @returns The rules' findings over the facts.
 */
async function analyzeWithRules(
  rules: readonly RuleDefinition<any>[],
  facts: Record<string, unknown>,
  formats: readonly Format[],
  thresholds: ThresholdValues,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const rule of rules) {
    findings.push(...(await rule.analyze({ facts, formats, thresholds } as never)));
  }
  return findings;
}

/** Analyze the assembled `file-symbols` fact with the SOLID rules. The union
 *  context carries the §9 Go facts as `[]` and widens `formats` to include `go`
 *  so the Go arms (`interface-size`'s Go branch, `struct-size`, `function-size`,
 *  `switch-size`, `liskov-substitution`) reduce an empty fact in this TS-only
 *  slice rather than a missing one — they produce nothing because there are no
 *  Go files here.
 *
 *  @param symbols - The assembled `file-symbols` fact to analyze.
 *  @param thresholds - The SOLID rule thresholds (defaults to `{}`).
 *  @returns The SOLID rules' findings over the fact.
 */
export async function analyzeFileSymbols(symbols: FileSymbols[], thresholds: ThresholdValues = {}): Promise<Finding[]> {
  return analyzeWithRules(solidRules, {
    'file-symbols': symbols,
    'type-declarations': [] as TypeDeclarationsFact[],
    'go-functions': [] as GoFunctionFact[],
    'go-switches': [] as GoSwitchFact[],
  }, ['typescript', 'tsx', 'javascript', 'go'], thresholds);
}

/** The whole vertical slice: parse → file-symbols → SOLID rules → findings. */
export async function runFileSymbolsSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const symbols = await buildFileSymbols(files);
  return analyzeFileSymbols(symbols, thresholds);
}

// ── documentation slice (same fact, different rules) ─────────────────────────

/**
 * Analyze the assembled `file-symbols` fact with the documentation rules.
 *
 * @param symbols - The assembled `file-symbols` fact to analyze.
 * @param thresholds - The documentation rule thresholds (defaults to `{}`).
 * @returns The documentation rules' findings over the fact.
 */
export async function analyzeDocumentation(symbols: FileSymbols[], thresholds: ThresholdValues = {}): Promise<Finding[]> {
  return analyzeWithRules(documentationRules, { 'file-symbols': symbols }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/** The documentation slice: parse → file-symbols → documentation rules → findings. */
export async function runDocumentationSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const symbols = await buildFileSymbols(files);
  return analyzeDocumentation(symbols, thresholds);
}

// ── data-access-calls slice (the "repeat" for a second fact kind) ──────────

/**
 * Parse → Process for the `data-access-calls` fact. Returns the assembled
 * corpus fact (every resolved DB call from every file, ASTs already freed).
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `data-access-calls` corpus fact.
 */
export async function buildDataAccessCalls(files: readonly InputFile[]): Promise<ResolvedQuery[]> {
  const calls: ResolvedQuery[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('data-access-calls', parsed.format);
      if (producer) calls.push(...producer.process(parsed));
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return calls;
}

/** Analyze the assembled `data-access-calls` + `table-catalog` facts with the
 *  data-access rules. `missing-org-filter` reads the catalog for Tier 3 (DDL)
 *  tenancy; the other three rules ignore it (their `needs` declare only
 *  `data-access-calls`, and the union context carries both).
 *
 *  @param calls - The assembled `data-access-calls` fact to analyze.
 *  @param catalog - The known-table catalog (`missing-org-filter` reads it).
 *  @param thresholds - The data-access rule thresholds (defaults to `{}`).
 *  @returns The data-access rules' findings over the facts.
 */
export async function analyzeDataAccessCalls(
  calls: ResolvedQuery[],
  catalog: TableCatalog,
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(dataAccessRules, { 'data-access-calls': calls, 'table-catalog': catalog }, ['typescript', 'tsx', 'javascript', 'go'], thresholds);
}

/**
 * The data-access slice: parse → data-access-calls + table-catalog → rules → findings.
 *
 * @param files - The input files to parse and process.
 * @param thresholds - The data-access rule thresholds (defaults to `{}`).
 * @returns The data-access rules' findings over the assembled facts.
 */
export async function runDataAccessSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const [calls, catalog] = await Promise.all([
    buildDataAccessCalls(files),
    buildTableCatalog(files),
  ]);
  return analyzeDataAccessCalls(calls, catalog, thresholds);
}

// ── loop-queries slice (loop-queries → loop-query) ──────────────────────────

/**
 * Parse → Process for the `loop-queries` fact. Returns the assembled corpus
 * fact (every loop whose body issues a DB call, ASTs already freed). The fact
 * carries no cross-file structure — the `loop-query` rule reduces each element
 * in isolation, exactly as the legacy `checkLoopQueries` ran once per AST.
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `loop-queries` corpus fact.
 */
export async function buildLoopQueries(files: readonly InputFile[]): Promise<LoopQueryFact[]> {
  const facts: LoopQueryFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('loop-queries', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as LoopQueryFact[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Analyze the assembled `loop-queries` fact with the loop-query rule.
 *
 * @param facts - The assembled `loop-queries` fact to analyze.
 * @param thresholds - The loop-query rule thresholds (defaults to `{}`).
 * @returns The loop-query rule's findings over the fact.
 */
export async function analyzeLoopQueries(
  facts: LoopQueryFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(loopQueryRules, { 'loop-queries': facts }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/** The loop-queries slice: parse → loop-queries → loop-query → findings. */
export async function runLoopQueriesSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const facts = await buildLoopQueries(files);
  return analyzeLoopQueries(facts, thresholds);
}

// ── dynamic-sql slice (dynamic-sql → dynamic-sql-construction) ──────────────

/**
 * Parse → Process for the `dynamic-sql` fact. Returns the assembled corpus
 * fact (every dangerous query/execute call site, ASTs already freed). The fact
 * carries no cross-file structure — the `dynamic-sql-construction` rule reduces
 * each element in isolation, exactly as the legacy `checkSQLInjection` ran once
 * per AST.
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `dynamic-sql` corpus fact.
 */
export async function buildDynamicSql(files: readonly InputFile[]): Promise<DynamicSqlFact[]> {
  const facts: DynamicSqlFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('dynamic-sql', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as DynamicSqlFact[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Analyze the assembled `dynamic-sql` fact with the dynamic-sql-construction rule.
 *
 * @param facts - The assembled `dynamic-sql` fact to analyze.
 * @param thresholds - The dynamic-sql rule thresholds (defaults to `{}`).
 * @returns The dynamic-sql-construction rule's findings over the fact.
 */
export async function analyzeDynamicSql(
  facts: DynamicSqlFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(dynamicSqlRules, { 'dynamic-sql': facts }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/** The dynamic-sql slice: parse → dynamic-sql → dynamic-sql-construction → findings. */
export async function runDynamicSqlSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const facts = await buildDynamicSql(files);
  return analyzeDynamicSql(facts, thresholds);
}

// ── schema slice (the "repeat" for a corpus-consuming fact kind) ────────────

/**
 * Parse → Process for the `schema-usage` fact. Returns the assembled corpus
 * fact (every table reference from every file, ASTs already freed).
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `schema-usage` corpus fact.
 */
export async function buildSchemaUsage(files: readonly InputFile[]): Promise<SchemaUsageFact[]> {
  const usages: SchemaUsageFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('schema-usage', parsed.format);
      if (producer) usages.push(...producer.process(parsed));
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return usages;
}

/**
 * Parse → Process for the `ddl-declarations` fact (DDL in code and `.sql`
 * migration files). Returns the raw declarations both corpus processors
 * (`table-catalog`, `migration-history`) reduce — so the two derive from one
 * parse pass rather than re-parsing the same files twice.
 *
 * @param files - The input files to parse and process.
 * @returns The raw `ddl-declarations` the corpus processors reduce.
 */
export async function buildDdlDeclarations(files: readonly InputFile[]): Promise<SchemaDeclaration[]> {
  const declarations: SchemaDeclaration[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('ddl-declarations', parsed.format);
      if (producer) declarations.push(...producer.process(parsed));
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return declarations;
}

/**
 * Parse → Process for the `schema-objects` fact (ORM `const <id> = pgTable(
 * 'name', …)` bindings). Returns the identifier → SQL-name bindings the
 * `table-catalog` corpus processor folds into its alias map.
 *
 * @param files - The input files to parse and process.
 * @returns The raw `schema-objects` the corpus processor reduces.
 */
export async function buildSchemaObjects(files: readonly InputFile[]): Promise<SchemaObject[]> {
  const objects: SchemaObject[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('schema-objects', parsed.format);
      if (producer) objects.push(...producer.process(parsed) as SchemaObject[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return objects;
}

/**
 * Reduce the `ddl-declarations` fact through the `table-catalog` corpus
 * processor into the known-table set. The JSON-schema half of the old catalog
 * is config-driven (§10) and not reachable from this simple runner, so it is
 * dropped — this is the DDL-only slice of the catalog, the config-free half the
 * corpus processor consumes.
 */
export async function buildTableCatalog(files: readonly InputFile[]): Promise<TableCatalog> {
  const [declarations, objects] = await Promise.all([
    buildDdlDeclarations(files),
    buildSchemaObjects(files),
  ]);
  return CORPUS_PRODUCERS['table-catalog'].process({ 'ddl-declarations': declarations, 'schema-objects': objects });
}

/**
 * Reduce the `ddl-declarations` fact through the `migration-history` corpus
 * processor into the cross-file drop provenance (`stale-table-reference` reads
 * it to partition dropped tables from never-existed tables).
 */
export async function buildMigrationHistory(files: readonly InputFile[]): Promise<MigrationHistory> {
  const declarations = await buildDdlDeclarations(files);
  return CORPUS_PRODUCERS['migration-history'].process({ 'ddl-declarations': declarations });
}

/** Analyze the `schema-usage` + `table-catalog` + `migration-history` facts with
 *  the schema rules. `unknown-table` reads the catalog and migration-history to
 *  hand dropped tables to `stale-table-reference`; `table-naming-convention`
 *  reads `schema-usage` alone (its `needs` declares only that fact, and the
 *  union context carries all three).
 *
 *  @param usages - The assembled `schema-usage` fact to analyze.
 *  @param catalog - The known-table catalog (`unknown-table` reads it).
 *  @param migrationHistory - The cross-file drop provenance.
 *  @param thresholds - The schema rule thresholds (defaults to `{}`).
 *  @returns The schema rules' findings over the facts.
 */
export async function analyzeSchemaRules(
  usages: SchemaUsageFact[],
  catalog: TableCatalog,
  migrationHistory: MigrationHistory,
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(schemaRules, { 'schema-usage': usages, 'table-catalog': catalog, 'migration-history': migrationHistory }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/** The schema slice: parse → schema-usage + table-catalog + migration-history →
 *  schema rules → findings.
 *
 *  @param files - The input files to parse and process.
 *  @param thresholds - The schema rule thresholds (defaults to `{}`).
 *  @returns The schema rules' findings over the assembled facts.
 */
export async function runSchemaSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const [usages, declarations, objects] = await Promise.all([
    buildSchemaUsage(files),
    buildDdlDeclarations(files),
    buildSchemaObjects(files),
  ]);
  const catalog = CORPUS_PRODUCERS['table-catalog'].process({ 'ddl-declarations': declarations, 'schema-objects': objects });
  const migrationHistory = CORPUS_PRODUCERS['migration-history'].process({ 'ddl-declarations': declarations });
  return analyzeSchemaRules(usages, catalog, migrationHistory, thresholds);
}

// ── cross-domain lifecycle slice (same `schema-usage` fact, different rules) ─

/**
 * Analyze the assembled `schema-usage` fact with the cross-domain lifecycle
 * rules (`written-never-read`, `read-never-written`). Like the schema rules,
 * these reduce the whole corpus at once; the two detectors are pure set
 * differences over the flat usage list.
 *
 * @param usages - The assembled `schema-usage` fact to analyze.
 * @param thresholds - The cross-domain rule thresholds (defaults to `{}`).
 * @returns The cross-domain lifecycle rules' findings over the fact.
 */
export async function analyzeCrossDomain(usages: SchemaUsageFact[], thresholds: ThresholdValues = {}): Promise<Finding[]> {
  return analyzeWithRules(crossDomainRules, { 'schema-usage': usages }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/** The cross-domain slice: parse → schema-usage → lifecycle rules → findings. */
export async function runCrossDomainSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const usages = await buildSchemaUsage(files);
  return analyzeCrossDomain(usages, thresholds);
}

// ── cross-language-entities slice (dependency-graph rules) ──────────────────

/**
 * Parse → Process for the `cross-language-entities` fact. Returns the assembled
 * corpus fact (every entity from every file, ASTs already freed). The
 * dependency-graph rules read the *whole* corpus at once, so unlike the SOLID /
 * data-access slices there is no per-file analysis arm — the fact is the input.
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `cross-language-entities` corpus fact.
 */
export async function buildCrossLanguageEntities(files: readonly InputFile[]): Promise<Entity[]> {
  const entities: Entity[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('cross-language-entities', parsed.format);
      if (producer) entities.push(...(producer.process(parsed) as Entity[]));
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return entities;
}

/**
 * Analyze the assembled `cross-language-entities` fact with the dependency-graph rules.
 *
 * @param entities - The assembled `cross-language-entities` fact to analyze.
 * @param thresholds - The dependency-graph rule thresholds (defaults to `{}`).
 * @returns The dependency-graph rules' findings over the fact.
 */
export async function analyzeDependencyGraph(entities: Entity[], thresholds: ThresholdValues = {}): Promise<Finding[]> {
  return analyzeWithRules(dependencyGraphRules, { 'cross-language-entities': entities }, ['typescript', 'tsx', 'javascript', 'go'], thresholds);
}

/** The dependency-graph slice: parse → cross-language-entities → graph rules → findings. */
export async function runDependencyGraphSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const entities = await buildCrossLanguageEntities(files);
  return analyzeDependencyGraph(entities, thresholds);
}

// ── schema-validator slice (same fact, different rules) ─────────────────────

/**
 * Analyze the assembled `cross-language-entities` fact with the schema-validator
 * rules. The dependency-graph and schema-validator slices share one producer;
 * they differ only in which rules reduce the fact. Like the dependency-graph
 * rules, the schema-validator rules read the *whole* corpus at once.
 *
 * @param entities - The assembled `cross-language-entities` fact to analyze.
 * @param thresholds - The schema-validator rule thresholds (defaults to `{}`).
 * @returns The schema-validator rules' findings over the fact.
 */
export async function analyzeSchemaValidator(entities: Entity[], thresholds: ThresholdValues = {}): Promise<Finding[]> {
  return analyzeWithRules(schemaValidatorRules, { 'cross-language-entities': entities }, ['typescript', 'tsx', 'javascript', 'go'], thresholds);
}

/** The schema-validator slice: parse → cross-language-entities → validator rules → findings. */
export async function runSchemaValidatorSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const entities = await buildCrossLanguageEntities(files);
  return analyzeSchemaValidator(entities, thresholds);
}

// ── style-declarations slice (the eight style rules, undefined-class deferred) ──

/**
 * Parse → Process for the `style-declarations` fact. Returns the assembled
 * corpus fact (every declaration/token/class-usage from every CSS/SCSS/TS/JS
 * file, ASTs already freed). `projectRoot` threads through to the TS/JS producer
 * so Tailwind utility expansion resolves the project's theme tokens.
 *
 * @param files - The input files to parse and process.
 * @param projectRoot - The optional project root for Tailwind token resolution.
 * @returns The assembled `style-declarations` corpus fact.
 */
export async function buildStyleDeclarations(
  files: readonly InputFile[],
  projectRoot?: string,
): Promise<StyleDeclarationsFile[]> {
  const facts: StyleDeclarationsFile[] = [];
  for (const input of files) {
    const parsed = await parseOne(input, projectRoot);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('style-declarations', parsed.format);
      if (producer) facts.push(...producer.process(parsed));
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Analyze the assembled `style-declarations` fact with the styles rules.
 *
 * @param facts - The assembled `style-declarations` fact to analyze.
 * @param thresholds - The styles rule thresholds (defaults to `{}`).
 * @returns The styles rules' findings over the fact.
 */
export async function analyzeStyles(
  facts: StyleDeclarationsFile[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(stylesRules, { 'style-declarations': facts }, ['css', 'scss', 'typescript', 'tsx', 'javascript'], thresholds);
}

/**
 * The styles slice: parse → style-declarations → styles rules → findings.
 *
 * @param files - The input files to parse and process.
 * @param projectRoot - The optional project root for Tailwind token resolution.
 * @param thresholds - The styles rule thresholds (defaults to `{}`).
 * @returns The styles rules' findings over the assembled fact.
 */
export async function runStylesSlice(
  files: readonly InputFile[],
  projectRoot?: string,
  thresholds?: ThresholdValues,
): Promise<Finding[]> {
  const facts = await buildStyleDeclarations(files, projectRoot);
  return analyzeStyles(facts, thresholds);
}

// ── conventions slice (function-index + export-form + import-form → mined-conventions → 5 rules) ──

/**
 * Parse → Process for the `function-index` fact. Returns the assembled corpus
 * fact (every function/method/component from every file, ASTs already freed).
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `function-index` corpus fact.
 */
export async function buildFunctionIndex(files: readonly InputFile[]): Promise<FunctionIndexFact[]> {
  const facts: FunctionIndexFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('function-index', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as FunctionIndexFact[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Parse → Process for the `export-form` fact. Returns the assembled corpus fact
 * (every exported `(name, isDefault)` pair from every file, ASTs already freed).
 * The `conventions/export-shape` rule reads it to resolve a function's export
 * form — the same AST-extracted exports the legacy reducer read as `exportsMap`.
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `export-form` corpus fact.
 */
export async function buildExportForms(files: readonly InputFile[]): Promise<ExportFormFact[]> {
  const facts: ExportFormFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('export-form', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as ExportFormFact[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Parse → Process for the `import-form` fact. Returns the assembled corpus fact
 * (every import's classified form from every file). The producer reads
 * `.source` (not the AST) via `parseFileImports`, so the AST is freed without
 * being consumed by this producer — but the parse still validates the file.
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `import-form` corpus fact.
 */
export async function buildImportForms(files: readonly InputFile[]): Promise<ImportFormFact[]> {
  const facts: ImportFormFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('import-form', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as ImportFormFact[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/** Analyze the assembled `function-index` + `mined-conventions` + `export-form` +
 *  `import-form` facts with the five function-index-servable conventions rules
 *  (three `function-index`+`mined-conventions` rules plus the `export-form`-
 *  reading export-shape rule and the `import-form`-reading import-form rule).
 *
 *  @param facts - The assembled `function-index` fact to analyze.
 *  @param conventions - The assembled `mined-conventions` fact to analyze.
 *  @param exportForms - The assembled `export-form` fact (`export-shape` reads it).
 *  @param importForms - The assembled `import-form` fact (`import-form` reads it).
 *  @param thresholds - The conventions rule thresholds (defaults to `{}`).
 *  @returns The conventions rules' findings over the facts.
 */
export async function analyzeConventions(
  facts: FunctionIndexFact[],
  conventions: MinedConvention[],
  exportForms: ExportFormFact[],
  importForms: ImportFormFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    'function-index': facts,
    'mined-conventions': conventions,
    'export-form': exportForms,
    'import-form': importForms,
  };
  const formats: readonly Format[] = ['typescript', 'tsx', 'javascript'];
  return [
    ...(await analyzeWithRules(conventionsRules, ctx, formats, thresholds)),
    ...(await analyzeWithRules(conventionsExportShapeRules, ctx, formats, thresholds)),
    ...(await analyzeWithRules(conventionsImportFormRules, ctx, formats, thresholds)),
  ];
}

/**
 * The conventions slice: parse → function-index + export-form + import-form → mined-conventions → rules → findings.
 *
 * @param files - The input files to parse and process.
 * @param thresholds - The conventions rule thresholds (defaults to `{}`).
 * @returns The conventions rules' findings over the assembled facts.
 */
export async function runConventionsSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const [facts, exportForms, importForms] = await Promise.all([
    buildFunctionIndex(files),
    buildExportForms(files),
    buildImportForms(files),
  ]);
  const conventions = CORPUS_PRODUCERS['mined-conventions'].process({
    'function-index': facts,
    'export-form': exportForms,
    'import-form': importForms,
  });
  return analyzeConventions(facts, conventions, exportForms, importForms, thresholds);
}

// ── dry slice (imports + string-literals + code-block → the five DRY rules) ──

/**
 * Parse → Process for the `imports` fact. Returns the assembled corpus fact
 * (every import statement from every file, ASTs already freed).
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `imports` corpus fact.
 */
export async function buildImports(files: readonly InputFile[]): Promise<ImportFact[]> {
  const facts: ImportFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('imports', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as ImportFact[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Parse → Process for the `string-literals` fact. Returns the assembled corpus
 * fact (every string/template-string literal from every file, ASTs already freed).
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `string-literals` corpus fact.
 */
export async function buildStringLiterals(files: readonly InputFile[]): Promise<StringLiteralFact[]> {
  const facts: StringLiteralFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('string-literals', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as StringLiteralFact[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Parse → Process for the `code-block` fact. Returns the assembled corpus fact
 * (every code block + shape fragment from every file, ASTs already freed). The
 * producer projects the raw blocks/fragments with no threshold and no dedup;
 * the three block rules re-apply `minLineThreshold`/`similarityThreshold`/
 * `minShapeNames`/`excludePatterns`/check-gates over this plain data.
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `code-block` corpus fact.
 */
export async function buildCodeBlocks(files: readonly InputFile[]): Promise<CodeBlockFact[]> {
  const facts: CodeBlockFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('code-block', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as CodeBlockFact[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Analyze the assembled `imports` + `string-literals` + `code-block` facts with
 * the six DRY rules. Each rule reads only the fact its `needs` declares; the
 * union context carries all four. The three block rules partition `code-block`
 * by file before their filter → dedupe → compare, because the legacy
 * `analyzeAST` ran once per file (a block in file A is never compared against a
 * block in file B). `diverging-clone` reads `clone-pair-history`, empty here
 * (the slice test has no index), so it emits nothing.
 *
 * @param imports - The assembled `imports` fact to analyze.
 * @param stringLiterals - The assembled `string-literals` fact to analyze.
 * @param codeBlocks - The assembled `code-block` fact to analyze.
 * @param thresholds - The DRY rule thresholds (defaults to `{}`).
 * @returns The DRY rules' findings over the facts.
 */
export async function analyzeDry(
  imports: ImportFact[],
  stringLiterals: StringLiteralFact[],
  codeBlocks: CodeBlockFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(dryRules, { 'imports': imports, 'string-literals': stringLiterals, 'code-block': codeBlocks, 'clone-pair-history': [] }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/**
 * The dry slice: parse → imports + string-literals + code-block → DRY rules → findings.
 *
 * @param files - The input files to parse and process.
 * @param thresholds - The DRY rule thresholds (defaults to `{}`).
 * @returns The DRY rules' findings over the assembled facts.
 */
export async function runDrySlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const [imports, stringLiterals, codeBlocks] = await Promise.all([
    buildImports(files),
    buildStringLiterals(files),
    buildCodeBlocks(files),
  ]);
  return analyzeDry(imports, stringLiterals, codeBlocks, thresholds);
}

// ── security slice (string-literals → hardcoded-connection) ─────────────────

/**
 * Analyze the assembled `string-literals` fact with the hardcoded-connection
 * rule. `hardcoded-secret` reads a different fact (`secret-candidates`) and is
 * served by `analyzeSecrets` below, not this slice.
 *
 * @param stringLiterals - The assembled `string-literals` fact to analyze.
 * @param thresholds - The security rule thresholds (defaults to `{}`).
 * @returns The hardcoded-connection rule's findings over the fact.
 */
export async function analyzeSecurity(
  stringLiterals: StringLiteralFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(securityRules, { 'string-literals': stringLiterals }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/** The security slice: parse → string-literals → hardcoded-credential rules → findings. */
export async function runSecuritySlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const stringLiterals = await buildStringLiterals(files);
  return analyzeSecurity(stringLiterals, thresholds);
}

// ── secret-candidates slice (secret-candidates → hardcoded-secret) ──────────

/**
 * Parse → Process for the `secret-candidates` fact. Returns the assembled corpus
 * fact (every credential-position string from every file, ASTs already freed).
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `secret-candidates` corpus fact.
 */
export async function buildSecretCandidates(files: readonly InputFile[]): Promise<SecretCandidate[]> {
  const facts: SecretCandidate[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('secret-candidates', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as SecretCandidate[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Analyze the assembled `secret-candidates` fact with the hardcoded-secret rule.
 *
 * @param candidates - The assembled `secret-candidates` fact to analyze.
 * @param thresholds - The hardcoded-secret rule thresholds (defaults to `{}`).
 * @returns The hardcoded-secret rule's findings over the fact.
 */
export async function analyzeSecrets(
  candidates: SecretCandidate[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(secretsRules, { 'secret-candidates': candidates }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/** The secret-candidates slice: parse → secret-candidates → hardcoded-secret → findings. */
export async function runSecretsSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const candidates = await buildSecretCandidates(files);
  return analyzeSecrets(candidates, thresholds);
}

// ── security-candidates slice (security-candidates → 3 defect rules) ────────

/**
 * Parse → Process for the `security-candidates` fact. Returns the assembled
 * corpus fact (every command-injection/dynamic-require/unescaped-html candidate
 * from every file, ASTs already freed).
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `security-candidates` corpus fact.
 */
export async function buildSecurityCandidates(files: readonly InputFile[]): Promise<SecurityCandidate[]> {
  const facts: SecurityCandidate[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('security-candidates', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as SecurityCandidate[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Analyze the assembled `security-candidates` fact with the three defect rules.
 *
 * @param candidates - The assembled `security-candidates` fact to analyze.
 * @param thresholds - The security-defect rule thresholds (defaults to `{}`).
 * @returns The three defect rules' findings over the fact.
 */
export async function analyzeSecurityDefects(
  candidates: SecurityCandidate[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(securityDefectRules, { 'security-candidates': candidates }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/** The security-candidates slice: parse → security-candidates → defect rules → findings. */
export async function runSecurityDefectsSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const candidates = await buildSecurityCandidates(files);
  return analyzeSecurityDefects(candidates, thresholds);
}

// ── function-bodies slice (function-bodies → too-many-queries) ───────────────

/**
 * Parse → Process for the `function-bodies` fact. Returns the assembled corpus
 * fact (every function body from every file, ASTs already freed). The node set
 * is `adapter.extractFunctions`' full set — wider than `function-index` — so the
 * `too-many-queries` rule sees the same universe the legacy schema-code visitor
 * walked.
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `function-bodies` corpus fact.
 */
export async function buildFunctionBodies(files: readonly InputFile[]): Promise<FunctionBodyFact[]> {
  const facts: FunctionBodyFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('function-bodies', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as FunctionBodyFact[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Analyze the assembled `function-bodies` fact with the too-many-queries rule.
 *
 * @param facts - The assembled `function-bodies` fact to analyze.
 * @param thresholds - The too-many-queries rule thresholds (defaults to `{}`).
 * @returns The too-many-queries rule's findings over the fact.
 */
export async function analyzeFunctionBodies(
  facts: FunctionBodyFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(functionBodyRules, { 'function-bodies': facts }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/** The function-bodies slice: parse → function-bodies → too-many-queries → findings. */
export async function runFunctionBodiesSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const facts = await buildFunctionBodies(files);
  return analyzeFunctionBodies(facts, thresholds);
}

// ── react-component slice (react-component → 7 react rules) ──────────────────

/**
 * Parse → Process for the `react-component` fact. Returns the assembled corpus
 * fact (one scan per file, each a full component universe: metadata, imports,
 * JSX elements, hooks, props, complexity), ASTs already freed.
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `react-component` corpus fact.
 */
export async function buildReactComponents(files: readonly InputFile[]): Promise<ReactComponentScan[]> {
  const facts: ReactComponentScan[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('react-component', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as ReactComponentScan[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Analyze the assembled `react-component` fact with the seven react rules.
 *
 * @param facts - The assembled `react-component` fact to analyze.
 * @param thresholds - The react rule thresholds (defaults to `{}`).
 * @returns The react rules' findings over the fact.
 */
export async function analyzeReactComponents(
  facts: ReactComponentScan[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(reactRules, { 'react-component': facts }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/** The react slice: parse → react-component → react rules → findings. */
export async function runReactComponentsSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const facts = await buildReactComponents(files);
  return analyzeReactComponents(facts, thresholds);
}

// ── file-header slice (file-header → file-documentation) ─────────────────────

/**
 * Parse → Process for the `file-header` fact. Returns the assembled corpus
 * fact (one leading comment projection per file, ASTs already freed).
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `file-header` corpus fact.
 */
export async function buildFileHeaders(files: readonly InputFile[]): Promise<FileHeaderFact[]> {
  const facts: FileHeaderFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('file-header', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as FileHeaderFact[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Analyze the assembled `file-header` fact with the file-documentation rule.
 *
 * @param facts - The assembled `file-header` fact to analyze.
 * @param thresholds - The file-documentation rule thresholds (defaults to `{}`).
 * @returns The file-documentation rule's findings over the fact.
 */
export async function analyzeFileHeaders(
  facts: FileHeaderFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(fileDocumentationRules, { 'file-header': facts }, ['typescript', 'tsx', 'javascript'], thresholds);
}

/** The file-header slice: parse → file-header → file-documentation → findings. */
export async function runFileHeadersSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const facts = await buildFileHeaders(files);
  return analyzeFileHeaders(facts, thresholds);
}

// ── schema-json slice (json-document → schema-validations → 17 rules) ────────

/**
 * Parse → Process for the `json-document` fact. Returns the assembled corpus
 * fact (one parsed JSON document per `.json` file, ASTs already freed). The
 * producer reads `.source` (the JsonAdapter has no code constructs), so the
 * parse still validates the file but the fact is the `JSON.parse` value.
 *
 * @param files - The input files to parse and process.
 * @returns The assembled `json-document` corpus fact.
 */
export async function buildJsonDocuments(files: readonly InputFile[]): Promise<JsonDocumentFact[]> {
  const facts: JsonDocumentFact[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      const producer = fileProducerFor('json-document', parsed.format);
      if (producer) facts.push(...producer.process(parsed) as JsonDocumentFact[]);
    } finally {
      parsed.ast?.dispose?.();
    }
  }
  return facts;
}

/**
 * Analyze the assembled `schema-validations` fact with the 17 schema-json rules.
 *
 * @param validations - The assembled `schema-validations` fact to analyze.
 * @param thresholds - The schema-json rule thresholds (defaults to `{}`).
 * @returns The 17 schema-json rules' findings over the fact.
 */
export async function analyzeSchemaJson(
  validations: SchemaValidationFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  return analyzeWithRules(schemaJsonRules, { 'schema-validations': validations }, ['json'], thresholds);
}
