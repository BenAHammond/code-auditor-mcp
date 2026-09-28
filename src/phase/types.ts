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
import type { IndexHandle } from '../types.js';

export interface FactShapes {
  /** Reserved: an AST is not a fact and cannot be declared. */
  ast: never;
  'file-symbols': FileSymbols[];
  'function-index': FunctionIndexFact[];
  'function-bodies': FunctionBodyFact[];
  'imports': ImportFact[];
  'export-form': ExportFormFact[];
  'import-form': ImportFormFact[];
  'string-literals': StringLiteralFact[];
  'secret-candidates': SecretCandidate[];
  'security-candidates': SecurityCandidate[];
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
  'schema-objects': SchemaObject[];
  'style-declarations': StyleDeclarationsFile[];
  'cross-language-entities': Entity[];
  'data-access-calls': ResolvedQuery[];
  'loop-queries': LoopQueryFact[];
  'dynamic-sql': DynamicSqlFact[];
  'table-catalog': TableCatalog;
  'migration-history': MigrationHistory;
  'mined-conventions': MinedConvention[];
  'react-component': ReactComponentScan[];
  'file-header': FileHeaderFact[];
  'code-block': CodeBlockFact[];
  'json-document': JsonDocumentFact[];
  'schema-validations': SchemaValidationFact[];
  'file-imports': FileImportsFact[];
  'reachability': ReachabilityFact;
  'type-declarations': TypeDeclarationsFact[];
  'go-functions': GoFunctionFact[];
  'go-switches': GoSwitchFact[];
  'error-bindings': ErrorBindingsFact[];
  'concurrency-primitives': ConcurrencyPrimitivesFact[];
  'channel-operations': ChannelOperationsFact[];
  'call-graph': CallGraphFact;
  'batch-functions': BatchFunctionFact[];
  'hotspot': HotspotFact[];
  'coverage': CoverageFact;
  'clone-pair-history': ClonePairHistoryFact;
  'defined-classes': DefinedClassesFact[];
  'unread-style-sources': UnreadStyleSourceFact[];
}

/** Every fact kind a rule or processor may declare. `ast` is excluded. */
export type FactKind = Exclude<keyof FactShapes, 'ast'>;

/**
 * The file formats the phase model reads.
 *
 * `'json'` was added in Amendment 1 of the fact-vocabulary pass: a JSON file is
 * a *format* like any other, parsed by a position-preserving JSON adapter, so
 * the `declared-schemas` / `schema-validations` rules go through the same
 * per-file model as every other rule instead of reading `.json` files off disk
 * through a config callback.
 *
 * `'sql'` is the one text-only format: a `.sql` migration file has no grammar
 * and no adapter, so its `ParsedFile` carries no `ast`/`adapter`. It supplies
 * exactly one fact (`ddl-declarations`) whose producer reads `.source`/`.file`
 * only — the whole file *is* DDL, unlike code where DDL is embedded in string/
 * template literals.
 *
 * `'markup'` is the second text-only format: an `.astro`/`.vue`/`.svelte`/
 * `.html` component has no grammar or adapter either (the language registry only
 * resolves TS/JS/Go/CSS/JSON), so its `ParsedFile` likewise carries no
 * `ast`/`adapter`. It supplies the `style-declarations` fact via the same regex
 * extractors the legacy style indexer ran (`extractDeclarations`' markup branch +
 * `extractClassUsage`), so class usage and embedded `<style>` declarations from
 * component files survive the phase-model migration — otherwise `undefined-class`
 * would lose every markup finding.
 */
export type Format = 'typescript' | 'tsx' | 'javascript' | 'go' | 'css' | 'scss' | 'json' | 'sql' | 'markup';

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
 * `instanceofTargets`, `throws` and `aggregateComplexity` are the pre-computed
 * signals those rules used to walk the AST to obtain. `jsDoc` (the comment
 * *text*, not a boolean) and
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
  /** True when private/protected/#-named/_-prefixed (R1.2 non-public skip). */
  isNonPublic: boolean;
  /** Return-type annotation (return-documentation reads this). */
  returnType?: string;
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
  /** True when an anonymous/inline callable (arrow or function expression used
   *  as a call argument, JSX value, or IIFE) — R1.1 skip. */
  isAnonymousOrCallback: boolean;
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
  /** The non-builtin `instanceof` target names in the class body (open-closed
   *  resolves these against repo declarations to skip Error subclasses). */
  instanceofTargets: string[];
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

/**
 * One function/method/arrow body, the serializable projection of the adapter's
 * `extractFunctions` (`FunctionInfo[]`) resolved back to its node for the full
 * source text. `too-many-queries` counts query call sites over `text`, so the
 * producer carries the *full* node text (`getNodeText`) rather than the
 * `statement_block` alone — an expression-bodied arrow has no block and would
 * otherwise read `null` while the legacy walk still counts its queries. The
 * `column` is the 1-based start column `function-index` drops, and the node set
 * is `extractFunctions`' full set (generator/function-expression/arrow), which
 * is wider than `function-index`'s visitor — a deliberate split: the DB index
 * and this per-file fact answer different questions.
 */
export type FunctionBodyFact = {
  file: string;
  name: string;
  line: number;
  column: number;
  text: string;
};

/**
 * One import statement, the serializable projection of the adapter's
 * `ImportInfo` (types.ts) — `source` plus the 1-based start position. The
 * `duplicate-import` rule groups by `(file, source)`: the legacy
 * `checkDuplicateImports` ran per AST, so two files importing the same module
 * once are NOT duplicates — only repeats within one file are. `specifiers` is
 * not projected (no migrated rule reads it; `conventions/import-form`, which
 * does, stays on the legacy path and reads source text via `parseFileImports`).
 *
 * `alias` is the Go local import name (`import f "os"` → `f`, `import . "x"` →
 * `.`, `import _ "embed"` → `_`), `null`/absent for an unnamed import. The
 * Go `import-style` rule reads `alias === '.'` (dot-import detection); the
 * TypeScript producers leave it absent (TS has no Go-style local name — its
 * import shape is `import-form`'s concern).
 */
export type ImportFact = {
  file: string;
  source: string;
  line: number;
  column: number;
  alias?: string | null;
};

/**
 * One import statement's *form*, the serializable projection of
 * `parseFileImports` (conventionMiner.ts) that `conventions/import-form` reads:
 * the module source plus the classified import shape (`default` / `named` /
 * `namespace` / `side-effect` / `require`) and the 1-based line the finding
 * anchors to. This is deliberately NOT derivable from the AST `imports` fact —
 * `conventions/import-form`'s legacy detector ran the regex `parseFileImports`
 * over raw source text (which classifies forms like `default`-plus-`named` and
 * `require` destructuring the AST extractor does not), so the producer re-runs
 * that same regex over `file.source` to stay byte-identical. `localNames` is
 * dropped: the legacy finding carried it only in `details`, which the unified
 * `Finding` shape has no field for.
 */
export type ImportFormFact = {
  file: string;
  source: string;
  form: 'default' | 'named' | 'namespace' | 'side-effect' | 'require';
  line: number;
};

/**
 * One export declaration, the serializable projection of the adapter's
 * `extractExports` (`ExportInfo[]`) that `conventions/export-shape` reads: the
 * exported name plus whether it is a default export. The `location` the adapter
 * returns is dropped — the export-shape finding anchors to the *function*'s
 * `function-index` line, never the export statement's, so position is a key the
 * rule does not read. One element per `export_statement` (the producer walks
 * `extractExports` in source order, matching the legacy `exportsMap` built from
 * the same adapter call).
 */
export type ExportFormFact = {
  file: string;
  name: string;
  isDefault: boolean;
};

/**
 * One string or template-string literal, the serializable projection of its
 * node: the raw source text (`getNodeText` — quotes/backticks included, so the
 * grouping key matches the legacy `checkDuplicateStrings` exactly) plus the
 * 1-based start position. The `duplicate-string-literal` rule groups by
 * `(file, value)`.
 *
 * `enclosingFunction` is the enclosing identity label
 * (`functionIdentityLabel(findEnclosingFunctionIdentity(...))`) the producer
 * computes where the AST still lived; `hardcoded-connection` uses it for its
 * symbol. Top-level literals carry `'top-level'`.
 */
export type StringLiteralFact = {
  file: string;
  value: string;
  line: number;
  column: number;
  enclosingFunction: string;
};

/**
 * One loop-query candidate: a loop (including a nested loop) whose body issues a
 * DB call, the serializable projection the `loop-query` rule reads. The producer
 * computes everything the legacy `checkLoopQueries` needed from the AST — the
 * anchor line/column (the resolved query-call callee), the enclosing loop's line
 * and nesting depth, and the stable per-file symbol (`nextSymbol(enclosingIdentity(…),
 * 'loop-query', …)`) — so `analyze` is a pure projection. Dedup (one fact element
 * per *loop*, not per query) and the LLM/queue suppression both ran in the
 * producer where the AST lived, matching the legacy one-finding-per-loop contract
 * (defect #51).
 */
export type LoopQueryFact = {
  file: string;
  /** 1-based line of the resolved query-call anchor (the `db` receiver). */
  line: number;
  /** 1-based column of the resolved query-call anchor. */
  column: number;
  /** The stable per-file symbol key the legacy finding carried as `functionName`. */
  symbol: string;
  /** 1-based line of the enclosing loop's opening token. */
  loopLine: number;
  /** Nesting depth of the enclosing loop (1 = top-level, 2 = nested once, …). */
  depth: number;
};

/**
 * One dynamic-SQL construction candidate: a `query(`/`execute(` call site whose
 * string argument is built by interpolation or concatenation and is not provably
 * taint-safe. The producer runs the full legacy `checkSQLInjection` extraction —
 * the regex scan, the parameterized-query skip (`query(sql, params)`), the
 * enclosing-call + dynamic-parts safety analysis, and the per-function symbol
 * ordinal — so `analyze` is a pure projection. `enclosingFn` is the bare
 * function label the message interpolates; `symbol` is the full
 * `<enclosingFn>:dynamic-sql-construction[:ordinal]` key the legacy finding
 * carried as `functionName`.
 */
export type DynamicSqlFact = {
  file: string;
  /** 1-based line of the matched query/execute string argument. */
  line: number;
  /** 1-based column of the matched query/execute string argument. */
  column: number;
  /** The enclosing function/method label (`functionIdentityLabel`), or 'top-level'. */
  enclosingFn: string;
  /** The stable per-file symbol key the legacy finding carried as `functionName`. */
  symbol: string;
};

/**
 * One hardcoded-credential *candidate*: a string in a credential position, as
 * the `secret-candidates` producer extracts it from a variable/assignment/pair
 * or a call's sibling string arguments. The producer computes only what the AST
 * makes reachable — the name/key/args plus the enclosing node's start position
 * (the legacy analyzer anchored at the enclosing node, not the string). The
 * `isSecretName` / `looksLikeRealSecret` / `isCredentialSelector` classification
 * is the rule's: the producer never decides "is this a secret", it only projects
 * the positional context. A `call` candidate carries the *sibling* string-arg
 * values so the rule can re-run the selector/secret split the legacy
 * `checkCredentialCall` did.
 */
export type SecretCandidate =
  | {
      /** The credential position: a variable, an assignment, or an object pair. */
      position: 'declarator' | 'assignment' | 'pair';
      /** The credential name/key (`password`, `apiKey`, …). */
      name: string;
      /** The candidate value (quotes/backticks stripped). */
      value: string;
      file: string;
      line: number;
      column: number;
    }
  | {
      position: 'call';
      /** The call's sibling string-argument values (selector + secret), in order. */
      args: readonly string[];
      file: string;
      line: number;
      column: number;
    };

/**
 * One candidate for the three single-file security rules (`UniversalSecurity
 * Analyzer`), as the `security-candidates` producer extracts it. The producer
 * runs the structural half the legacy `analyzeAST` walk did — it identifies the
 * unsafe shell invocation, the computed require/import specifier, and the
 * sink-reaching unescaped HTML interpolation — and projects each onto a plain
 * tuple plus the enclosing node's start position. The rule owns the pure-text
 * classification (`isConfigPath`, the test/fixture skip) and the finding
 * construction (message/resolution/severity).
 */
export type SecurityCandidate =
  | {
      /** A shell/process invocation whose command is built by interpolation or
       *  concatenation (the producer already resolved `unsafe`). */
      kind: 'command-injection';
      fnName: string;
      file: string;
      line: number;
      column: number;
    }
  | {
      /** A `require()`/`import()`/`createRequire(...)()` whose specifier is
       *  computed (not a literal); `argText` is the raw specifier source and
       *  `calleeText` the callee's raw text (`require`/`import`/`createRequire(…)`),
       *  which the resolution's `symbols` names. */
      kind: 'dynamic-require';
      argText: string;
      calleeText: string;
      file: string;
      line: number;
      column: number;
    }
  | {
      /** A template substitution that reaches an HTML sink unescaped; `prop` is
       *  the member-access property interpolated. */
      kind: 'unescaped-html';
      prop: string;
      file: string;
      line: number;
      column: number;
    };

/**
 * One DDL state transition parsed from migration SQL — the serializable
 * projection of the schema analyzer's `MigrationOp` (same three arms), carried
 * so the `migration-history` corpus processor can replay CREATE/DROP/RENAME
 * across files in migration order.
 */
export type MigrationOpFact = {
  op: 'CREATE' | 'DROP' | 'RENAME';
  table: string;
  newTable?: string;
};

/**
 * The DDL facts extracted from one file — the per-file projection of the schema
 * analyzer's migration replay. One entry per file that contains DDL, even a
 * migration whose net effect is only to DROP tables (zero surviving tables):
 * `ops` is the ordered CREATE/DROP/RENAME sequence, and `tableColumns` the
 * per-table column names the file declares. The corpus processors replay `ops`
 * across files in migration order — a table dropped in a later migration is a
 * stale reference, not a declaration — so the fact must carry a DROP-only file
 * too, not just the tables that survive it.
 */
export type SchemaDeclaration = {
  file: string;
  ops: readonly MigrationOpFact[];
  tableColumns: Readonly<Record<string, readonly string[]>>;
};

/**
 * One ORM schema-object declaration: a `const <identifier> = pgTable|mysqlTable|
 * sqliteTable('<table>', …)` binding. The identifier is the JS name the code
 * references (`.from(sampleOwnership)`), and `table` is the SQL name the DDL
 * catalog keys on (`sample_ownership`). The `table-catalog` corpus reducer
 * builds an alias map from these so a query referencing the identifier reaches
 * the catalog entry the identifier names — the Drizzle chain that was broken
 * before: `.from(sampleOwnership)` extracted `sampleOwnership`, which matches no
 * catalog key (`sample_ownership`), so tenant-scoped tables queried through a
 * schema object were invisible to `missing-org-filter`.
 */
export type SchemaObject = {
  file: string;
  /** The JS binding name (`sampleOwnership`). */
  identifier: string;
  /** The declared SQL table name (`sample_ownership`). */
  table: string;
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

/** One defined CSS class (a `.foo` selector), with its defining file. The
 *  corpus fact is the full `style_defined_classes` catalog — the
 *  `styles/undefined-class` rule resolves candidate class names against it
 *  (membership lookup) and near-miss-suggests against it (Levenshtein ≤2), both
 *  in memory rather than through batched `IN (...)` index lookups. */
export type DefinedClassesFact = {
  className: string;
  filePath: string;
};

/** One stylesheet source the style indexer could not read (Spec 45 R5). The
 *  `styles/undefined-class` rule carries the full list as
 *  `details.incompleteDefinitions` so "undefined" reads as "not defined in any
 *  *read* stylesheet" rather than a definitive assertion. Read from the
 *  `style_unread_sources` index table by the `unread-style-sources` corpus
 *  producer — the same source the legacy reducer threaded as `unreadStyleSources`. */
export type UnreadStyleSourceFact = {
  filePath: string;
  reason: string;
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

/** The known-table catalog built by the corpus schema processor (§5). Each
 *  table carries its DDL-declared column names so Tier 3 tenant discovery
 *  (`missing-org-filter`) can read tenancy from the corpus, not just config.
 *  `aliases` maps ORM schema-object identifiers (`sampleOwnership`) to their
 *  declared SQL names (`sample_ownership`), so a query referencing the
 *  identifier resolves to the catalog entry it names. */
export type TableCatalog = {
  tables: ReadonlyArray<{ name: string; source: string; columns: ReadonlyArray<string> }>;
  aliases: Readonly<Record<string, string>>;
};

/**
 * A config-declared table the phase `table-catalog` producer merges alongside
 * the DDL-derived tables. §5 parity: the legacy schema reducer added the
 * schema analyzer's `knownTables` string list and structured `schemas` to the
 * known-table set (the "external authority" the `unknown-table` fail-open guard
 * requires). The corpus producer must add them too or a config-only schema
 * silently triggers fail-open and `unknown-table` never fires.
 */
export type ExternalTableDecl = {
  name: string;
  /** Provenance label (`'external-config'` or `Schema: <name>`). */
  source: string;
  /** Declared column names (empty for a `knownTables` string entry). */
  columns: ReadonlyArray<string>;
};

/**
 * The drop-provenance catalog built by the corpus `migration-history` processor
 * (§5) — the serializable projection of the legacy schema reducer's
 * `dropProvenance` map. A table appears here only when a migration dropped it
 * and no later migration recreated it (the self-contained scratch-table case —
 * created and dropped within one file — is excluded). `stale-table-reference`
 * reads it to distinguish "existed and was dropped" (a stale code reference)
 * from "never existed" (a typo → `unknown-table`).
 */
export type MigrationHistory = {
  /** Dropped table name → which migration dropped it, and what that migration created. */
  dropped: Readonly<Record<string, { migrationFile: string; createdInSameMigration: readonly string[] }>>;
};

/**
 * One mined convention, as the `mined-conventions` corpus fact carries it. This
 * is the serializable projection of the `Convention` interface (types.ts) minus
 * the DB-assigned/storage-only fields (`id`, `hash`, `created_at`): detection
 * reads the domain, the antecedent/consequent/pattern, the directory it scopes,
 * the confidence the miner computed, and the exemplar anchor — never the
 * change-detection hash (that belongs to the SQLite index-sync path, which the
 * phase model has no analogue of).
 *
 * Object-literal `type` (not `interface`) so §4's `Serializable` index-signature
 * arm holds.
 */
export type MinedConvention = {
  domain: 'usage-pair' | 'import-form' | 'error-handling' | 'export-shape' | 'naming';
  rule_id: string;
  antecedent: string | null;
  consequent: string | null;
  pattern: string | null;
  directory: string | null;
  file_path: string | null;
  line: number | null;
  support: number;
  total_cases: number;
  confidence: number;
  exemplar_file: string | null;
  exemplar_line: number | null;
  /** For naming conventions: the sub-population (react-component, hook, function). */
  export_kind?: string | null;
};

/**
 * One scanned React component, as the `react-component` producer projects it.
 * This is the object-literal (serializable) projection of `ComponentMetadata`
 * (types.ts), which is an `interface` and so cannot satisfy §4's `Serializable`
 * index-signature arm. The producer is the `scanParsedFile` half of
 * `componentScanner.scanFile` — the same tree-sitter walk the legacy react
 * visitor ran — projected onto plain data before the AST dies with the file.
 * The rules re-cast this shape back to `ComponentMetadata`/`ComponentScanResult`
 * (structurally identical) and run the existing `analyzeComponent` /
 * `checkCircularDependencies` / `checkErrorBoundaryUsage` / `checkRawElements`
 * detectors, so the classification half is bit-identical to the legacy path.
 */
export type ReactComponentScan = {
  filePath: string;
  components: ReactComponentMetadata[];
  imports: ReactComponentImport[];
  fileHash?: string;
  parseErrors?: string[];
};

/** The serializable projection of `ComponentMetadata` (the scanner's fields). */
export type ReactComponentMetadata = {
  name: string;
  filePath: string;
  lineNumber?: number;
  startLine?: number;
  endLine?: number;
  entityType: 'component';
  componentType: 'functional' | 'class' | 'memo' | 'forwardRef';
  dependencies: string[];
  purpose: string;
  context: string;
  isExported: boolean;
  body?: string;
  props?: ReactPropDefinition[];
  hooks?: ReactHookUsage[];
  jsxElements?: string[];
  jsxElementDetails?: ReactJsxElementDetail[];
  hasErrorBoundary?: boolean;
  complexity?: number;
};

/** The serializable projection of `ComponentImport`. */
export type ReactComponentImport = {
  name: string;
  path: string;
  isDefault: boolean;
};

/** The serializable projection of `PropDefinition`. */
export type ReactPropDefinition = {
  name: string;
  type?: string;
  required: boolean;
  hasDefault: boolean;
};

/** The serializable projection of `HookUsage`. */
export type ReactHookUsage = {
  name: string;
  line: number;
  customHook: boolean;
};

/** The serializable projection of `JsxAttributeDetail`. */
export type ReactJsxAttributeDetail = {
  name: string;
  line: number;
  valueKind: 'string' | 'arrow' | 'function' | 'identifier' | 'other' | 'none';
};

/** The serializable projection of `JsxElementDetail`. */
export type ReactJsxElementDetail = {
  tagName: string;
  line: number;
  attributes: ReactJsxAttributeDetail[];
};

/**
 * The per-file `file-header` fact — the leading documentation comment a file
 * carries (or `null` when there is none). The producer runs the legacy
 * `getFileDocumentation` walk (the AST root's first child, or the comment
 * preceding it) and projects just the trimmed text; the `file-documentation`
 * rule re-applies `isFileHeaderDoc` (a `@fileoverview`/`@file`/`@module`/
 * `@overview`/`@purpose` marker) so the *classification* — "is this comment a
 * file header, or a license block?" — stays the rule's, not the producer's.
 */
export type FileHeaderFact = {
  file: string;
  /** The trimmed leading comment text, or null when the file has none. */
  headerDoc: string | null;
};

/**
 * The per-file `code-block` fact — the serializable projection of the two things
 * `UniversalDRYAnalyzer` extracted from an AST: *blocks* (function/class/method/
 * control-flow spans, with the normalized hash and structural skeleton the
 * duplicate rules compare) and *shape fragments* (an object literal's field
 * names or a call chain's method names, which `similar-expression` compares).
 *
 * One fact kind carries both because the three DRY rules share the one walk; the
 * `kind` discriminator is the split the rule reads. The producer computes `hash`
 * and `structuralSkeleton` with the default normalization (comments/whitespace
 * ignored) but applies no threshold and no dedup — `minLineThreshold`,
 * `similarityThreshold`, `minShapeNames`, `excludePatterns`, the check-gates and
 * both dedup passes are the rules', re-applied over this plain data in the
 * legacy order (filter → dedupe → compare).
 */
export type CodeBlockFact = CodeBlockBlock | CodeBlockFragment;

/** A code block: an extractable span, with the duplicate rules' comparison keys. */
export type CodeBlockBlock = {
  kind: 'block';
  file: string;
  nodeType: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  text: string;
  /** SHA-256 of the normalized text (exact-duplicate grouping key). */
  hash: string;
  /** Token-kind skeleton (identifiers→ID, literals→LIT) for Jaccard similarity. */
  structuralSkeleton: string;
  lineCount: number;
};

/** A shape fragment: an object literal's fields or a call chain's methods. */
export type CodeBlockFragment = {
  kind: 'fragment';
  file: string;
  /** `'object'` for an object literal, `'chain'` for a call chain. */
  fragmentKind: 'object' | 'chain';
  /** Object literals only: the assignment/declaration target (chains leave it undefined). */
  target?: string;
  /** Field names (object) or method names (chain), in source order. */
  names: string[];
  /** Raw source text, used for the fix patch. */
  text: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
};

/**
 * The recursive JSON value universe — exactly what `JSON.parse` can produce.
 * It is a plain-data tree (no functions, no class instances), so it satisfies
 * §4's `Serializable` arm and a parsed JSON document can be a fact. Unlike
 * `Serializable`'s permissive `{ readonly [k: string]: Serializable }` object
 * arm, this union is deliberately exhaustive: it is the value set the JSON
 * grammar admits, so a JSON document never carries a `Date`, `Map`, or other
 * non-JSON value through a fact boundary.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

/**
 * One parsed JSON document, as the `json-document` producer projects it. The
 * producer `JSON.parse`s the file's `.source` and stores the raw value (or
 * `null` on a parse failure) — matching the legacy schema reducer's `readJson`,
 * which returned `null` for a parse error, the literal `null`, and any
 * non-object value alike. The corpus `schema-validations` processor re-applies
 * the `object`-only filter (an array/string/number/boolean document reads back
 * as `null`), so the two paths stay byte-identical on the value the legacy
 * `analyzeJsonSchemas` consumed.
 */
export type JsonDocumentFact = {
  file: string;
  /** The parsed JSON value, or null when the file is invalid or a non-object. */
  json: JsonValue | null;
};

/**
 * One JSON-schema validation outcome, as the `schema-validations` corpus
 * processor projects it. This is the serializable projection of a legacy
 * `analyzeJsonSchemas` violation — the same `(rule, file, severity, message)`
 * plus the `line:1, column:1` the JSON visitor hardcoded (JSON files have no
 * AST position the old path used). The 17 schema-json rules filter this fact by
 * their own rule id and project it to `Finding`: the classification (which rule
 * fired, at what severity, with what message) is the processor's, re-homed
 * verbatim from the legacy free functions, so each rule is a thin projection.
 */
export type SchemaValidationFact = {
  rule: string;
  file: string;
  line: number;
  column: number;
  severity: import('../types.js').Severity;
  message: string;
};

/**
 * One file's import specifiers and export declaration, as the `file-imports`
 * producer extracts it (§8 reachability). The serializable projection of the
 * legacy `ClFileInfo` the cross-language visitor emitted alongside its entities:
 * the resolved static import sources, whether the file exposes any symbols
 * (TS/JS `export_statement`; Go capitalized top-level names), and the
 * computed-specifier dynamic imports that cannot become an import edge.
 * `unreferenced-module` reads this fact plus the corpus `reachability` fact.
 */
export type FileImportsFact = {
  file: string;
  /** Resolved static import specifiers (quotes stripped), re-exports included. */
  imports: string[];
  /** True when the file exposes symbols to importers (TS/JS `export`, Go public). */
  hasExports: boolean;
  /** Dynamic `import()`/`require()` with a computed (non-static) specifier. */
  unresolvedDynamicImports: ReadonlyArray<{ line: number; expression: string }>;
};

/**
 * The corpus-level `reachability` fact, reduced from `file-imports` (§8). It
 * carries the reverse import adjacency (`importersOf`: target file → the files
 * that import it) and the package.json entry-point set — the two things
 * `unreferenced-module` needs beyond the per-file `hasExports`/test/entry
 * filename heuristics. Both are plain data (a `Set`/`Map` are class instances
 * and cannot satisfy §4's `Serializable` arm), so they are projected to sorted
 * `string[]` values and `Record<string, string[]>`.
 */
export type ReachabilityFact = {
  /** Absolute target path → the absolute paths that import it (sorted, deduped). */
  importersOf: Record<string, string[]>;
  /** package.json entry points (facade-expanded), absolute — entry points, not dead. */
  packageEntryPoints: string[];
};

/**
 * One Go type declaration (a named struct or a named interface), as the
 * `type-declarations` producer projects it (§9). The serializable projection of
 * the Go binary's `Struct`/`Interface` extracts — the name, 1-based start line,
 * and the member count the size rules threshold on:
 *
 *   - a struct's `fieldCount` is the *expanded* field-name count (a
 *     `GroupA, GroupB, GroupC int` field is three, an embedded `Embedded` field
 *     is one), matching the Go binary's `len(structType.Fields.List)` expansion;
 *   - an interface's `methodCount` is its named `method_elem` count — embedded
 *     types are not methods, matching the Go binary's `len(method.Names) > 0`
 *     filter.
 *
 * `struct-size` (fieldCount > 15) and the Go arm of `interface-size`
 * (methodCount > 10) read this fact. Anonymous struct/interface literals are
 * never `type_spec` nodes, so they are absent here (the Go binary likewise only
 * extracts named `*ast.TypeSpec` declarations).
 */
export type TypeDeclarationsFact =
  | { kind: 'struct'; file: string; name: string; line: number; fieldCount: number }
  | { kind: 'interface'; file: string; name: string; line: number; methodCount: number };

/**
 * One Go function/method's size + behaviour metrics, as the `go-functions`
 * producer projects it (§9). The serializable projection of the Go binary's
 * `Function` extract for the two rules that read it:
 *
 *   - `function-size` (complexity > 20 AND returnCount > 2 AND
 *     parameterCount > 6 — the Go binary's AND-combined size signal);
 *   - `liskov-substitution` (isMethod && callsPanic — a method whose body has a
 *     direct `panic()` call).
 *
 * `line` is the `func` keyword's 1-based line (`funcDecl.Pos().Line`).
 * `complexity` is the Go binary's `calculateComplexity`: base 1, +1 per
 * if/for/range/switch/type-switch and per case/default clause. `parameterCount`
 * is expanded (a `A, B, C int` declaration is three); `returnCount` is the
 * number of result entries (0 for none, 1 for a single result, N for a
 * parenthesised list). Test functions (`Test`/`Benchmark`/`Example`/`Fuzz`
 * prefix) are excluded — the Go binary's `ExtractFunctions` skips them.
 */
export type GoFunctionFact = {
  file: string;
  name: string;
  line: number;
  isMethod: boolean;
  parameterCount: number;
  returnCount: number;
  complexity: number;
  callsPanic: boolean;
};

/**
 * One Go `switch` / `type switch` statement's case-clause count, as the
 * `go-switches` producer projects it (§9). `caseCount` counts `case` and
 * `default` clauses alike (the Go binary's `countSwitchCases` / `countTypeSwitchCases`
 * iterate `Body.List`, where a `default:` is a `CaseClause` too). `line` is the
 * `switch` keyword's 1-based line (`node.Pos().Line`). `switch-size` flags a
 * count > 8.
 */
export type GoSwitchFact = {
  file: string;
  line: number;
  caseCount: number;
  kind: 'switch' | 'type-switch';
};

/**
 * One Go function's error-binding positions, as the `error-bindings` producer
 * projects them (§9). The serializable projection of the Go binary's
 * `functionDropsError` inputs — the per-function source positions of every
 * `err` binding-from-a-call and every "checking" use, plus the named-return
 * signal the bare-`return` arm needs. The `error-handling` rule re-applies the
 * position-ordering verdict (an assign is dropped iff no check falls strictly
 * after it and before the next assign) over plain data.
 *
 * Positions are byte offsets (`ASTNode.range[0]`), so they carry the same total
 * order the Go binary's `token.Pos` byte offsets did. `line` is the `func`
 * keyword's 1-based line (`funcDecl.Pos().Line`). Test functions
 * (`Test`/`Benchmark`/`Example`/`Fuzz`) are excluded — the Go binary's walk
 * skips them. `hasNamedErr` is the `funcDeclHasNamedErr` result: the function
 * names an `err` result, so a bare `return` counts as a check.
 */
export type ErrorBindingsFact = {
  file: string;
  name: string;
  line: number;
  hasNamedErr: boolean;
  /** Byte offsets of `err` identifiers bound from a call-bearing assignment. */
  assignPositions: number[];
  /** Byte offsets of `err` checking uses (compare / return / pass / ignore). */
  checkPositions: number[];
};

/**
 * One Go function's goroutine-synchronization signal, as the
 * `concurrency-primitives` producer projects it (§9). The serializable
 * projection of the Go binary's `analyzeConcurrency` — whether the body has a
 * `go` statement and whether it carries any synchronization signal (a
 * sync.Add/Done/Wait/Lock/Unlock/RLock/RUnlock selector call, or a channel
 * send/receive). The `concurrency` rule re-applies the `hasGo && !hasSync`
 * verdict. `line` is the `func` keyword's 1-based line; test functions are
 * excluded.
 */
export type ConcurrencyPrimitivesFact = {
  file: string;
  name: string;
  line: number;
  /** A `go` statement anywhere in the body. */
  hasGo: boolean;
  /** Any sync primitive or channel send/receive in the body. */
  hasSync: boolean;
};

/**
 * One Go function's channel-operation counts, as the `channel-operations`
 * producer projects it (§9). The serializable projection of the Go binary's
 * `deadlockChannel` inputs — the unbuffered-channel names (`make(chan T)` with
 * one argument) and the send/receive counts per bare-identifier channel name,
 * plus the `go`-statement signal that clears the verdict. The
 * `channel-deadlock` rule re-applies the `hasGo → ""`, `ops[name] >= 2` verdict
 * over plain data. `line` is the `func` keyword's 1-based line; test functions
 * are excluded.
 */
export type ChannelOperationsFact = {
  file: string;
  name: string;
  line: number;
  /** A `go` statement anywhere in the body (makes the deadlock unprovable). */
  hasGo: boolean;
  /** Channel names assigned `make(chan T)` (unbuffered). */
  unbuffered: string[];
  /** Send/receive counts per bare-identifier channel name. */
  ops: Record<string, number>;
};

/**
 * The index-backed call-graph fact (§2.2) — the function catalog and the
 * function→function call edges the legacy `graph_cache` carried, read by the
 * corpus `call-graph` producer from the code index. Plain-data projection: no
 * handle survives the corpus boundary. `functions` is the `functions` table's
 * identity projection (id → {name, filePath, lineNumber, usedImports,
 * isExported}) the depth-1 callee expansion maps a `filePath::name` key through
 * and the validation-bypass provenance (`buildValidatorIds`) reads its
 * `usedImports`/`isExported` through; `callEdges` is `graph_cache`'s `call`
 * edges (fromId → toId), parsed from its string node/neighbor keys.
 *
 * `lineNumber` is the raw `line_number` column (nullable) — the uncovered-risk
 * ranking reads `f.line_number` as the finding anchor, so the fact carries it
 * verbatim. `usedImports` is the raw `used_imports` JSON-array string (or null)
 * — the provenance check `used_imports LIKE '%"zod"%'` runs over that exact
 * string, so the fact carries it verbatim rather than re-parsing. `isExported`
 * is the boolean projection of the `is_exported` 0/1 column.
 */
export type CallGraphFact = {
  functions: ReadonlyArray<{
    id: number;
    name: string;
    filePath: string;
    lineNumber: number | null;
    usedImports: string | null;
    isExported: boolean;
  }>;
  callEdges: ReadonlyArray<{ fromId: number; toId: number }>;
};

/**
 * One function whose full source span contains `.batch(` (a Cloudflare D1 /
 * SQLite transaction-batching commit). The per-file `batch-functions` producer
 * walks function nodes and projects only the location span; `multi-table-write`
 * checks whether a writer's line falls inside one of these spans to skip the
 * transaction-boundary flag — the legacy `enclosingFunctionBatches` re-parse
 * (`readFileSync` + `parseFile` + ancestor walk) re-homed as a fact. A function
 * is emitted only when its full node range contains `.batch(` (the legacy test),
 * so containment here is `startLine <= writeLine <= endLine`.
 */
export type BatchFunctionFact = {
  file: string;
  startLine: number;
  endLine: number;
};

/**
 * One `hotspot_scores` row, read by the corpus `hotspot` producer — the
 * risk-score side of the uncovered-risk ranking. `target` is the
 * `file_path || ':' || name` composite key the legacy `queryHighRiskFunctions`
 * LEFT-JOINed on (`hs.type = 'function'`); the rule re-joins it over the
 * `call-graph` fact's function identity. Plain data: target, type, score only.
 */
export type HotspotFact = {
  target: string;
  type: string;
  score: number;
};

/**
 * The index-backed coverage fact — the `coverage_data` table plus the two
 * measured-path metadata reads (`source`/`imported_at` LIMIT 1 and the
 * `last_full_sync_timestamp` meta key for stale-import detection). `entries`
 * carries the (functionName, filePath, covered) identity projection the legacy
 * `getUntestedTopDecile`'s `best_coverage` CTE read (covered=1 rows mark a
 * function as "tested"); `measuredCount` is `COUNT(*) WHERE basis='measured'`
 * — the dispatcher between the measured and static-reach paths. `lastFullSync`
 * is `getMeta('last_full_sync_timestamp')` (or null when absent).
 */
export type CoverageFact = {
  measuredCount: number;
  source: string | null;
  importedAt: string | null;
  lastFullSync: string | null;
  entries: ReadonlyArray<{
    functionName: string;
    filePath: string;
    covered: boolean;
  }>;
};

/**
 * The index-backed clone-pair-history fact — the `dry_pair_history` rows the
 * `dry/diverging-clone` rule's cross-run divergence pass reads. Grouped by
 * fingerprint (the pair identity `getDryPairs` seeds, stable across runs), each
 * group carries the per-run similarity series plus the file/line anchors from
 * its most recent row — the location the legacy Phase 2 read via
 * `ORDER BY timestamp DESC LIMIT 1`. Plain data only: no AST, no handle.
 */
export type ClonePairHistoryFact = ReadonlyArray<{
  fingerprint: string;
  file1: string;
  file2: string;
  line1: number;
  line2: number;
  rows: ReadonlyArray<{ similarity: number; timestamp: string }>;
}>;

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
  /** Structured text-replacement patch (DRY `duplicate-string-literal`), carried
   *  verbatim so the phase re-emission preserves the pre-migration `fix` surface. */
  fix?: string | { oldText: string; newText: string };
  /** Free-form structured detail carried verbatim into the re-emitted
   *  `Violation.details` (e.g. `styles/undefined-class`'s
   *  `incompleteDefinitions` unread-source list, Spec 45 R5). */
  details?: string | Record<string, unknown>;
};

/** A rule definition. `needs` has no optional form and no default. */
export interface RuleDefinition<N extends Needs> {
  readonly id: RuleId;
  /** The analyzer namespace the rule re-emits into (Spec 68 §15 — replaces the
   *  deleted `RuleRegistryEntry.analyzer`). It is a bucket label, not a
   *  selection gate: config cannot change it, and every rule carries one so the
   *  full analyzer set is a pure function of `MIGRATED_RULES`. */
  readonly analyzer: string;
  readonly needs: N;
  readonly severity: import('../types.js').Severity;
  readonly message: string;
  readonly docs: string;
  readonly thresholds: readonly ThresholdKey[];
  readonly thresholdRationale?: string;
  readonly samples: RuleSamples;
  /** A rule's evaluation over its declared facts. May be async: corpus-shaped
   *  rules (dependency-graph, schema-validator, …) build derived structures the
   *  legacy reducers computed over the index; the phase model awaits each. The
   *  returned findings are still plain data — async does not let a rule reach
   *  an AST, adapter, or source string. */
  analyze(ctx: AnalysisContext<N>): readonly Finding[] | Promise<readonly Finding[]>;
}

// ── Processors (Spec 68 §3) ────────────────────────────────────────────────

export type ProcessorId = string;

/** A parsed file handed to a per-file processor — the only place an AST lives. */
export interface ParsedFile {
  readonly file: string;
  readonly format: Format;
  /** The source text, present so a processor may re-derive position/context. */
  readonly source: string;
  /** The parsed tree. Dies with the file — never crosses a phase boundary.
   *  Absent for the text-only `'sql'` and `'markup'` formats (no grammar, no
   *  adapter): their producers (`ddl-declarations.sql`, `style-declarations.markup`)
   *  read `.source`/`.file` only. */
  readonly ast?: AST;
  /** The language adapter that parsed this file — the processor's only handle
   *  on the extraction API (`extractFunctions`, `extractClasses`, …). Absent
   *  for `'sql'` and `'markup'`, alongside `ast`. */
  readonly adapter?: LanguageAdapter;
  /** The project root this file was parsed under. Optional because the vertical
   *  slice tests parse single fixtures without a project; present on the full
   *  pipeline. Only the style producer reads it (to load the project's Tailwind
   *  theme tokens for utility expansion — a corpus-level context, not per-file). */
  readonly projectRoot?: string;
}

/**
 * The adapter-backed subset of {@link ParsedFile}: a file whose format has a
 * grammar, so `ast` and `adapter` are always present. Every AST-reading
 * extractor (`file-symbols`, `function-index`, `schema-usage`, the CSS and
 * source halves of `style-declarations`, `cross-language-entities`,
 * `data-access-calls`) is only ever registered for adapter formats, so they
 * narrow their parameter to this; the text-only `sql` format's one producer
 * (`ddl-declarations`) reads `.source`/`.file` alone and never narrows.
 */
export type AstFile = ParsedFile & { readonly ast: AST; readonly adapter: LanguageAdapter };

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
  'function-bodies': 'typescript' | 'tsx' | 'javascript';
  'imports': 'typescript' | 'tsx' | 'javascript' | 'go';
  'export-form': 'typescript' | 'tsx' | 'javascript';
  'import-form': 'typescript' | 'tsx' | 'javascript';
  'string-literals': 'typescript' | 'tsx' | 'javascript';
  'secret-candidates': 'typescript' | 'tsx' | 'javascript';
  'security-candidates': 'typescript' | 'tsx' | 'javascript';
  'ddl-declarations': 'typescript' | 'tsx' | 'javascript' | 'sql';
  'schema-usage': 'typescript' | 'tsx' | 'javascript';
  'schema-objects': 'typescript' | 'tsx' | 'javascript';
  'style-declarations': 'css' | 'scss' | 'typescript' | 'tsx' | 'javascript' | 'markup';
  'cross-language-entities': 'typescript' | 'tsx' | 'javascript' | 'go';
  'data-access-calls': 'typescript' | 'tsx' | 'javascript' | 'go';
  'loop-queries': 'typescript' | 'tsx' | 'javascript';
  'dynamic-sql': 'typescript' | 'tsx' | 'javascript';
  'react-component': 'typescript' | 'tsx' | 'javascript';
  'file-header': 'typescript' | 'tsx' | 'javascript';
  'code-block': 'typescript' | 'tsx' | 'javascript';
  'json-document': 'json';
  'file-imports': 'typescript' | 'tsx' | 'javascript' | 'go';
  'type-declarations': 'go';
  'go-functions': 'go';
  'go-switches': 'go';
  'error-bindings': 'go';
  'concurrency-primitives': 'go';
  'channel-operations': 'go';
  'batch-functions': 'typescript' | 'tsx' | 'javascript';
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

/**
 * The corpus-level inputs a corpus processor may read beyond its upstream
 * facts. §8's `reachability` processor needs the discovery list, the virtual
 * module list, the tsconfig aliases and the package.json entry points — all
 * derived from the project root, none per-file — so they are threaded here as
 * one optional context rather than leaking config into the fact shapes. A
 * processor that needs none of this (table-catalog, migration-history,
 * mined-conventions, schema-validations) simply ignores it.
 */
export interface CorpusContext {
  /** Absolute project root (alias + entry-point resolution base). */
  projectRoot?: string;
  /** Full corpus discovery list (unfiltered) for alias resolution. */
  corpusFiles?: readonly string[];
  /** Virtual-module specifiers (exact match), default DEFAULT_VIRTUAL_MODULES. */
  virtualModules?: readonly string[];
  /** tsconfig `paths` + `baseUrl` for alias classification + resolution. */
  tsconfigAliases?: { pathPatterns?: readonly string[]; paths?: Readonly<Record<string, readonly string[]>>; baseUrl?: string };
  /** package.json entry points (facade-expanded), absolute. */
  packageEntryPoints?: readonly string[];
  /** The read-only code-index handle the index-backed corpus producers
   *  (`call-graph`, and later `coverage`/`defined-classes`/`clone-pair-history`)
   *  read their facts from. §2.2: `CrossDomainAnalyzer`'s direct `indexHandle`
   *  read becomes a corpus processor reading this — never a rule. Optional so the
   *  slice tests run a single fixture with no index (the producer degrades to an
   *  empty fact, matching the legacy graceful-degradation). */
  indexHandle?: IndexHandle;
  /** Config-declared external tables (schema analyzer's `knownTables` +
   *  `schemas`), merged into the `table-catalog` corpus fact. See
   *  {@link ExternalTableDecl}. */
  externalTables?: ReadonlyArray<ExternalTableDecl>;
}

/** A corpus processor: receives complete upstream facts, no AST, no format. */
export interface CorpusProcessor<K extends CorpusFactKind, N extends readonly FactKind[]> {
  readonly id: ProcessorId;
  readonly produces: K;
  readonly needs: N;
  process(facts: { readonly [J in N[number]]: FactShapes[J] }, ctx?: CorpusContext): FactShapes[K];
}
