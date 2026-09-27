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
import { fileProducerFor, CORPUS_PRODUCERS } from './producers.js';
import { solidRules } from './rules/solid.js';
import { dataAccessRules } from './rules/dataAccess.js';
import { schemaRules } from './rules/schema.js';
import { dependencyGraphRules } from './rules/dependencyGraph.js';
import { schemaValidatorRules } from './rules/schemaValidator.js';
import { documentationRules } from './rules/documentation.js';
import { stylesRules } from './rules/styles.js';
import { crossDomainRules } from './rules/crossDomain.js';
import { conventionsRules } from './rules/conventions.js';
import { dryRules } from './rules/dry.js';
import { securityRules } from './rules/security.js';
import { secretsRules } from './rules/secrets.js';
import { securityDefectRules } from './rules/securityDefects.js';
import { functionBodyRules } from './rules/functionBodies.js';
import { reactRules } from './rules/react.js';
import { fileDocumentationRules } from './rules/fileDocumentation.js';
import type {
  ParsedFile,
  FileSymbols,
  ResolvedQuery,
  SchemaUsageFact,
  SchemaDeclaration,
  TableCatalog,
  Entity,
  Format,
  ThresholdValues,
  Finding,
  StyleDeclarationsFile,
  FunctionIndexFact,
  MinedConvention,
  ImportFact,
  StringLiteralFact,
  SecretCandidate,
  SecurityCandidate,
  FunctionBodyFact,
  ReactComponentScan,
  FileHeaderFact,
} from './types.js';

/** A file to parse, with its source already read (the CLI reads it in §11). */
export type InputFile = { readonly path: string; readonly content: string };

/** The format a path declares, by extension (matches the liveness fixtures). */
export function formatFor(path: string): Format {
  if (path.endsWith('.tsx') || path.endsWith('.jsx')) return 'tsx';
  if (path.endsWith('.js')) return 'javascript';
  if (path.endsWith('.go')) return 'go';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.scss')) return 'scss';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.sql')) return 'sql';
  return 'typescript';
}

/**
 * Parse one file into a `ParsedFile`. Uses `adapter.parse()` (not the sync
 * bridge) so the adapter's source map is populated — `extractFunctions` /
 * `extractClasses` read the real source through it. Returns `null` when no
 * adapter resolves the path or the parse fails; the caller records the drop
 * (§3.3 makes a per-file failure `incomplete`, which is §8's concern).
 */
export async function parseOne(input: InputFile, projectRoot?: string): Promise<ParsedFile | null> {
  // `.sql` is the one text-only format: no grammar, no adapter, no AST. Its
  // sole producer (ddl-declarations) reads `.source`/`.file`, so return a
  // ParsedFile with neither `ast` nor `adapter`.
  if (formatFor(input.path) === 'sql') {
    return { file: input.path, format: 'sql', source: input.content, ...(projectRoot ? { projectRoot } : {}) };
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

/** Analyze the assembled `file-symbols` fact with the SOLID rules. */
export async function analyzeFileSymbols(symbols: FileSymbols[], thresholds: ThresholdValues = {}): Promise<Finding[]> {
  const ctx = {
    facts: { 'file-symbols': symbols },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of solidRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
}

/** The whole vertical slice: parse → file-symbols → SOLID rules → findings. */
export async function runFileSymbolsSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const symbols = await buildFileSymbols(files);
  return analyzeFileSymbols(symbols, thresholds);
}

// ── documentation slice (same fact, different rules) ─────────────────────────

/** Analyze the assembled `file-symbols` fact with the documentation rules. */
export async function analyzeDocumentation(symbols: FileSymbols[], thresholds: ThresholdValues = {}): Promise<Finding[]> {
  const ctx = {
    facts: { 'file-symbols': symbols },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of documentationRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
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
 *  `data-access-calls`, and the union context carries both). */
export async function analyzeDataAccessCalls(
  calls: ResolvedQuery[],
  catalog: TableCatalog,
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    facts: { 'data-access-calls': calls, 'table-catalog': catalog },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of dataAccessRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
}

/** The data-access slice: parse → data-access-calls + table-catalog → rules → findings. */
export async function runDataAccessSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const [calls, catalog] = await Promise.all([
    buildDataAccessCalls(files),
    buildTableCatalog(files),
  ]);
  return analyzeDataAccessCalls(calls, catalog, thresholds);
}

// ── schema slice (the "repeat" for a corpus-consuming fact kind) ────────────

/**
 * Parse → Process for the `schema-usage` fact. Returns the assembled corpus
 * fact (every table reference from every file, ASTs already freed).
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
 * Parse → Process for the `ddl-declarations` fact (DDL in code), then reduce it
 * through the `table-catalog` corpus processor into the known-table set. The
 * JSON-schema half of the old catalog is config-driven (§10) and not reachable
 * from this simple runner, so it is dropped — this is the DDL-only slice of the
 * catalog, the config-free half the corpus processor consumes.
 */
export async function buildTableCatalog(files: readonly InputFile[]): Promise<TableCatalog> {
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
  return CORPUS_PRODUCERS['table-catalog'].process({
    'ddl-declarations': declarations,
  });
}

/** Analyze the `schema-usage` + `table-catalog` facts with the schema rules. */
export async function analyzeSchemaRules(
  usages: SchemaUsageFact[],
  catalog: TableCatalog,
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    facts: { 'schema-usage': usages, 'table-catalog': catalog },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of schemaRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
}

/** The schema slice: parse → schema-usage + table-catalog → schema rules → findings. */
export async function runSchemaSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const [usages, catalog] = await Promise.all([
    buildSchemaUsage(files),
    buildTableCatalog(files),
  ]);
  return analyzeSchemaRules(usages, catalog, thresholds);
}

// ── cross-domain lifecycle slice (same `schema-usage` fact, different rules) ─

/**
 * Analyze the assembled `schema-usage` fact with the cross-domain lifecycle
 * rules (`written-never-read`, `read-never-written`). Like the schema rules,
 * these reduce the whole corpus at once; the two detectors are pure set
 * differences over the flat usage list.
 */
export async function analyzeCrossDomain(usages: SchemaUsageFact[], thresholds: ThresholdValues = {}): Promise<Finding[]> {
  const ctx = {
    facts: { 'schema-usage': usages },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of crossDomainRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
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

/** Analyze the assembled `cross-language-entities` fact with the dependency-graph rules. */
export async function analyzeDependencyGraph(entities: Entity[], thresholds: ThresholdValues = {}): Promise<Finding[]> {
  const ctx = {
    facts: { 'cross-language-entities': entities },
    formats: ['typescript', 'tsx', 'javascript', 'go'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of dependencyGraphRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
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
 */
export async function analyzeSchemaValidator(entities: Entity[], thresholds: ThresholdValues = {}): Promise<Finding[]> {
  const ctx = {
    facts: { 'cross-language-entities': entities },
    formats: ['typescript', 'tsx', 'javascript', 'go'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of schemaValidatorRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
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

/** Analyze the assembled `style-declarations` fact with the styles rules. */
export async function analyzeStyles(
  facts: StyleDeclarationsFile[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    facts: { 'style-declarations': facts },
    formats: ['css', 'scss', 'typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of stylesRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
}

/** The styles slice: parse → style-declarations → styles rules → findings. */
export async function runStylesSlice(
  files: readonly InputFile[],
  projectRoot?: string,
  thresholds?: ThresholdValues,
): Promise<Finding[]> {
  const facts = await buildStyleDeclarations(files, projectRoot);
  return analyzeStyles(facts, thresholds);
}

// ── conventions slice (function-index → mined-conventions → 3 rules) ────────

/**
 * Parse → Process for the `function-index` fact. Returns the assembled corpus
 * fact (every function/method/component from every file, ASTs already freed).
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

/** Analyze the assembled `function-index` + `mined-conventions` facts with the
 *  three function-index-servable conventions rules. */
export async function analyzeConventions(
  facts: FunctionIndexFact[],
  conventions: MinedConvention[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    facts: { 'function-index': facts, 'mined-conventions': conventions },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of conventionsRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
}

/** The conventions slice: parse → function-index → mined-conventions → rules → findings. */
export async function runConventionsSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const facts = await buildFunctionIndex(files);
  const conventions = CORPUS_PRODUCERS['mined-conventions'].process({ 'function-index': facts });
  return analyzeConventions(facts, conventions, thresholds);
}

// ── dry slice (imports + string-literals → duplicate-import / -string-literal) ──

/**
 * Parse → Process for the `imports` fact. Returns the assembled corpus fact
 * (every import statement from every file, ASTs already freed).
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

/** Analyze the assembled `imports` + `string-literals` facts with the DRY rules.
 *  Each rule reads only the fact its `needs` declares; the union context carries
 *  both. */
export async function analyzeDry(
  imports: ImportFact[],
  stringLiterals: StringLiteralFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    facts: { 'imports': imports, 'string-literals': stringLiterals },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of dryRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
}

/** The dry slice: parse → imports + string-literals → DRY rules → findings. */
export async function runDrySlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const [imports, stringLiterals] = await Promise.all([
    buildImports(files),
    buildStringLiterals(files),
  ]);
  return analyzeDry(imports, stringLiterals, thresholds);
}

// ── security slice (string-literals → hardcoded-connection) ─────────────────

/**
 * Analyze the assembled `string-literals` fact with the hardcoded-connection
 * rule. `hardcoded-secret` reads a different fact (`secret-candidates`) and is
 * served by `analyzeSecrets` below, not this slice.
 */
export async function analyzeSecurity(
  stringLiterals: StringLiteralFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    facts: { 'string-literals': stringLiterals },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of securityRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
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

/** Analyze the assembled `secret-candidates` fact with the hardcoded-secret rule. */
export async function analyzeSecrets(
  candidates: SecretCandidate[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    facts: { 'secret-candidates': candidates },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of secretsRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
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

/** Analyze the assembled `security-candidates` fact with the three defect rules. */
export async function analyzeSecurityDefects(
  candidates: SecurityCandidate[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    facts: { 'security-candidates': candidates },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of securityDefectRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
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

/** Analyze the assembled `function-bodies` fact with the too-many-queries rule. */
export async function analyzeFunctionBodies(
  facts: FunctionBodyFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    facts: { 'function-bodies': facts },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of functionBodyRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
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

/** Analyze the assembled `react-component` fact with the seven react rules. */
export async function analyzeReactComponents(
  facts: ReactComponentScan[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    facts: { 'react-component': facts },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of reactRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
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

/** Analyze the assembled `file-header` fact with the file-documentation rule. */
export async function analyzeFileHeaders(
  facts: FileHeaderFact[],
  thresholds: ThresholdValues = {},
): Promise<Finding[]> {
  const ctx = {
    facts: { 'file-header': facts },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of fileDocumentationRules) {
    findings.push(...(await rule.analyze(ctx)));
  }
  return findings;
}

/** The file-header slice: parse → file-header → file-documentation → findings. */
export async function runFileHeadersSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const facts = await buildFileHeaders(files);
  return analyzeFileHeaders(facts, thresholds);
}
