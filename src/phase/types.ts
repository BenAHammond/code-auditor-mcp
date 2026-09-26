/**
 * Spec 68 — the phase model's type system.
 *
 * Three strictly-ordered phases (Parse → Process → Analyze) are made real by
 * these types. The central move: a rule no longer *selects* an analyzer or an
 * input; it *declares* what it needs, and that declaration is load-bearing —
 * it drives the schedule (§5), the coverage states (§8), and the compile-time
 * residue checks (§2.3 / §3.1 / §4).
 *
 * This file is types only. No runtime value here (except the mapped-type and
 * assertion declarations that TypeScript erases). The producers live in
 * `producers.ts`; the consumed-set derivation and the residue/serializability
 * assertions live in `checks.ts`.
 *
 * A tree-sitter tree (or any AST) is deliberately absent from every type a
 * rule can reach. `FactShapes['ast']` is `never` and `FactKind` excludes it —
 * a rule cannot even name `ast` in its `needs.facts`, so a tree cannot cross a
 * phase boundary by construction.
 *
 * Fact shapes are `type` aliases (object-literal types), not `interface`s:
 * §4's serializability assertion checks `FactShapes[K] extends Serializable`,
 * and TypeScript gives object-literal `type`s — but not `interface`s — the
 * implicit index signature that makes a plain-data shape satisfiable against
 * `Serializable`'s `{ readonly [k: string]: Serializable }` arm.
 */

/**
 * The single namespace of fact kinds. Adding a kind here without a producer in
 * {@link PRODUCERS} (producers.ts) fails compilation at the residue check.
 *
 * Each shape is a serializable value (§4): plain data, no functions, no class
 * instances, no handles, no `Date`. Where the processor migration (§3.2) pins
 * a shape more precisely than this initial declaration, it narrows the type —
 * the serializability assertion is the guardrail that keeps any such narrowing
 * honest.
 */
export interface FactShapes {
  /** Reserved: an AST is not a fact and cannot be declared. */
  ast: never;
  'file-symbols': FileSymbols;
  'function-index': FunctionRow[];
  'schema-json': SchemaDeclaration[];
  'schema-code': SchemaDeclaration[];
  'schema-usage': SchemaUsageFact[];
  'styles-css': StyleDeclaration[];
  'cross-language-entities': Entity[];
  'data-access-calls': ResolvedQuery[];
  'table-catalog': TableCatalog;
  'go-imports': GoImportFacts[];
  'go-error-bindings': GoErrorBinding[];
  'go-goroutines': GoConcurrencyFacts[];
  'go-channels': GoChannelFacts[];
}

/** Every fact kind a rule or processor may declare. `ast` is excluded. */
export type FactKind = Exclude<keyof FactShapes, 'ast'>;

/** The file formats the adapter layer can parse and a rule can evaluate. */
export type Format = 'typescript' | 'tsx' | 'javascript' | 'go' | 'css' | 'scss';

/** A rule's declaration: the formats it can evaluate and the facts it reads. */
export interface Needs {
  readonly formats: readonly Format[];
  readonly facts: readonly FactKind[];
}

// ── Fact shape definitions ─────────────────────────────────────────────────

/**
 * One symbol extracted from a parsed file by the per-file symbol processor.
 * The migration (§3.2) folds the six per-file AST visitors onto this; the
 * shape is the common serializable projection (name / kind / location), not
 * the full tree-sitter node.
 */
export type FileSymbols = {
  file: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'component' | 'struct';
  line: number;
  column?: number;
  isExported?: boolean;
};

/**
 * One function row, as the index stores it and as the conventions rules read
 * it (`UniversalConventionsAnalyzer`'s `FunctionRow`, made load-bearing).
 */
export type FunctionRow = {
  id: number;
  name: string;
  file_path: string;
  line_number: number;
  is_exported: number;
  body: string | null;
  language?: string | null;
};

/** A schema declared in JSON (`.codeauditor.json` schemas) or in code (DDL). */
export type SchemaDeclaration = {
  name: string;
  file: string;
  columns: SchemaColumn[];
  /** `'json'` when from a config schema, `'code'` when from parsed DDL. */
  origin: 'json' | 'code';
  raw?: string;
};

export type SchemaColumn = {
  name: string;
  type?: string;
  required?: boolean;
};

/**
 * The serializable projection of `SchemaUsage` (types.ts). The source type is
 * an `interface`, which does not satisfy §4's `Serializable` index-signature
 * arm; the fact is the same data as a plain object-literal shape.
 */
export type SchemaUsageFact = {
  tableName: string;
  filePath: string;
  functionName: string | null;
  functionStartLine?: number | null;
  functionStartColumn?: number | null;
  usageType: 'select' | 'insert' | 'update' | 'delete' | 'create' | 'reference';
  line: number;
  column?: number;
  rawQuery?: string;
  parameters?: string[];
  origin?: 'query-builder';
};

/** One style declaration extracted from a CSS/SCSS source file. */
export type StyleDeclaration = {
  file: string;
  selector: string;
  property: string;
  value: string;
  line: number;
};

/**
 * A cross-language entity as a serializable fact — the projection of
 * `CrossLanguageEntity` that strips the non-serializable `Date` timestamps.
 * The migration (§3.2) is what makes the processor emit exactly this shape.
 */
export type Entity = {
  id: string;
  name: string;
  language: string;
  file: string;
  type: string;
  signature: string;
  parameters: ReadonlyArray<{ name: string; type?: string; language: string }>;
  calls: ReadonlyArray<{ sourceId: string; targetId: string; type: string }>;
  calledBy: ReadonlyArray<{ sourceId: string; targetId: string; type: string }>;
  visibility?: string;
  startLine?: number;
  endLine?: number;
  purpose: string;
  context: string;
  searchTokens: string[];
};

/** A DB query resolved to its tables/kind by the data-access processor. */
export type ResolvedQuery = {
  file: string;
  line: number;
  method: string;
  tables: string[];
  kind: 'select' | 'insert' | 'update' | 'delete' | 'create';
  raw?: string;
  hasOrganizationFilter?: boolean;
};

/** The known-table catalog built by the corpus schema processor (§5). */
export type TableCatalog = {
  tables: ReadonlyArray<{ name: string; source: string }>;
};

/** Facts the Go binary emits about a file's imports (Spec 68 §9). */
export type GoImportFacts = {
  file: string;
  imports: ReadonlyArray<{ path: string; line: number; grouped: boolean; dot?: boolean }>;
};

/** Facts the Go binary emits about a file's error bindings (Spec 68 §9). */
export type GoErrorBinding = {
  file: string;
  line: number;
  name: string;
  checked: boolean;
  propagated: boolean;
};

/** Facts the Go binary emits about a file's goroutine launches (Spec 68 §9). */
export type GoConcurrencyFacts = {
  file: string;
  line: number;
  synchronized: boolean;
};

/** Facts the Go binary emits about a file's channel operations (Spec 68 §9). */
export type GoChannelFacts = {
  file: string;
  line: number;
  buffered: boolean;
  sendLine?: number;
  receiveLine?: number;
  sameGoroutine: boolean;
};

// ── Serializable (Spec 68 §4) ──────────────────────────────────────────────

/** The serializable value universe. No functions, no class instances. */
export type Serializable =
  | string
  | number
  | boolean
  | null
  | readonly Serializable[]
  | { readonly [k: string]: Serializable };

// ── Rule definition (Spec 68 §2.1) ─────────────────────────────────────────

/** A rule ID — the canonical slug, the only identity a finding carries. */
export type RuleId = string;

/** A config threshold key (dot-separated path within a rule's config surface). */
export type ThresholdKey = string;

/** The resolved threshold values a rule reads at analysis time. */
export type ThresholdValues = Readonly<Record<string, unknown>>;

/** A single valid/invalid sample (re-exported shape; defined in ruleRegistry). */
export type RuleSample = {
  code: string;
  nearMiss?: boolean;
  resolution?: import('../types.js').Resolution;
};

export type RuleSamples = {
  valid: RuleSample[];
  invalid: RuleSample[];
};

/** The context a rule's `analyze` receives — derived, never chosen. */
export type AnalysisContext<N extends Needs> = {
  readonly facts: { readonly [K in N['facts'][number]]: FactShapes[K] };
  readonly formats: N['formats'];
  readonly thresholds: ThresholdValues;
};

/** One finding, in the unified shape §7 converges on (one `ruleId` field). */
export type Finding = {
  ruleId: RuleId;
  severity: import('../types.js').Severity;
  message: string;
  file: string;
  line?: number;
  column?: number;
  symbol?: string;
  resolution?: import('../types.js').Resolution;
};

/** A rule definition. `needs` has no optional form and no default. */
export interface RuleDefinition<N extends Needs> {
  readonly id: RuleId;
  readonly needs: N;
  readonly severity: import('../types.js').Severity;
  readonly message: string;
  readonly docs: string;
  readonly thresholds: readonly ThresholdKey[];
  readonly thresholdRationale?: string;
  readonly samples: RuleSamples;
  analyze(ctx: AnalysisContext<N>): readonly Finding[];
}

// ── Processors (Spec 68 §3) ────────────────────────────────────────────────

export type ProcessorId = string;

/** A parsed file handed to a per-file processor — the only place an AST lives. */
export interface ParsedFile {
  readonly file: string;
  readonly format: Format;
  /** The source text, present so a processor may re-derive position/context. */
  readonly source: string;
  /** The parsed tree. Dies with the file — never crosses a phase boundary. */
  readonly ast: unknown;
}

/** The fragment a per-file processor returns for one file. */
export type FactFragment<K extends FactKind> = {
  readonly [k: string]: unknown;
  // NOTE: the per-file processors return `FactShapes[K]`-shaped data keyed by
  // file; the parent assembles fragments into the corpus fact. Kept loose here
  // so a tree-sitter node can be present transiently *inside* a processor and
  // still be stripped before the fragment crosses the worker boundary.
};

/** A per-file processor: receives one parsed file, extracts one fact kind. */
export interface FileProcessor<K extends FactKind> {
  readonly id: ProcessorId;
  readonly produces: K;
  readonly formats: readonly Format[];
  /** The only place an AST is reachable. */
  process(file: ParsedFile): FactFragment<K>;
}

/** A corpus processor: receives complete upstream facts, no AST. */
export interface CorpusProcessor<K extends FactKind, N extends readonly FactKind[]> {
  readonly id: ProcessorId;
  readonly produces: K;
  readonly needs: N;
  process(facts: { readonly [J in N[number]]: FactShapes[J] }): FactShapes[K];
}

/** The union type of a producer: a per-file or corpus processor. */
export type Producer<K extends FactKind> = FileProcessor<K> | CorpusProcessor<K, readonly FactKind[]>;
