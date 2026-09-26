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

import type { AST, LanguageAdapter } from '../languages/types.js';

export interface FactShapes {
  /** Reserved: an AST is not a fact and cannot be declared. */
  ast: never;
  'file-symbols': FileSymbols[];
  'function-index': FunctionIndexFact[];
  // Source-format names are gone (Spec 68 §2 — "a fact is named for what it
  // is, never for where it came from"; `needs.formats` already says the format):
  //   schema-code  → ddl-declarations   (DDL declarations in code)
  //   styles-css   → style-declarations (style declarations)
  // The JSON/Go/DRY/react/etc. fact kinds planned in spec68-rule-migration-map.md
  // are deliberately absent here: a kind enters FactShapes only once it has a
  // producer that returns real data. The migration map holds the plan; the type
  // holds only what works.
  'ddl-declarations': SchemaDeclaration[];
  'schema-usage': SchemaUsageFact[];
  'style-declarations': StyleDeclarationsFile[];
  'cross-language-entities': Entity[];
  'data-access-calls': ResolvedQuery[];
  'table-catalog': TableCatalog;
}

/** Every fact kind a rule or processor may declare. `ast` is excluded. */
export type FactKind = Exclude<keyof FactShapes, 'ast'>;

/**
 * The file formats the adapter layer can parse and a rule can evaluate.
 *
 * `'json'` was added in Amendment 1 of the fact-vocabulary pass: a JSON file is
 * a *format* like any other, parsed by a position-preserving JSON adapter, so
 * the `declared-schemas` / `schema-validations` rules go through the same
 * per-file model as every other rule instead of reading `.json` files off disk
 * through a config callback.
 */
export type Format = 'typescript' | 'tsx' | 'javascript' | 'go' | 'css' | 'scss' | 'json';

/** A rule's declaration: the formats it can evaluate and the facts it reads. */
export interface Needs {
  readonly formats: readonly Format[];
  readonly facts: readonly FactKind[];
}

// ── Fact shape definitions ─────────────────────────────────────────────────

/**
 * One symbol extracted from a parsed file by the per-file symbol processor.
 *
 * The shape is the *serializable projection* of the adapter's `FunctionInfo` /
 * `ClassInfo` / `InterfaceInfo`, plus every metric a symbol-level rule needs —
 * computed in the processor, where the AST lives, so that `analyze` is pure
 * threshold comparison over plain data. No tree-sitter node survives here: a
 * node carries methods and cannot satisfy §4's `Serializable` arm.
 *
 * The name is plural (inherited from the spec's `FactShapes` key) but each
 * element is ONE symbol; `FactShapes['file-symbols']` is the corpus-wide array
 * of them, and a per-file processor returns the subset for its one file.
 *
 * §3.2 vertical slice (this landing's first fact kind) migrates the SOLID
 * rules onto the `function`/`class`/`interface` arms; `concernGroups`,
 * `hasInstanceofAgainstUserType`, `hasHeldDirectInstantiation`, `throws` and
 * `aggregateComplexity` are the pre-computed signals those rules used to walk
 * the AST to obtain. `jsDoc` (the comment *text*, not a boolean) and
 * `returnType` serve the documentation rules; the DRY / security / react rules
 * that currently declare `file-symbols` are re-declared against their own facts
 * in the "repeat for the other twelve" step, not served by this shape.
 */
export type FileSymbols = FileFunctionSymbol | FileClassSymbol | FileInterfaceSymbol;

/** A method, as a class symbol carries it (metrics pre-computed at process time). */
export type FileMethodSymbol = {
  name: string;
  line: number;
  column?: number;
  parameterCount: number;
  parameterNames: string[];
  lineCount: number;
  complexity: number;
  /** True when the method body contains a `throw` (LSP override signal). */
  throws: boolean;
  /** Voting concern-group labels (empty = single-purpose); SRP reads these. */
  concernGroups: string[];
  /** JSDoc comment text, or null when absent (method-documentation reads it). */
  jsDoc: string | null;
  /** Visibility (method-documentation's classify/skip decision). */
  visibility?: 'public' | 'private' | 'protected';
};

/** A standalone function (or a method surfaced outside its class for size rules). */
export type FileFunctionSymbol = {
  kind: 'function';
  file: string;
  name: string;
  /** Set when this function is a method; empty/absent for a free function. */
  className?: string;
  line: number;
  column?: number;
  endLine: number;
  isExported?: boolean;
  isAsync?: boolean;
  parameterCount: number;
  parameterNames: string[];
  lineCount: number;
  complexity: number;
  /** Voting concern-group labels (empty = single-purpose); SRP reads these. */
  concernGroups: string[];
  /** JSDoc comment text, or null when absent (documentation rules read it). */
  jsDoc: string | null;
  /** Return-type annotation (return-documentation reads this). */
  returnType?: string;
};

/** A class, with its methods and the class-level signals pre-computed. */
export type FileClassSymbol = {
  kind: 'class';
  file: string;
  name: string;
  line: number;
  column?: number;
  isExported?: boolean;
  extends?: string;
  methodCount: number;
  /** Σ of method cyclomatic complexity (class-size's second threshold). */
  aggregateComplexity: number;
  /** `instanceof` against a user-defined type anywhere in the class body. */
  hasInstanceofAgainstUserType: boolean;
  /** A held (non-escaping) `new Foo()` of a concrete type in the class body. */
  hasHeldDirectInstantiation: boolean;
  methods: FileMethodSymbol[];
  /** JSDoc comment text, or null when absent (class-documentation reads it). */
  jsDoc: string | null;
};

/** An interface, with the member-count / method-member signals pre-computed. */
export type FileInterfaceSymbol = {
  kind: 'interface';
  file: string;
  name: string;
  line: number;
  column?: number;
  memberCount: number;
  /** True when any member is a method signature (interface-size's discriminator). */
  hasMethodMembers: boolean;
};

/**
 * One function/method/component row, as the `function-index` producer extracts
 * it (§3.2 re-homes `createFunctionIndexVisitor`). This is the serializable
 * projection of the visitor's `FunctionIndexEntry`, widened with the fields the
 * conventions rules read that were previously fetched from the DB:
 * `entityType`/`componentType` (naming's `NamingFunctionRow`) and
 * `functionCalls` (usage-pair's `FunctionCallRow`). The DB-assigned `id` is
 * dropped — a function's identity is `(file, name, line)`, which is what the
 * diff-scoped content hash keys on. `is_exported` is a boolean here, not the
 * DB's 0/1.
 */
export type FunctionIndexFact = {
  file: string;
  name: string;
  line: number;
  endLine: number;
  entityType: 'function' | 'method' | 'component';
  componentType: string | null;
  isExported: boolean;
  complexity: number;
  body: string | null;
  functionCalls: string[];
  language: string;
};

/** A schema declared in JSON (`.codeauditor.json` schemas) or in code (DDL). */
export type SchemaDeclaration = {
  name: string;
  file: string;
  columns: SchemaColumn[];
  /** Always `'code'`: the only producer is the DDL extractor. */
  origin: 'code';
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

/**
 * The per-file `style-declarations` fact — the serializable projection of the
 * three arrays the styles pipeline extracts from one CSS/SCSS file: normalized
 * declarations, design tokens (custom properties), and class usage. §3.2
 * re-homes `createStylesCssVisitor` (pipelineAdapters.ts), which emits exactly
 * this trio; the styles rules read all three, so a single flat declaration
 * list was never the right shape. Each element carries its own `filePath`, so
 * the corpus-wide fact is the concatenation of per-file fragments and the
 * rules flatten the three sub-arrays. The element shapes are object-literal
 * `type` aliases (not the `NormalizedDeclaration`/`StyleToken`/
 * `StyleClassUsage` interfaces they project) so §4's `Serializable` arm holds.
 */
export type StyleDeclarationsFile = {
  declarations: ReadonlyArray<StylesDeclaration>;
  tokens: ReadonlyArray<StylesToken>;
  classUsage: ReadonlyArray<StylesClassUsage>;
};

/** A normalized style declaration, as the CSS/SCSS extractor emits it. */
export type StylesDeclaration = {
  property: string;
  rawValue: string;
  /** Normalized value for cross-mechanism comparison; null when unresolvable. */
  normalizedValue: StylesNormalizedValue | null;
  mechanism: string;
  filePath: string;
  line: number;
  context: string | null;
  variantContext: string | null;
  tokenRef: string | null;
};

/** A design token (CSS custom property) defined in a stylesheet. */
export type StylesToken = {
  name: string;
  value: string;
  filePath: string;
  mechanism: 'css-custom-property' | 'tailwind-theme';
  usageCount?: number;
  bypassCount?: number;
};

/** One class name used in a stylesheet (a `.foo` selector occurrence). */
export type StylesClassUsage = {
  className: string;
  filePath: string;
  line: number;
  mechanism: 'className' | 'class';
  unresolvable: boolean;
};

/** The normalized-value union: a color (hex+alpha), a length, or a literal. */
export type StylesNormalizedValue =
  | { type: 'color'; hex: string; alpha: number }
  | { type: 'length'; value: number; unit: string }
  | { type: 'literal'; value: string };

/**
 * A cross-language entity as a serializable fact — the projection of
 * `CrossLanguageEntity` that strips the non-serializable `Date` timestamps and
 * pins `metadata` to the keys the cross-language analyzers actually read
 * (`callees`, `isMethod`, `isExported`, `fileReferences`, `fields`). §3.2's
 * processor emits exactly this shape via `extractCrossLanguageEntities`
 * (pipelineAdapters.ts), which never sets the `Date` fields.
 */
export type Entity = {
  id: string;
  name: string;
  language: string;
  file: string;
  type: string;
  signature: string;
  parameters: ReadonlyArray<{ name: string; type?: string; optional?: boolean; language: string }>;
  calls: ReadonlyArray<{ sourceId: string; targetId: string; type: string }>;
  calledBy: ReadonlyArray<{ sourceId: string; targetId: string; type: string }>;
  visibility?: string;
  startLine?: number;
  endLine?: number;
  complexity?: number;
  purpose: string;
  context: string;
  searchTokens: string[];
  metadata?: {
    callees?: string[];
    isMethod?: boolean;
    isExported?: boolean;
    fileReferences?: string[];
    fields?: ReadonlyArray<{ name: string; type?: string; isExported?: boolean; tag?: string }>;
  };
};

/**
 * A DB call resolved by the data-access processor — the serializable projection
 * of `UniversalDataAccessAnalyzer`'s `DatabaseCall`. The initial `kind`/`raw`
 * declaration was a guess; §3.2 pins it to what `extractDatabaseCalls` actually
 * emits, because the data-access rules read the full set: `hasFilter`
 * (`unfiltered-query`), `hasSqlInjectionRisk`/`sqlEscaped` (`sql-injection-risk`),
 * `hasParameterizedQuery`, and `enclosingFunction` (stable fingerprinting).
 * `type` is the call's kind label (`db.query` / `db.execute` / …), not a SQL
 * verb — the write/read verb is derived at analysis time from `queryText`.
 */
export type ResolvedQuery = {
  type: string;
  method: string;
  file: string;
  line: number;
  column: number;
  tables: string[];
  /** The query statement's own text (comments stripped), query-scoped. */
  queryText: string;
  hasOrganizationFilter: boolean;
  hasFilter: boolean;
  hasParameterizedQuery: boolean;
  hasSqlInjectionRisk: boolean;
  /** True when the injection risk is manually quote-escaped (downgrades severity). */
  sqlEscaped: boolean;
  /** Enclosing function name for stable fingerprinting. */
  enclosingFunction?: string;
  /** True when the call is inside a loop (loop-query reads this). */
  insideLoop?: boolean;
};

/** The known-table catalog built by the corpus schema processor (§5). */
export type TableCatalog = {
  tables: ReadonlyArray<{ name: string; source: string }>;
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
  readonly ast: AST;
  /** The language adapter that parsed this file — the processor's only handle
   *  on the extraction API (`extractFunctions`, `extractClasses`, …). */
  readonly adapter: LanguageAdapter;
}

/** The fragment a per-file processor returns for one file. The fragment is the
 *  fact for that file alone, keyed by file so the parent can assemble corpus
 *  facts; the processor must have stripped any tree-sitter node before it
 *  crosses this boundary (the type enforces it — a node cannot satisfy
 *  {@link Serializable} and so cannot sit inside {@link FactShapes}[K]). */
export type FactFragment<K extends FactKind> = FactShapes[K];

/**
 * The formats that supply each *file* fact kind, declared per kind and never
 * inferred. A kind absent from this interface is corpus-produced
 * (`table-catalog`): it has no supplying format, only upstream facts (§5).
 *
 * This declaration is load-bearing, not documentation: a format named here
 * without a producer in {@link PRODUCERS} fails the mapped type, and a format
 * that cannot supply a concept is simply absent from the kind's set. This is
 * the Spec 68 §2 fix for the naming rule in its second form — a fact is named
 * for what it *is*, never for where it came from. `channel-operations` is
 * supplied by a `go` producer, a `rust` producer and a `typescript` producer;
 * there is no `go-channels` fact kind.
 */
export interface SupplyingFormats {
  'file-symbols': 'typescript' | 'tsx' | 'javascript';
  'function-index': 'typescript' | 'tsx' | 'javascript';
  'ddl-declarations': 'typescript' | 'tsx' | 'javascript';
  'schema-usage': 'typescript' | 'tsx' | 'javascript';
  'style-declarations': 'css' | 'scss';
  'cross-language-entities': 'typescript' | 'tsx' | 'javascript' | 'go';
  'data-access-calls': 'typescript' | 'tsx' | 'javascript';
}

/** A fact kind supplied from a file — every key of {@link SupplyingFormats}. */
export type FileFactKind = keyof SupplyingFormats;

/** A fact kind supplied by corpus reduction — every kind with no supplying format. */
export type CorpusFactKind = Exclude<FactKind, FileFactKind>;

/** A per-(kind, format) file processor: one producer per format, never one per
 *  kind with a format list. Two producers for one (kind, format) is a duplicate
 *  key; a (kind, format) with no producer is a type error against
 *  {@link SupplyingFormats}. */
export interface FileProcessor<K extends FileFactKind, F extends SupplyingFormats[K] = SupplyingFormats[K]> {
  readonly id: ProcessorId;
  readonly produces: K;
  /** The one format this producer serves (the map key, mirrored for clarity). */
  readonly format: F;
  /** The only place an AST is reachable. */
  process(file: ParsedFile): FactFragment<K>;
}

/** A corpus processor: receives complete upstream facts, no AST, no format. */
export interface CorpusProcessor<K extends CorpusFactKind, N extends readonly FactKind[]> {
  readonly id: ProcessorId;
  readonly produces: K;
  readonly needs: N;
  process(facts: { readonly [J in N[number]]: FactShapes[J] }): FactShapes[K];
}
