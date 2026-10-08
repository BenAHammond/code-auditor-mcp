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
import type { DdlForeignKey } from '../analyzers/universal/schema/migrations.js';
import type { ProvenanceReason } from '../analyzers/provenance.js';
import type { TsExpressionDescriptor, PropagationRule, ClassCall } from '../analyzers/tsExpressionDescriptor.js';
import type { BindingKind, ImportKind, ValueDescriptor } from '../analyzers/receiverRoot.js';
import type { HandleVerdict } from '../analyzers/handleIdentification.js';
import type { Dialect } from '../mcp-tools/discoveryQueries.js';
import type { UnresolvedQuery } from '../analyzers/universal/schema/codeAnalysis.js';

export interface FactShapes {
  /** Reserved: an AST is not a fact and cannot be declared. */
  ast: never;
  'file-symbols': FileSymbols[];
  'function-index': FunctionIndexFact[];
  'query-sites': QuerySiteFact[];
  'query-site-candidates': QuerySiteCandidatesFact[];
  'imports': ImportFact[];
  'import-specifiers': ImportSpecifiersFact[];
  'export-symbols': ExportSymbolFact[];
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
  'schema-usage-candidates': SchemaUsageCandidatesFact[];
  'schema-objects': SchemaObject[];
  'style-declarations': StyleDeclarationsFile[];
  'color-values': ColorValuesFact[];
  'cross-language-entities': Entity[];
  'data-access-calls': ResolvedQuery[];
  'data-access-calls-candidates': DataAccessCallCandidate[];
  'loop-queries': LoopQueryFact[];
  'loop-query-candidates': LoopQueryRawCandidate[];
  'dynamic-sql': DynamicSqlFact[];
  'resolution': ResolutionFact;
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
  'go-package-bindings': GoPackageBindingFact[];
  'within-file-provenance': WithinFileProvenanceFact[];
  'receiver-activity': ReceiverActivityFact[];
  'receiver-provenance': ReceiverProvenanceFact;
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
  /** The number of parameters that are genuine domain inputs — excluding the
   *  threaded context/configuration parameters (optional/defaulted, or typed as
   *  a lookup/index container, resolver, environment, dialect, or config noun).
   *  The `parameter-count` rule measures against this so a context-threading
   *  signature (a shared resolution environment spread into positional
   *  parameters) is not mistaken for a caller-facing god-function that should
   *  bundle its domain inputs into an options object. */
  primaryParameterCount: number;
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
  /** The number of parameters that are genuine domain inputs — excluding the
   *  threaded context/configuration parameters (optional/defaulted, or typed as
   *  a lookup/index container, resolver, environment, dialect, or config noun).
   *  The `parameter-count` rule measures against this so a context-threading
   *  signature (a shared resolution environment spread into positional
   *  parameters) is not mistaken for a caller-facing god-function that should
   *  bundle its domain inputs into an options object. */
  primaryParameterCount: number;
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
  /** The interface names this class `implements`, resolved in-repo by the
   *  resolution fact (Spec 69 R3 — class → what it implements). */
  implements?: string[];
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
  /** The interface names this interface `extends`, resolved in-repo by the
   *  resolution fact (Spec 69 R3 — interface → what it extends). */
  extends?: string[];
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
  /** The imported local names this function's body uses, in first-use order —
   *  the phase-parse equivalent of `functions.used_imports` (Item 4 2b). Computed
   *  by `extractIdentifierUsage(node, source, importNames)` over the same
   *  `importNames` set the functionScanner sync path built, so it reproduces the
   *  identifier-usage analysis that previously only `index.sync` produced. */
  usedImports: string[];
  language: string;
};

/**
 * One DB-query site, the serializable projection of the located query-site scan
 * (`extractQuerySiteOffsets` over the raw source). Each site is attributed to its
 * innermost enclosing function — `functionLine`/`functionColumn` are the
 * enclosing function's 1-based start coordinate, `null` when the site is
 * top-level (outside any function). `method` is the query mechanism label
 * (`run`/`query`/`all`/`exec`/`SELECT`/…). A function's query count is then the
 * number of sites whose enclosing function is that function — a relation that
 * cannot double-count a nested closure by construction (Spec 69 R2).
 */
export type QuerySiteFact = {
  file: string;
  /** Query site's 1-based start line. */
  line: number;
  /** Query site's 1-based start column. */
  column: number;
  /** Query mechanism label (`run`, `query`, `all`, `exec`, `SELECT`, …). */
  method: string;
  /** Enclosing function's 1-based start line, or null when top-level. */
  functionLine: number | null;
  /** Enclosing function's 1-based start column, or null when top-level. */
  functionColumn: number | null;
  /** Enclosing function's declaration name, or null when anonymous/top-level. */
  functionName: string | null;
};

/**
 * One file's un-gated query-site candidates — the raw, provenance-free extract
 * the corpus `query-sites` producer re-gates (Spec 70 Item 4, step 3). The
 * `query-sites` producer splits: the *sites* (attributed to their enclosing
 * function) are extracted here while the AST lives, because `extractQuerySiteOffsets`
 * + `extractFunctions` need the tree; the *gate* (glob || dbProvenanced ||
 * dbActivity || hasSqlTag) is applied corpus-side once the `receiver-provenance`
 * fixed point supplies the cross-file seed. `hasSqlTag` is the one gate input a
 * corpus producer cannot re-derive (it scans source text), so it is projected
 * here; `dbActivity` travels in `receiver-activity` and `dbProvenanced` is
 * re-derived by `classifyBuildProvenance`. Emits one fragment per TS-family file
 * (null-or-value, like `receiver-activity`), so a file with no sites still marks
 * its presence for the corpus producer.
 */
export type QuerySiteCandidatesFact = {
  readonly file: string;
  readonly sites: readonly QuerySiteFact[];
  readonly hasSqlTag: boolean;
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
 * One import statement's full specifier detail — the serializable projection of
 * the adapter's `extractImports` (`ImportInfo[]`) that the cross-file
 * receiver-provenance fixed point (Spec 70 Item 4, 2a) reads. The existing
 * `imports` fact drops `name`/`isDefault`/`isNamespace` and collapses the
 * specifier list to one row per statement (it serves `duplicate-import`, which
 * only groups by `(file, source)`); this fact keeps every specifier so the fixed
 * point can resolve which local binding is a namespace/default/named import of a
 * DB-provenanced re-export. `location` is dropped — the fixed point keys by
 * `source` + specifier, never position.
 */
export type ImportSpecifierDetail = {
  name: string;
  alias?: string;
  isDefault: boolean;
  isNamespace: boolean;
};

export type ImportSpecifiersFact = {
  file: string;
  source: string;
  specifiers: ImportSpecifierDetail[];
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
 * One exported symbol, the serializable projection of `collectExports`
 * (receiverResolution.ts) that the cross-file receiver-provenance fixed point
 * (Spec 70 Item 4, 2a) reads. Unlike `export-form` — which drops re-export
 * `source` and the star re-export (`export * from '…'`), and emits only the
 * first name of a multi-name clause — this fact keeps the *complete* export set
 * the fixed point resolves against: `name` (including `'*'`), the re-export
 * `source` when present, and `isDefault`. It calls the exact `collectExports`
 * the legacy `resolveCorpusReceivers` used, so the export set is byte-identical
 * by construction, not re-implemented.
 */
export type ExportSymbolFact = {
  file: string;
  name: string;
  /** The re-export source (`export … from '…'`); absent for a local export. */
  source?: string;
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
 * One un-gated, un-deduped loop-query candidate — the raw projection of one
 * in-loop DB call, pre-`isDbCallNode`-filter and pre-loop-dedup. The corpus
 * `loop-queries` producer re-folds the strict-handle verdict (`isDbCallNode`'s
 * `identifyHandle`), drops non-handles, dedups by loop byte-offset (one finding
 * per loop), and assigns the stable symbol — the three steps that depend on the
 * cross-file `dbProvenanced` seed, which the raw producer (empty seed) cannot
 * see. The provenance-free discriminators (statement-construction, for-of-iterable,
 * hoisted-reuse, batch-argument, LLM/queue suppression) already ran here while
 * the AST lived.
 */
export type LoopQueryRawCandidate = {
  readonly file: string;
  /** 1-based line/column of the resolved query-call anchor (`getCallExpressionCallee`). */
  readonly line: number;
  readonly column: number;
  /** The enclosing-function identity label the symbol is keyed on. */
  readonly enclosingFunction: string;
  /** The enclosing loop's start byte offset — the dedup key (one finding per loop). */
  readonly loopStartOffset: number;
  /** 1-based line of the enclosing loop's opening token. */
  readonly loopLine: number;
  readonly depth: number;
  // `handleVerdictForCall`'s CallSite identity (the node's own callee — templates
  // are skipped), so the corpus producer can re-fold the strict-handle filter.
  readonly handleCalleeType: 'identifier' | 'member' | null;
  readonly handleName: string | null;
  readonly handleRoot: string | null;
  readonly handleReceiver: string | null;
  readonly handleMethod: string | null;
  readonly handleThisField: boolean;
  /** The enclosing class's base-class heritage text (`WorkflowEntrypoint<Env>`),
   *  or null when not `this`-rooted or the class has no base class (Spec 70 Q3).
   *  Resolved at fold time via the env's `resolveHeritageField`. */
  readonly handleThisHeritage: string | null;
  /** The handle verdict's site-dialect receiver (raw nullable
   *  `getMemberExpressionReceiver` of the callee) — `resolveSiteDialect` reads
   *  the nullable raw, distinct from `handleReceiver` (`receiver ?? root`). */
  readonly handleSiteReceiver: string | null;
  /** The static SQL argument (unquoted), or null — feeds the handle verdict's
   *  sql-argument source. */
  readonly sqlArg: string | null;
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
  /** Per-table columns the file declares as natural UNIQUE (SQL names,
   *  lowercased) — the bootstrap-lookup signal `missing-org-filter` reads: a
   *  query whose predicate carries one of these is a lookup by that natural key.
   *  PRIMARY KEY is excluded — a surrogate PK is the IDOR surface, not a
   *  bootstrap signal. */
  uniqueColumns: Readonly<Record<string, readonly string[]>>;
  /** Per-table PRIMARY KEY columns (SQL names, lowercased) — kept *separate*
   *  from `uniqueColumns` so the resolution fact can distinguish a surrogate PK
   *  (the IDOR surface) from a natural key (the bootstrap signal). */
  primaryKeyColumns: Readonly<Record<string, readonly string[]>>;
  /** Per-table NOT NULL columns (SQL names, lowercased). */
  notNullColumns: Readonly<Record<string, readonly string[]>>;
  /** Per-table foreign-key references (declaring column → referenced table +
   *  column), all lowercased. */
  foreignKeys: Readonly<Record<string, readonly DdlForeignKey[]>>;
};

/**
 * One ORM schema-object declaration: a `const <identifier> = pgTable|mysqlTable|
 * sqliteTable('<table>', …)` binding. The identifier is the JS name the code
 * references (`.from(sampleOwnership)`), and `table` is the SQL name the DDL
 * catalog keys on (`sample_ownership`). The `resolution` corpus reducer
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
  /** The `.unique()` (natural, not `.primaryKey()`) columns, each carried as its
   *  JS field name (`prefix`) and, when different, its SQL column name
   *  (`hashed_token`) — so a query filtering on either name is recognized as a
   *  structurally-scoped (bootstrap) lookup by `missing-org-filter`. A surrogate
   *  primary key is excluded: it is the IDOR surface, not a bootstrap signal. */
  uniqueColumns: readonly string[];
  /** The `.primaryKey()` columns (surrogate key), kept *separate* from
   *  `uniqueColumns` so the resolution fact distinguishes PK from UNIQUE. */
  primaryKeyColumns: readonly string[];
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
  origin?: 'query-builder' | 'collection-adapter';
};

/** A function/method span, the projection of one enclosing-function node the
 *  corpus `schema-usage` producer uses to re-home a reference to its innermost
 *  enclosing function with no AST. `name` is `adapter.getNodeName`'s text (null
 *  for an anonymous arrow). */
export type FunctionSpanFact = {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly name: string | null;
};

/** A string-fragment span, the projection of one `string_fragment` leaf the
 *  corpus `schema-usage` producer uses to re-home a *top-level* reference with no
 *  AST. The legacy re-home (`findClosestNodeAt` + `findEnclosingFunctionIdentity`)
 *  returned the deepest node containing the reference — for a table name inside a
 *  SQL string that node is a `string_fragment`, whose start (the content start,
 *  right after the backtick/quote or a `${…}` substitution) becomes the
 *  top-level coordinate. The end is projected so the corpus producer can test
 *  containment. */
export type StringFragmentFact = {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
};

/** One tagged-template SQL candidate (`sql\`SELECT …\``), extracted un-gated. */
export type TaggedTemplateCandidate = {
  readonly tagName: string;
  readonly templateText: string;
  readonly location: { line: number; column: number };
};

/** One DB-call candidate, split by callee shape so the corpus producer can mirror
 *  `dbCallVerdict`'s identifier / member arms. `sqlArgument` feeds
 *  `identifyHandle`'s sql-argument source; `sqlText` is the resolved SQL
 *  `parseSqlTables` reads — or null when the argument is held in an unresolvable
 *  identifier, in which case `unresolved` carries the identifier + location so the
 *  corpus-side reduction can re-admit the call and emit the `unresolved-query`
 *  coverage diagnostic (Spec 70 1b). `sqlText` and `unresolved` are mutually
 *  exclusive: `resolveQuerySql` returns at most one. */
export type DbCallCandidate =
  | {
      readonly calleeType: 'identifier';
      readonly name: string;
      readonly sqlArgument: string | null;
      readonly sqlText: string | null;
      readonly unresolved: UnresolvedQuery | null;
      readonly location: { line: number; column: number };
    }
  | {
      readonly calleeType: 'member';
      readonly method: string;
      readonly root: string;
      readonly receiver: string | null;
      readonly thisField: boolean;
      readonly sqlArgument: string | null;
      readonly sqlText: string | null;
      readonly unresolved: UnresolvedQuery | null;
      readonly location: { line: number; column: number };
    };

/** One re-admitted DB-call whose SQL argument is held in an unresolvable
 *  identifier (Spec 70 1b) — the corpus-side `unresolved-query` record, re-derived
 *  from the raw `schema-usage-candidates` fact + the `receiver-provenance` fixed
 *  point with no AST. `identifyHandle` already re-admitted the call (a DB handle),
 *  so the query's table read/write status is genuinely unknown, not "no tables".
 *  Feeds the `unresolved-query` coverage diagnostic re-homed in the caller. */
export type UnresolvedQuerySite = {
  readonly file: string;
  readonly identifier: string;
  readonly location: { line: number; column: number };
};

/**
 * One file's un-gated schema-usage candidates — the raw, provenance-free extract
 * the corpus `schema-usage` producer re-gates and re-derives (Spec 70 Item 4,
 * step 3). The split mirrors `query-site-candidates`: the provenance-free half of
 * `findTableReferences` — strategies (4)/(5)/(6) ORM / query-builder /
 * collection-adapter — is extracted *and re-homed* here while the AST lives,
 * while the two provenance-dependent strategies (1) tagged-template and (2)
 * DB-call emit raw candidates the corpus producer re-admits and re-homes once
 * `classifyBuildProvenance` has re-derived `dbProvenanced`. `functions` projects
 * every enclosing-function node so the corpus producer can re-home tagged / DB-call
 * references without walking the tree; `hasSqlTag` is the one gate input a corpus
 * producer cannot re-derive (it scans source text).
 */
export type SchemaUsageCandidatesFact = {
  readonly file: string;
  readonly sourceCode: string;
  readonly hasSqlTag: boolean;
  readonly functions: readonly FunctionSpanFact[];
  readonly stringFragments: readonly StringFragmentFact[];
  readonly tagged: readonly TaggedTemplateCandidate[];
  readonly dbCalls: readonly DbCallCandidate[];
  readonly ormRefs: readonly SchemaUsageFact[];
  readonly queryBuilderRefs: readonly SchemaUsageFact[];
  readonly collectionAdapterRefs: readonly SchemaUsageFact[];
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
  /** Content-level `<style lang="…">` unread reasons, collected by the markup
   *  producer (`extractStylesMarkup`) during its own `extractDeclarations` pass.
   *  The `unread-style-sources` corpus producer flattens these instead of
   *  re-reading the `style_unread_sources` index table (the old path that
   *  re-parsed markup files the corpus already parsed). CSS and TS/JS source
   *  producers have no content-level reason, so they contribute `[]`. */
  unreadSources: ReadonlyArray<UnreadStyleSourceFact>;
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

/**
 * One color declaration's CIELAB conversion, pre-computed by the `color-values`
 * corpus producer from `style-declarations` (Spec 69 R4). The
 * `styles/value-drift` rule reads this fact instead of parsing raw color strings
 * in its own body: `parseColorToRGB` + `rgbToLab` moved to the producer, so the
 * rule's clustering and flagging decisions operate on pre-computed Lab triples.
 */
export type ColorValuesFact = {
  property: string;
  filePath: string;
  line: number;
  rawValue: string;
  /** JSON.stringify(NormalizedValue) encoding, or null — mirrors StyleDeclRow. */
  normalizedValue: string | null;
  /** The sRGB triple ([0..255] per channel), for exact-value dedup. */
  rgb: [number, number, number];
  /** The CIELAB Lab triple (L, a, b), D65 reference white. */
  lab: [number, number, number];
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
 *  *read* stylesheet" rather than a definitive assertion. The walk-level reasons
 *  (unsupported dialect, read failure, unknown extension) are produced by the
 *  traverse phase's own read/dialect walk (`runPhaseModel`); the content-level
 *  `<style lang="…">` reason is collected by the markup `style-declarations`
 *  producer (`extractStylesMarkup`) during its `extractDeclarations` pass and
 *  flattened by the `unread-style-sources` corpus producer — the two are merged
 *  in `buildFacts`. */
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
/** One predicate element of a local array binding resolved into a `.where(...)`
 *  (Spec 69 R3). The element's own source text is carried verbatim so the rule
 *  re-derives the org-predicate signal with *its* vocabulary (the §69 Fix-1
 *  "one vocabulary, two consumers" invariant) rather than trusting a boolean the
 *  producer baked with the default config. */
export type ResolvedPredicateElement = {
  /** The element's source text (`eq(orders.organizationId, …)`, …). */
  text: string;
  /** True when the element is present on every path to the query (an initializer
   *  element, or a `.push(...)` not gated by a conditional/loop/`&&`). */
  allPaths: boolean;
  /** When `allPaths` is false, the enclosing branch condition the element is
   *  gated behind (`if (organizationId)`, a ternary/`&&` guard, …). */
  branch?: string;
};

/** The local-binding resolution of a `.where(and(...conditions))` predicate.
 *  Present only when the `.where(...)` spread resolves to a local `const`/`let`
 *  array binding within the same function body. */
export type ResolvedWhere = {
  elements: ResolvedPredicateElement[];
};

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
  /** Spec 70 R2 — AST-derived SQL facts, parsed from the call's static SQL
   *  argument. Each is absent (false / empty / null) when the corpus named no
   *  dialect or the argument failed to parse: that is `cannot-fire`, not a
   *  negative verdict. The write/upsert facts are the raw-SQL statement kind;
   *  a Kysely builder verb (`updateTable`) is folded into `isWrite`/`isMassWrite`
   *  by the producer (host-language shape, not SQL). */
  isWrite: boolean;
  isMassWrite: boolean;
  isUpsert: boolean;
  isRawInsert: boolean;
  /** The lowercased explicit column list of a raw-SQL INSERT/REPLACE, or `null`
   *  for a positional INSERT (`INSERT INTO t VALUES (…)`, no column list). */
  insertColumns: string[] | null;
  /** Lowercased column refs appearing as predicate operands in the WHERE tree;
   *  `null` when no SQL was parsed (the tenant-predicate signal `cannot-fire`). */
  sqlWhereColumns: string[] | null;
  hasParameterizedQuery: boolean;
  hasSqlInjectionRisk: boolean;
  /** True when the injection risk is manually quote-escaped (downgrades severity). */
  sqlEscaped: boolean;
  /** Enclosing function name for stable fingerprinting. */
  enclosingFunction?: string;
  /** True when the call is inside a loop (loop-query reads this). */
  insideLoop?: boolean;
  /** Spec 69 R3 — the resolved WHERE predicate when the `.where(...)` spreads a
   *  local array binding (`and(...conditions)`). */
  resolvedWhere?: ResolvedWhere;
  /** Spec 70 R1.2 — the handle verdict from `identifyHandle` (`handle` with its
   *  `via`, or `unproven` with its reason). Present only when the call was
   *  admitted through handle identification; absent for shape-only / ORM /
   *  tagged-template / variable-assignment candidates. A `not-handle` site is
   *  rejected at admission and never reaches a resolved query. */
  handleVerdict?: HandleVerdict;
};

/**
 * One un-gated data-access-call candidate — the raw, provenance-free projection
 * of `buildDatabaseCall`'s AST-derived fields plus the two identities the corpus
 * `data-access-calls` producer re-folds over the re-derived `dbProvenanced`. The
 * split mirrors `schema-usage-candidates`: the provenance-free half (text-derived
 * shape, static security arms 1–3, organization filter, enclosing identity,
 * resolved WHERE) is computed here while the AST lives; the provenance-dependent
 * half (the handle verdict → admission + injection-risk gate, and the site
 * dialect → the SQL parse) is re-derived by `classifyDataAccessCalls` once
 * `classifyBuildProvenance` supplies `dbProvenanced`.
 *
 * `handle*` is the identity of `handleVerdictForCall`'s `CallSite` — the
 * *enclosing call* callee for a template-string candidate, the node's own callee
 * otherwise — because the admission verdict and the injection-risk gate fold over
 * it. `site*` is the identity of `resolveSiteDialect`'s input — the node's *own*
 * callee, null for a template string — because the parse dialect follows it. The
 * two diverge for a template argument, which is why both travel.
 */
export type DataAccessCallCandidate = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** 'typescript' covers tsx/javascript; 'go' is the Go family (selector callee). */
  readonly format: 'typescript' | 'go';
  /** The comment-stripped node text (`queryText`). */
  readonly nodeText: string;
  /** `extractMethodName` — the resolved method/property label. */
  readonly method: string;
  /** The static SQL argument (unquoted), or null when absent/interpolated. */
  readonly sqlArg: string | null;
  /** `isOrmPattern(nodeText)` — an ORM-shaped text, not necessarily SQL. */
  readonly isOrmCall: boolean;
  /** `isTaggedTemplateSqlCall` — a tagged-template SQL call (discovery path c). */
  readonly isTaggedSqlCall: boolean;
  /** `isQueryBuilderShape` — a query-builder chain (discovery path b). */
  readonly isQueryBuilderShape: boolean;
  /** `isVariableAssignment && extractStaticSql !== null` (discovery path d). */
  readonly isVariableAssignmentSql: boolean;
  /** `isTemplateLiteral(node)` — the dedup preference (template over declaration). */
  readonly isTemplateLiteral: boolean;
  // `handleVerdictForCall`'s CallSite identity (the enclosing-call callee).
  readonly handleCalleeType: 'identifier' | 'member' | null;
  readonly handleName: string | null;
  readonly handleRoot: string | null;
  readonly handleReceiver: string | null;
  readonly handleMethod: string | null;
  readonly handleThisField: boolean;
  /** The enclosing class's base-class heritage text (`WorkflowEntrypoint<Env>`),
   *  or null when not `this`-rooted or the class has no base class (Spec 70 Q3).
   *  Resolved at fold time via the env's `resolveHeritageField`. */
  readonly handleThisHeritage: string | null;
  /** `extractStaticSql(callNode)` — the handle verdict's SQL argument (the
   *  enclosing-call first arg for a template, the node's own arg otherwise).
   *  Distinct from `sqlArg` (`extractStaticSql(node)`) for a template that is a
   *  *later* argument of its enclosing call. */
  readonly handleSqlArg: string | null;
  /** The handle verdict's site-dialect receiver — the raw nullable
   *  `getMemberExpressionReceiver` of `callNode`'s callee. Distinct from
   *  `handleReceiver` (`receiver ?? root`) because `resolveSiteDialect` reads the
   *  nullable raw (`this.db.prepare` → `db`, not `this.db`). */
  readonly handleSiteReceiver: string | null;
  /** `shouldSkipCallForTemplateArg` — drop a call rediscovered via its template
   *  argument (a multi-line template starts on a later line than its call, so the
   *  line dedup does not collapse them). */
  readonly skipCallForTemplateArg: boolean;
  // `resolveSiteDialect`'s identity (the node's own callee; null for template).
  readonly siteCalleeType: 'identifier' | 'member' | null;
  readonly siteName: string | null;
  readonly siteReceiver: string | null;
  // Provenance-free derived fields.
  readonly hasOrganizationFilter: boolean;
  readonly enclosingFunction: string;
  readonly resolvedWhere: ResolvedWhere | null;
  readonly ormTables: readonly string[];
  readonly builderVerb: 'insert' | 'update' | 'delete' | null;
  readonly ormHasFilter: boolean;
  // Static security (arms 1–3 + static wrappers), corrected for cross-file
  // learned wrappers corpus-side.
  readonly staticParameterized: boolean;
  readonly staticInjectionRisk: boolean;
  readonly staticEscaped: boolean;
  readonly arm4CalleeName: string | null;
};

/** One column's resolved constraints (Spec 69 R3, criterion 8). PK and natural
 *  UNIQUE are recorded as *separate* flags — the quiet set reads `unique` only,
 *  never `primaryKey`, because a surrogate PK is the IDOR surface the rule
 *  exists to catch, not a bootstrap signal. */
export type ResolutionColumn = {
  name: string;
  primaryKey: boolean;
  unique: boolean;
  notNull: boolean;
  /** The foreign-key reference, when this column references an in-repo table. */
  foreignKey: { table: string; column: string } | null;
};

/** One resolved table: its last-CREATE source, and each column with its
 *  separately-recorded constraints. */
export type ResolutionTable = {
  name: string;
  source: string;
  columns: ReadonlyArray<ResolutionColumn>;
};

/** One class declaration, resolved to what it extends/implements in-repo. */
export type ResolutionClass = {
  name: string;
  file: string;
  extends: string | null;
  implements: ReadonlyArray<string>;
};

/** One interface declaration, resolved to what it extends in-repo. */
export type ResolutionInterface = {
  name: string;
  file: string;
  extends: ReadonlyArray<string>;
};

/** The one resolution fact (Spec 69 R3, criterion 7). It answers "what does this
 *  name refer to?" for every declared entity a rule asks about: ORM identifiers
 *  to SQL table names (`aliases`), tables to their columns and per-column
 *  constraints (`tables`), and class/interface declarations to what they extend
 *  and implement (`classes`/`interfaces`). No rule performs its own name
 *  resolution — it reads this fact instead. */
export type ResolutionFact = {
  tables: ReadonlyArray<ResolutionTable>;
  aliases: Readonly<Record<string, string>>;
  classes: ReadonlyArray<ResolutionClass>;
  interfaces: ReadonlyArray<ResolutionInterface>;
};

/**
 * A config-declared table the phase `resolution` producer merges alongside
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
 * One Go file's package-scope declarations, as the `go-package-bindings`
 * producer projects them (Spec 70 Item 4, 2a). The per-file half of
 * `buildGoPackageBindings` (`goResolution.ts`): top-level `function_declaration` /
 * `method_declaration` (name + return type), `type_declaration` → `type_spec`
 * (name), and `var_declaration` → `var_spec` (name + type + value), first-wins
 * deduped by name within the file. The cross-file receiver-provenance fixed
 * point groups these by directory (a Go package is directory-scoped) and merges
 * first-wins to rebuild the package symbol table — the exact
 * `Map<string, GoBinding>` the legacy `resolveCorpusReceivers` fed its Go arm.
 *
 * `bindings` is the serializable projection of `Map<string, GoBinding>` — one
 * `{name, binding}` pair per entry. `GoPackageBindingDetail` and
 * `GoPackageValueDescriptor` are object-literal `type` aliases (not the
 * `GoBinding` / `GoValueDescriptor` `interface`s they project, which do not
 * satisfy §4's `Serializable` index-signature arm); they carry the same fields
 * byte-for-byte so the fixed point rehydrates a `GoBinding` with no translation.
 */
export type GoPackageBindingFact = {
  file: string;
  bindings: readonly GoPackageBinding[];
};

/** One package-scope binding: the declaration name keyed to its `GoBinding`. */
export type GoPackageBinding = {
  name: string;
  binding: GoPackageBindingDetail;
};

/**
 * The serializable projection of `GoBinding` (`goResolution.ts`). `kind` mirrors
 * the full `GoBindingKind` union — package scope only ever produces
 * `function`/`method`/`type`/`variable`, but keeping the wider union makes the
 * projection assignable from any `GoBinding` with no narrowing.
 */
export type GoPackageBindingDetail = {
  kind: GoPackageBindingKind;
  /** Import source path (kind === 'import'). */
  source?: string;
  /** Type-annotation text (variable / parameter / field). */
  typeText?: string;
  /** Return-type text (function / method) — `(*sql.DB, error)`. */
  returnTypeText?: string;
  /** Initializer / value expression (variable / field), serializable. */
  value?: GoPackageValueDescriptor;
};

/** The `GoBindingKind` union, mirrored so the projection needs no import. */
export type GoPackageBindingKind =
  | 'import'
  | 'variable'
  | 'parameter'
  | 'field'
  | 'function'
  | 'method'
  | 'type'
  | 'const';

/**
 * The serializable projection of `GoValueDescriptor` (`goResolution.ts`) — the
 * node type, its text, and the `function`/`operand`/`type` named children the
 * classifier reads, recursively bounded (depth 4) in the producer.
 */
export type GoPackageValueDescriptor = {
  type: string;
  text: string;
  function?: GoPackageValueDescriptor | null;
  operand?: GoPackageValueDescriptor | null;
  typeNode?: GoPackageValueDescriptor | null;
};

/**
 * One file's within-file-provenance projection, as the `within-file-provenance`
 * producer serializes it (Spec 70 Item 4 / Item 3). This is the *extract* half
 * of the TS/Go within-file-provenance split — everything the fixed point reads,
 * projected with no AST and no live node — so the corpus `receiver-provenance`
 * producer can re-derive a file's DB-provenanced names without re-parsing it.
 *
 * Tagged by `format` so the corpus producer rehydrates the projection into the
 * owning format's `classify` input. The descriptor pieces (`TsExpressionDescriptor`,
 * `PropagationRule`, `ClassCall`) are reused *as* the serializable projection:
 * they are already closed object-literal `type`s with no `interface`/`Map`/`Set`
 * member, so they satisfy §4's `Serializable` as-is (the `GoPackageValueDescriptor`
 * parallel exists only because `GoValueDescriptor` is an `interface`). The two
 * non-serializable members of `TsWithinFileProvenanceExtract` — `seeds`
 * (`Map<string, ProvenanceEvidence>`) and `localFunctions` (`Set<string>`) — and
 * the two `interface`s (`OwnCall`, `ProvenanceEvidence`) are projected here as
 * arrays and `type` aliases respectively.
 */
export type WithinFileProvenanceFact =
  | { readonly file: string; readonly format: 'typescript' | 'tsx' | 'javascript'; readonly ts: TsWithinFileProvenanceProjection }
  | { readonly file: string; readonly format: 'go'; readonly go: GoWithinFileProvenanceProjection };

/** The serializable TS-family extract projection. */
export type TsWithinFileProvenanceProjection = {
  readonly seeds: readonly ProvenanceEvidenceFact[];
  readonly bindings: readonly TsBindingFact[];
  readonly localFunctions: readonly string[];
  readonly propagationRules: readonly PropagationRule[];
  readonly wrapperFunctions: readonly { readonly name: string; readonly ownCalls: readonly WithinFileOwnCall[] }[];
  readonly wrapperClasses: readonly { readonly name: string; readonly classCalls: readonly ClassCall[] }[];
  readonly returningFunctions: readonly { readonly name: string; readonly returnExprs: readonly TsExpressionDescriptor[] }[];
  readonly interfaceFields: readonly InterfaceFieldFact[];
};

/**
 * The serializable projection of `extractInterfaceFields` (`receiverRoot.ts`) —
 * one interface/type-alias name → its declared field name → type-text pairs, for
 * the member-chain resolution arm (Spec 70 decision B3). `interface Env { DB:
 * D1Database }` projects as `{ name: 'Env', fields: [{ name: 'DB', typeText:
 * 'D1Database' }] }`.
 */
export type InterfaceFieldFact = {
  readonly name: string;
  readonly fields: readonly { readonly name: string; readonly typeText: string }[];
};

/**
 * The serializable projection of `ProvenanceEvidence` (`provenance.ts`) — an
 * object-literal `type`, not the `interface` it projects, so it satisfies §4.
 * `reason` carries the `ProvenanceReason` union; the rehydrator casts it back
 * (it is a string literal at runtime, so the cast is lossless).
 */
export type ProvenanceEvidenceFact = {
  readonly identifier: string;
  readonly reason: ProvenanceReason;
  readonly source: string;
  readonly chain: readonly string[];
  readonly packageName?: string;
};

/** The serializable projection of `OwnCall` (`tsExpressionDescriptor.ts`). */
export type WithinFileOwnCall = {
  readonly callee: TsExpressionDescriptor | null;
  readonly isD1Rest: boolean;
};

/**
 * The serializable Go extract projection: the full per-file binding env
 * `buildGoBindingEnv` produces (imports + parameters + short-vars + fields +
 * functions + types — *not* the package-scope `go-package-bindings` set), keyed
 * as name→binding pairs. `GoPackageBinding` already projects the full
 * `GoBinding` union (`GoPackageBindingDetail.kind` is the 7-member
 * `GoPackageBindingKind`), so the same projection carries a file-local binding
 * (parameter/short-var/field) with no narrowing.
 */
export type GoWithinFileProvenanceProjection = {
  readonly imports: readonly { readonly name: string; readonly source: string }[];
  readonly bindings: readonly GoPackageBinding[];
};

/**
 * The per-file receiver-resolution inputs the corpus-side `dbProvenanced`
 * re-derivation needs beyond the within-file extract (Spec 70 Item 4, step 3):
 * the TS binding environment (`identifyHandle` reads it for declaration
 * resolution), the R3 sites (`applyR3FromSites` re-folds `identifyHandle` over
 * them once the cross-file seed is known), and the DB-shaped activity set
 * (`passesFileGate`'s `dbActivity` signal — provenance-free, so it must be
 * extracted while the AST lives, not re-derived). Go files carry none of these:
 * their binding/import env is already in the Go arm of `within-file-provenance`
 * and `go-package-bindings`, and both `collectDbActivity` and `extractR3Sites`
 * return empty for Go, so this fact is TS-family-only.
 */
export type ReceiverActivityFact = {
  readonly file: string;
  readonly format: 'typescript' | 'tsx' | 'javascript';
  readonly bindings: readonly TsBindingFact[];
  readonly r3Sites: readonly ReceiverActivityR3Site[];
  readonly dbActivity: readonly string[];
};

/** One TS binding projected serializable: the `Binding` interface's fields as a
 *  closed object-literal `type` (`ValueDescriptor` is already a serializable
 *  `type`). */
export type TsBindingFact = {
  readonly name: string;
  readonly kind: BindingKind;
  readonly source?: string;
  readonly importKind?: ImportKind;
  readonly typeText?: string;
  readonly value?: ValueDescriptor;
};

/** The serializable projection of `R3Site` (`provenance.ts`, an `interface`). */
export type ReceiverActivityR3Site = {
  readonly root: string;
  readonly receiver: string;
  readonly method: string;
  readonly sqlArgument: string;
  readonly thisField: boolean;
  readonly thisHeritage: string | null;
};

/**
 * The cross-file receiver-provenance fixed point (Spec 70 Item 4, 2a), re-derived
 * by the `receiver-provenance` corpus producer from the four additive file facts
 * (`within-file-provenance`, `import-specifiers`, `export-symbols`,
 * `go-package-bindings`) with no AST. This is the phase-side replacement for
 * `resolveCorpusReceivers`' `fileProvenance` + `unresolvedImports` halves — the
 * per-file DB-provenanced identifiers the four receiver consumers read, plus the
 * unresolved DB-looking imports the `cannot-fire` diagnostic names. `fileExports`
 * (the fixed point's internal Phase-2 intermediate) is *not* carried: no consumer
 * reads it, and the parity assertion compares it through the producer's exported
 * core, not the fact.
 */
export type ReceiverProvenanceFact = {
  readonly files: readonly ReceiverProvenanceFileFact[];
  readonly unresolvedImports: readonly UnresolvedImportFact[];
};

/** One file's fixed-point DB-provenanced identifiers (the serializable
 *  `Map<string, ProvenanceEvidence>` = `FileProvenance[file]`). */
export type ReceiverProvenanceFileFact = {
  readonly file: string;
  readonly provenance: readonly ProvenanceEvidenceFact[];
};

/** An import whose specifier could not be resolved to an in-repo file (the
 *  `cannot-fire` accounting signal), the serializable projection of
 *  `UnresolvedImport` (`receiverResolution.ts`). */
export type UnresolvedImportFact = {
  readonly importer: string;
  readonly source: string;
  readonly names: readonly string[];
};

/**
 * The index-backed call-graph fact (§2.2) — the function catalog and the
 * function→function call edges the legacy `graph_cache` carried, read by the
 * corpus `call-graph` producer. Plain-data projection: the corpus `IndexHandle`
 * is read here and its rows collapse to data (`id`, `name`, `filePath`,
 * `lineNumber`, `isExported`), so no live handle survives past the corpus
 * boundary. `functions` is read from the index `functions` table, not projected
 * from the `function-index` fact — the one field that table cannot supply without
 * the sync path's second parse is `usedImports`, which the producer joins from the
 * `function-index` fact by the `(file, name, line)` identity the index
 * `conflictKey` uses (Item 4 2b). `callEdges` are the call-graph edges (`fromId`
 * → `toId`) read from the `graph_cache` index table, not rebuilt from
 * `function-index`'s `functionCalls` name join (that re-derivation would turn on
 * depth-1 expansion during a plain audit, where the sync-only `graph_cache` is
 * empty).
 *
 * `lineNumber` is the `functions` table's `line_number` (the uncovered-risk
 * ranking reads it as the finding anchor). `usedImports` is the `function-index`
 * `usedImports` array carried verbatim from the fact. `isExported` is the boolean
 * projection of the `functions` table's `is_exported` flag.
 */
export type CallGraphFact = {
  functions: ReadonlyArray<{
    id: number;
    name: string;
    filePath: string;
    lineNumber: number | null;
    usedImports: readonly string[];
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
  /** Spec 70 R1 — the corpus's named SQL dialect, threaded to the
   *  `data-access-calls` producer so its SQL-content facts parse rather than
   *  regex. Absent in the slice tests (single fixture, no corpus) — the producer
   *  then runs on the default (null) dialect and SQL facts `cannot-fire`. */
  readonly sqlDialect?: Dialect | null;
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
 * (`resolution`): it has no supplying format, only upstream facts (§5).
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
  'query-site-candidates': 'typescript' | 'tsx' | 'javascript';
  'imports': 'typescript' | 'tsx' | 'javascript' | 'go';
  'import-specifiers': 'typescript' | 'tsx' | 'javascript';
  'export-symbols': 'typescript' | 'tsx' | 'javascript';
  'export-form': 'typescript' | 'tsx' | 'javascript';
  'import-form': 'typescript' | 'tsx' | 'javascript';
  'string-literals': 'typescript' | 'tsx' | 'javascript';
  'secret-candidates': 'typescript' | 'tsx' | 'javascript';
  'security-candidates': 'typescript' | 'tsx' | 'javascript';
  'ddl-declarations': 'typescript' | 'tsx' | 'javascript' | 'sql';
  'schema-usage-candidates': 'typescript' | 'tsx' | 'javascript';
  'schema-objects': 'typescript' | 'tsx' | 'javascript';
  'style-declarations': 'css' | 'scss' | 'typescript' | 'tsx' | 'javascript' | 'markup';
  'cross-language-entities': 'typescript' | 'tsx' | 'javascript' | 'go';
  'data-access-calls-candidates': 'typescript' | 'tsx' | 'javascript' | 'go';
  'loop-query-candidates': 'typescript' | 'tsx' | 'javascript';
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
  'go-package-bindings': 'go';
  'within-file-provenance': 'typescript' | 'tsx' | 'javascript' | 'go';
  'receiver-activity': 'typescript' | 'tsx' | 'javascript';
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
  /** Spec 69 R1 — the completeness oracle. `counted` carries a cheap, independent
   *  per-file count of the fragments this file *should* yield; `none` states
   *  there is no statable oracle and why (enumerated in the run, never silently
   *  unprovable). Required — a processor without one fails compilation, the
   *  producer-side forcing function mirroring a rule's `needs`. */
  readonly oracle: CompletenessOracle;
}

/**
 * The completeness oracle a {@link FileProcessor} declares (Spec 69 R1). A
 * `counted` oracle is a cheap, dumb count of what the processor should have
 * produced, computed from the same input and written for that processor — an
 * independent upper bound whose emitted shortfall the run records per file.
 *
 * `count` is the expected count off the raw input; `measured` reads the actual
 * count back from the fragments the processor *did* emit. The two must measure
 * the same unit. For a per-fragment producer they are both a count of the
 * fragments themselves; for an aggregate producer (one fragment per file whose
 * payload carries the units — e.g. a style-declarations file holding its
 * declaration list) `count` is still a count of the units, so `measured` reads
 * the units *inside* the fragment, not `fragments.length` (which would be a
 * meaningless 1-against-1).
 *
 * A `none` oracle states that no such count exists, with the reason; it is an
 * explicit report, not an exemption — the failure mode being closed is the
 * silently-unprovable fact.
 */
export type CompletenessOracle =
  | {
      status: 'counted';
      count(file: ParsedFile): number;
      measured(fragments: readonly unknown[]): number;
    }
  | { status: 'none'; reason: string };

/**
 * Spec 69 R1 — one recorded per-file completeness shortfall: the file, the
 * processor (by its `${kind}.${format}` id), and the oracle's expected count vs
 * the fragments actually emitted. Only ever recorded for a `counted` oracle
 * whose emitted count came in below the expected count — the oracle is an upper
 * bound, so equality and over-emission are not shortfalls (they are the
 * non-signal). A `none` oracle never produces one; its absence is enumerated
 * separately, not measured.
 */
export interface OracleShortfall {
  readonly file: string;
  readonly processor: ProcessorId;
  readonly expected: number;
  readonly actual: number;
}

/**
 * The corpus-level inputs a corpus processor may read beyond its upstream
 * facts. §8's `reachability` processor needs the discovery list, the virtual
 * module list, the tsconfig aliases and the package.json entry points — all
 * derived from the project root, none per-file — so they are threaded here as
 * one optional context rather than leaking config into the fact shapes. A
 * processor that needs none of this (resolution, migration-history,
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
   *  `schemas`), merged into the `resolution` corpus fact. See
   *  {@link ExternalTableDecl}. */
  externalTables?: ReadonlyArray<ExternalTableDecl>;
  /** Spec 70 R1 — the corpus's named SQL dialect, threaded to the corpus
   *  producers that re-apply provenance to the four receiver consumers (whose
   *  file-fact half reads `ParsedFile.sqlDialect`). Absent in the slice tests
   *  (single fixture, no corpus) — the producers then run on the default (null)
   *  dialect and SQL-argument facts `cannot-fire`. */
  sqlDialect?: Dialect | null;
  /** Spec 70 criterion 9 (Item 3) — the project's declared type packages
   *  (package.json `dependencies`/`devDependencies` ∪ tsconfig `compilerOptions.types`),
   *  the ambient-arm gate for an unbound handle-type name. Absent (undefined) the
   *  gate abstains: an unbound `D1Database` without a declared dependency stays
   *  `unproven` rather than being credited `handle`. */
  declaredTypePackages?: ReadonlySet<string>;
  /** Spec 70 — a shared memoization cache for the `identifyHandle` verdicts the
   *  receiver consumers re-fold, keyed by the candidate's full handle identity
   *  including the file (whose per-file provenance/env the verdict depends on).
   *  `classifyDataAccessCalls` and `classifyUnprovenQueryReceivers` fold the same
   *  `data-access-calls-candidates` through `identifyHandle`, and
   *  `classifySchemaUsage` and `classifyUnresolvedQuerySites` fold the same
   *  `schema-usage-candidates` dbCalls — without the cache each candidate is
   *  folded twice, and `identifyHandle` is ~2 ms per fold. Threaded here so the
   *  four consumers plus the two post-loop classifiers share one cache across a
   *  single `buildFacts` pass (the verdict is a pure function of (file, identity)
   *  within one pass, so the cache is byte-identical to re-folding). */
  handleVerdictCache?: Map<string, HandleVerdict | null>;
}

/** A corpus processor: receives complete upstream facts, no AST, no format. */
export interface CorpusProcessor<K extends CorpusFactKind, N extends readonly FactKind[]> {
  readonly id: ProcessorId;
  readonly produces: K;
  readonly needs: N;
  process(facts: { readonly [J in N[number]]: FactShapes[J] }, ctx?: CorpusContext): FactShapes[K];
}
