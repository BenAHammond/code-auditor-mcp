/**
 * Pipeline adapter factories (Spec 24).
 *
 * Each factory converts an existing analyzer into a Stage2Visitor,
 * Stage3Reducer, or Stage4Reducer for the pipeline. Lazy-loads analyzer
 * classes via dynamic import() to avoid circular dependency issues.
 *
 * Key patterns:
 *   - Per-file (solid, data-access, doc, schema): wrap analyzeAST()
 *   - React: wraps scanFile() per file, accumulates scan results →
 *     factory returns { visitor, finalizeCrossComponent }
 *   - DB-based (styles, conventions, cross-domain): reducers call
 *     analyzer.analyze([]) with rawDb injected through config
 *   - Invariants: Stage 3 reducer — receives full file list, runs rule engine
 */

import { createHash } from 'crypto';
import path from 'path';
import { MIGRATED_RULES } from './phase/rules/registry.js';
import type {
  IndexHandle,
  IndexFactsEntry,
  Stage2Visitor,
  Stage3Reducer,
  Stage4Reducer,
  Violation,
  VisitorContext,
  ReducerContext,
  CoverageDiagnostic,
} from './types.js';
import type { AST, ASTNode, LanguageAdapter } from './languages/types.js';
import type { MigrationOp } from './analyzers/universal/UniversalSchemaAnalyzer.js';
import { TYPESCRIPT_EXTENSIONS, JAVASCRIPT_EXTENSIONS, getLanguageFromPath } from './utils/fileDiscovery.js';
import { computeContentHash } from './utils/contentHash.js';
import {
  walkAST,
  isExported,
  hasModifier,
  getNodeName,
  getNodeText,
  getFieldNode,
  getLineAndColumn,
  calculateComplexity,
  getFunctionBody,
} from './languages/adapterBridge.js';
import {
  buildImportMap,
  extractFunctionCalls,
} from './utils/dependencyExtractor.js';
import { classifyImportSpecifier, DEFAULT_VIRTUAL_MODULES } from './graph/importClassification.js';
import {
  isReactComponent,
  detectComponentType,
  getComponentName,
} from './utils/reactDetection.js';
import {
  findTableReferences,
  checkNamingConventions,
  checkQueryPatterns,
  checkSQLInjection,
  getNearestTableSuggestions,
} from './analyzers/universal/schema/codeAnalysis.js';
import {
  passesFileGate,
  extractTablesFromRegistry,
} from './analyzers/universal/schema/discovery.js';
import { buildBindingEnv, type RootResolutionEnv } from './analyzers/receiverRoot.js';
import { applyMigrationOps, stripIdentifier } from './analyzers/universal/schema/migrations.js';
import type { CrossLanguageEntity } from './types/crossLanguage.js';
import type { Dialect } from './mcp-tools/discoveryQueries.js';
import { harvestDefinedClasses } from './styles/definedClasses.js';

// ── Rule ID helpers ──────────────────────────────────────────────────────────

function getRuleIdsFor(name: string): string[] {
  return MIGRATED_RULES.filter((r) => r.analyzer === name).map((r) => r.id);
}

/** Join a list of names as prose: "a", "a and b", "a, b and c". */
function joinEnglish(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ── Lazy import singleton ────────────────────────────────────────────────────

function lazySingleton<T>(loader: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    if (!promise) promise = loader();
    return promise;
  };
}

// ── Function-Index visitor (infrastructure) ──────────────────────────────────
// Always-on Stage 2 visitor that populates the `functions` table with
// per-file definitions so the conventions and cross-domain reducers have data
// to mine — even on a cold run with no prior `index sync`.
// The function_calls table is rebuilt post-pipeline after functions rows have
// their auto-increment IDs assigned.

/**
 * A single function/method/component row destined for the `functions` index
 * table. Built by `createFunctionIndexVisitor` from an ASTNode; the inline
 * anonymous record this replaced is now a named type so it can be referenced
 * without re-declaring the 9-field shape.
 */
export interface FunctionIndexEntry {
  name: string;
  line: number;
  endLine: number;
  entityType: string;
  componentType: string | null;
  isExported: boolean;
  complexity: number;
  body: string | undefined;
  functionCalls: string[];
}

/**
 * Collect function/method/component entries from an AST in three passes:
 * (1) named function declarations and methods, (2) arrow functions assigned
 * to variables, (3) React component detection. Returns the deduplicated list
 * of `FunctionIndexEntry` rows destined for the `functions` index table.
 */
function collectFunctionEntries(
  root: ASTNode,
  sourceCode: string,
  importMap: Map<string, any>,
  filePath: string
): FunctionIndexEntry[] {
  const fnEntries: FunctionIndexEntry[] = [];

  // Pass 1 — named function declarations and methods
  walkAST(root, (node) => {
    if (node.type === 'function_declaration') {
      const nameNode = node.children?.find((c) => c.type === 'identifier');
      if (!nameNode) return;
      const name = getNodeText(nameNode, sourceCode);
      if (!name) return;

      const { line } = getLineAndColumn(node);
      const endLine = node.location.end.line;
      const body = getFunctionBody(node, sourceCode);
      const calls = extractFunctionCalls(node, sourceCode, importMap);
      const callNames = [...new Set(calls.map((c) => c.callee))];

      fnEntries.push({
        name,
        line,
        endLine,
        entityType: 'function',
        componentType: null,
        isExported: isExported(node),
        complexity: calculateComplexity(node),
        body,
        functionCalls: callNames,
      });
    }

    // Class methods
    if (node.type === 'method_definition') {
      const nameNode = node.children?.find((c) => c.type === 'identifier');
      if (!nameNode) return;
      const methodName = getNodeText(nameNode, sourceCode);
      if (!methodName) return;

      // Walk up to find class name
      let parent = (node as any).parent;
      let className = 'AnonymousClass';
      while (parent) {
        if (parent.type === 'class_declaration') {
          const cn = parent.children?.find((c: any) => c.type === 'identifier');
          if (cn) className = getNodeText(cn, sourceCode);
          break;
        }
        parent = parent.parent;
      }

      const { line } = getLineAndColumn(node);
      const endLine = node.location.end.line;
      const body = getFunctionBody(node, sourceCode);
      const calls = extractFunctionCalls(node, sourceCode, importMap);
      const callNames = [...new Set(calls.map((c) => c.callee))];

      fnEntries.push({
        name: `${className}.${methodName}`,
        line,
        endLine,
        entityType: 'method',
        componentType: null,
        isExported: isExported(node),
        complexity: calculateComplexity(node),
        body,
        functionCalls: callNames,
      });
    }
  });

  // Pass 2 — arrow functions assigned to variables
  walkAST(root, (node) => {
    if (node.type !== 'variable_declarator') return;
    const nameNode = node.children?.find((c) => c.type === 'identifier');
    const arrowFunc = node.children?.find((c) => c.type === 'arrow_function');
    if (!nameNode || !arrowFunc) return;
    const name = getNodeText(nameNode, sourceCode);
    if (!name) return;

    // Don't duplicate if already covered as function_declaration
    // (shouldn't happen — function_declaration is a different node type)
    const { line } = getLineAndColumn(arrowFunc);
    const endLine = arrowFunc.location.end.line;
    const body = getFunctionBody(arrowFunc, sourceCode);
    const calls = extractFunctionCalls(arrowFunc, sourceCode, importMap);
    const callNames = [...new Set(calls.map((c) => c.callee))];

    fnEntries.push({
      name,
      line,
      endLine,
      entityType: 'function',
      componentType: null,
      isExported: isExported(node),
      complexity: calculateComplexity(arrowFunc),
      body,
      functionCalls: callNames,
    });
  });

  // Pass 3 — React component detection
  // Detect JSX-returning functions to set entity_type='component' and
  // component_type, matching what functionScanner's deepSync produces.
  // The convention miner's classifyExportKind() uses these columns to
  // partition naming conventions.
  const hasReactImport = [...importMap.values()].some(
    (v) => v.modulePath === 'react',
  );
  if (
    filePath.endsWith('.tsx') ||
    filePath.endsWith('.jsx') ||
    (filePath.endsWith('.js') && hasReactImport)
  ) {
    walkAST(root, (node) => {
      if (!isReactComponent(node, sourceCode)) return;
      const ct = detectComponentType(node, sourceCode);
      if (!ct) return;
      const cName = getComponentName(node, sourceCode);
      if (!cName || cName === 'AnonymousComponent') return;

      const existing = fnEntries.find((f) => f.name === cName);
      if (existing) {
        // Upgrade existing function_declaration or arrow-function entry
        existing.entityType = 'component';
        existing.componentType = ct;
      } else {
        // New entry — class component, function_expression, or memo/forwardRef
        // wrapper not already captured by passes 1 or 2.
        const { line } = getLineAndColumn(node);
        const endLine = node.location.end.line;
        const body = getFunctionBody(node, sourceCode);

        fnEntries.push({
          name: cName,
          line,
          endLine,
          entityType: 'component',
          componentType: ct,
          isExported: isExported(node),
          complexity: calculateComplexity(node),
          body,
          functionCalls: [],
        });
      }
    });
  }

  return fnEntries;
}

/**
 * Extract static/dynamic imports and exports for a single file, emitting
 * classified `import_specifiers` rows (Spec 60.1) into `indexFacts`. Returns
 * the import/export facts for the file's stage-2 fact map.
 */
function collectImportExportFacts(opts: {
  ast: AST;
  adapter: LanguageAdapter;
  sourceCode: string;
  filePath: string;
  context: VisitorContext;
  isTsJs: boolean;
  indexFacts: IndexFactsEntry[];
}): {
  imports: Array<{
    moduleSpecifier: string;
    isStatic: boolean;
    isDynamic: boolean;
    isRequire: boolean;
    line: number;
  }>;
  exports: any[];
} {
  const { ast, adapter, sourceCode, filePath, context, isTsJs, indexFacts } = opts;
  const langAdapter = adapter;
  const langAst = ast;

  // Static imports via the adapter's canonical extractImports()
  const staticImportInfos = langAdapter.extractImports(langAst);
  const staticImports: Array<{
    moduleSpecifier: string;
    isStatic: boolean;
    isDynamic: boolean;
    isRequire: boolean;
    line: number;
  }> = staticImportInfos.map((imp) => ({
    moduleSpecifier: imp.source,
    isStatic: true,
    isDynamic: false,
    isRequire: false,
    line: imp.location.start.line,
  }));

  // Spec 60.1 — classify each static import specifier and emit one row per
  // occurrence to `import_specifiers`. The corpus file set is the stage-1
  // discovery list, threaded here as `_infra.files` (merged into
  // `context.config` by pipeline.ts). Existence is checked against that
  // in-memory set, never `fs.existsSync`. Virtual-module list + tsconfig
  // `paths` patterns are threaded via `_infra` and passed to the classifier.
  if (isTsJs) {
    // Spec 60.1 Correction 1 — corpus set is the unfiltered discovery list
    // (`_infra.corpusFiles`), not the narrowed `_infra.files`. The latter is
    // the audit's analysis list (already pruned by includePaths/excludePaths),
    // which drops `.json`/other non-analyzed extensions and would mis-classify
    // a real `./invariant-rules.schema.json` as `internal-broken`.
    const corpusFiles = new Set(
      ((context.config as { corpusFiles?: string[] }).corpusFiles) ??
        ((context.config as { files?: string[] }).files) ??
        [],
    );
    const virtualModules = (context.config as { importVirtualModules?: string[] }).importVirtualModules
      ?? DEFAULT_VIRTUAL_MODULES;
    const tsconfigAliases = (context.config as {
      tsconfigAliases?: {
        pathPatterns?: string[];
        paths?: Record<string, string[]>;
        baseUrl?: string;
      };
    }).tsconfigAliases;
    for (const imp of staticImportInfos) {
      const { classification, resolvedPath } = classifyImportSpecifier(
        imp.source,
        filePath,
        corpusFiles,
        {
          virtualModules,
          aliasPatterns: tsconfigAliases?.pathPatterns ?? [],
          pathMappings: tsconfigAliases?.paths ?? {},
          baseUrl: tsconfigAliases?.baseUrl,
          projectRoot: context.projectRoot,
        },
      );
      indexFacts.push({
        table: 'import_specifiers',
        data: {
          file_path: filePath,
          specifier: imp.source,
          classification,
          resolved_path: resolvedPath ?? null,
          line: imp.location.start.line,
        },
        conflictKey: 'file_path, specifier, line',
      });
    }
  }

  // Dynamic import() and require() — first attempt with pure NodePattern
  // Plan note: import keyword is an anonymous tree-sitter node, so
  // hasChild cannot see it.  We use `custom` with raw node access.
  const dynamicCallNodes = langAdapter.findNodes(langAst, {
    type: 'call_expression',
    custom: (node) => {
      const fn = node.children?.[0];
      return (fn?.type === 'import') ||
             (fn?.type === 'identifier' && getNodeText(fn, sourceCode) === 'require');
    },
  });

  const dynamicImports: Array<{
    moduleSpecifier: string;
    isStatic: boolean;
    isDynamic: boolean;
    isRequire: boolean;
    line: number;
  }> = [];

  for (const node of dynamicCallNodes) {
    const fn = node.children?.[0];
    const isImport = fn?.type === 'import';
    const isRequire = !isImport && (fn?.type === 'identifier' && getNodeText(fn, sourceCode) === 'require');

    // Walk the AST children to find the string argument
    const argsNode = node.children?.find((c) => c.type === 'arguments');
    const stringNode = argsNode?.children?.find((c) => c.type === 'string');
    if (stringNode) {
      const text = getNodeText(stringNode, sourceCode);
      if (text.length >= 2) {
        dynamicImports.push({
          moduleSpecifier: text.slice(1, -1), // strip quotes
          isStatic: false,
          isDynamic: isImport,
          isRequire,
          line: node.location.start.line,
        });
      }
    }
  }

  // Exports via the adapter's canonical extractExports()
  // Returns ExportInfo[] with isDefault — used by both invariants and conventions (B2)
  const exportInfos = langAdapter.extractExports(langAst);

  return {
    imports: [...staticImports, ...dynamicImports],
    exports: exportInfos,
  };
}

/**
 * Create the function-index stage-2 visitor, which populates the `functions`
 * and `import_specifiers` index tables for the downstream reducers.
 *
 * @returns The function-index stage-2 visitor.
 */
export function createFunctionIndexVisitor(): Stage2Visitor {
  return {
    name: 'function-index',
    stage: 'visitor',
    getRuleIds: () => [],
    async visit(ast: unknown, _adapter: unknown, context: VisitorContext, sourceCode: string) {
      const root = (ast as AST).root;
      const filePath = context.filePath;
      if (!filePath) return { violations: [], facts: {} };

      const indexFacts: IndexFactsEntry[] = [];

      // Only index TS/JS files. The registry now maps `.json`/`.css` to their
      // adapter language ids rather than `unknown`, so gate on the two languages
      // this visitor indexes instead of on `unknown` (which would newly admit
      // JSON/CSS ASTs to `buildImportMap`/`collectFunctionEntries`).
      const lang = getLanguageFromPath(filePath);
      if (lang !== 'typescript' && lang !== 'javascript') return { violations: [], facts: {} };

      // Clear existing entries for this file
      indexFacts.push({
        table: 'functions',
        data: { _action: 'clear-by-file', file_path: filePath },
      });

      // Spec 60 — import classification is TS/JS-only: the normalization probe
      // list has no `.go` extension, so applying it to Go relative imports would
      // manufacture false `internal-broken` rows. Clear + re-emit only for TS/JS.
      const isTsJs = lang === 'typescript' || lang === 'javascript';
      if (isTsJs) {
        indexFacts.push({
          table: 'import_specifiers',
          data: { _action: 'clear-by-file', file_path: filePath },
        });
      }

      // Build import map once per file for resolving call targets
      const importMap = buildImportMap(root, sourceCode);

      const fnEntries = collectFunctionEntries(root, sourceCode, importMap, filePath);

      // File-level content hash, shared by every function row this file emits.
      // detectChangedFunctions stores the same value (from its own read of the
      // file) so a later `changed` run can skip the re-scan when the file's
      // whole content is unchanged.
      const fileHash = computeContentHash(sourceCode);

      // Build IndexFactsEntry for each function
      for (const fn of fnEntries) {
        const metadata: Record<string, unknown> = {
          entityType: fn.entityType,
          isExported: fn.isExported,
          complexity: fn.complexity,
          functionCalls: fn.functionCalls,
        };

        const contentHash = computeContentHash(fn.body);
        const now = new Date().toISOString();

        indexFacts.push({
          table: 'functions',
          data: {
            name: fn.name,
            file_path: filePath,
            line_number: fn.line,
            start_line: fn.line,
            end_line: fn.endLine,
            language: lang,
            entity_type: fn.entityType,
            component_type: fn.componentType,
            return_type: null,
            complexity: fn.complexity,
            is_exported: fn.isExported ? 1 : 0,
            has_jsdoc: 0,
            jsdoc_description: '',
            parameters: null,
            body: fn.body ?? null,
            content_hash: contentHash,
            file_hash: fileHash,
            last_modified: now,
            metadata_json: JSON.stringify(metadata),
          },
          conflictKey: 'name, file_path, line_number',
        });
      }

      const { imports: importFacts, exports: exportInfos } = collectImportExportFacts({
        ast: ast as AST,
        adapter: _adapter as LanguageAdapter,
        sourceCode,
        filePath,
        context,
        isTsJs,
        indexFacts,
      });

      return {
        violations: [],
        facts: {
          [filePath]: {
            imports: importFacts,
            exports: exportInfos,
          },
        },
        indexFacts,
      };
    },
    defaultConfig: {},
    description: 'Indexes function definitions and extracts imports/exports for downstream analyzers',
    category: 'infrastructure',
  };
}

// ── Styles reducer (stage 3) ─────────────────────────────────────────────────

// ── Styles CSS visitor (Spec 26 Phase 2) ───────────────────────────────────────

/**
 * Styles CSS visitor — extracts declarations, tokens, and class usage from
 * tree-sitter-css and tree-sitter-scss parsed ASTs. Replaces the regex-based
 * CSS/SCSS extraction in styleExtractor.ts for .css and .scss files.
 *
 * @returns The styles-css stage-2 visitor.
 */
export function createStylesCssVisitor(): Stage2Visitor {
  return {
    name: 'styles-css',
    stage: 'visitor',
    extensions: ['.css', '.scss'],
    getRuleIds: () => [],
    async visit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string) {
      // Lazy-load to avoid circular dependency issues at module load time
      const { extractDeclarationsFromCSSAst, extractTokensFromCSSAst, extractClassUsageFromCSSAst } =
        await import('./styles/cssAstExtractor.js');
      const cssAst = ast as AST;
      const cssAdapter = adapter as LanguageAdapter;
      const filePath = context.filePath;

      return {
        violations: [],
        facts: {
          [filePath]: {
            declarations: extractDeclarationsFromCSSAst(cssAst, cssAdapter, filePath, sourceCode),
            tokens: extractTokensFromCSSAst(cssAst, cssAdapter, filePath, sourceCode),
            classUsage: extractClassUsageFromCSSAst(cssAst, cssAdapter, filePath, sourceCode),
          },
        },
      };
    },
    defaultConfig: {},
    description: 'Extracts CSS declarations from tree-sitter ASTs (.css and .scss)',
    category: 'style',
  };
}

/**
 * Styles source visitor — extracts CSS-in-JS declarations and class usage from
 * the TS/JS ASTs stage 1 already parsed. This replaces the re-parse the style
 * indexer used to do (adapter.parse on every TS/JS file): stage 1 parses every
 * TS/JS file for the other visitors regardless, so a second parse here only
 * duplicated the ~55ms that remained in the scoped short-circuit gate.
 *
 * Extraction is unconditional — the visitor runs on every in-scope TS/JS file,
 * emitting a fact (with a content hash) even when it yields no declarations.
 * The reducer uses that fact to (a) drop stale rows for files that *lost* their
 * styles and (b) skip re-writing files whose stored rows are already current.
 *
 * @returns The styles-source stage-2 visitor.
 */
export function createStylesSourceVisitor(): Stage2Visitor {
  // Spec 61 R3.4 — a project tailwind config that exists but cannot be read
  // statically is a `cannot-fire` coverage diagnostic. Emit it exactly once per
  // visitor instance (the config is project-global, not per-file) so a config
  // gap reads once, not once per source file.
  let emittedTailwindDiagnostic = false;
  return {
    name: 'styles-source',
    stage: 'visitor',
    extensions: [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS],
    getRuleIds: () => [],
    async visit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string) {
      // Lazy-load to avoid circular dependency issues at module load time.
      const { extractDeclarations } = await import('./styles/styleExtractor.js');
      const { extractClassUsage } = await import('./styles/styleIndexer.js');
      const { harvestCssInJsStyleClasses } = await import('./styles/cssInJsHarvest.js');
      const { loadTailwindConfig } = await import('./styles/tailwindConfigLoader.js');
      const tsAst = ast as AST;
      const tsAdapter = adapter as LanguageAdapter;
      const filePath = context.filePath;

      // Memoized per projectRoot (the style-index sync already called it this
      // run), so this is a cache hit — never a re-walk of the project tree.
      const tailwindConfig = loadTailwindConfig(context.projectRoot);
      const tailwindTokens = tailwindConfig.tokens;

      const declarations = extractDeclarations(filePath, tsAdapter, sourceCode, tsAst, tailwindTokens);
      const classUsage = extractClassUsage(filePath, sourceCode);
      // Defined classes come from the CSS parser over each CSS-in-JS template
      // body — the same parser path markup `<style>` blocks use, so keyframes are
      // excluded structurally rather than scanned out of the selector `context`.
      const definedClasses = harvestCssInJsStyleClasses(filePath, sourceCode, tsAst);
      const contentHash = createHash('sha256').update(sourceCode).digest('hex');

      const diagnostic = tailwindConfig.diagnostic && !emittedTailwindDiagnostic
        ? tailwindConfig.diagnostic
        : undefined;
      if (diagnostic) emittedTailwindDiagnostic = true;

      return {
        violations: [],
        facts: {
          [filePath]: { declarations, classUsage, definedClasses, contentHash },
        },
        ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
      };
    },
    defaultConfig: {},
    description: 'Extracts CSS-in-JS declarations and class usage from TS/JS ASTs',
    category: 'style',
  };
}

// Style-table SQL, hoisted so the two inserters (source CSS-in-JS facts and
// compiled-CSS facts) and each one's prepare-once fast path + `indexHandle.run`
// fallback cannot drift on a statement string.
const SQL_STYLE_GET_HASH = 'SELECT content_hash FROM style_declarations WHERE file_path = ? LIMIT 1';
const SQL_STYLE_DEL_DECL = 'DELETE FROM style_declarations WHERE file_path = ?';
const SQL_STYLE_DEL_USAGE = 'DELETE FROM style_class_usage WHERE file_path = ?';
const SQL_STYLE_DEL_TOKEN = 'DELETE FROM style_tokens WHERE file_path = ?';
const SQL_STYLE_DEL_CLASS = 'DELETE FROM style_defined_classes WHERE file_path = ?';
const SQL_STYLE_INS_DECL = 'INSERT INTO style_declarations (property, raw_value, normalized_value, mechanism, file_path, line, context, variant_context, token_ref, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const SQL_STYLE_INS_CLASS = 'INSERT OR IGNORE INTO style_defined_classes (class_name, file_path) VALUES (?, ?)';
const SQL_STYLE_INS_USAGE = 'INSERT INTO style_class_usage (class_name, file_path, line, mechanism, unresolvable) VALUES (?, ?, ?, ?, ?)';
const SQL_STYLE_INS_TOKEN = 'INSERT INTO style_tokens (name, value, file_path, mechanism) VALUES (?, ?, ?, ?)';

/** A prepared write statement (the shape `rawDb.prepare(sql)` returns). */
type StyleWriteStmt = { run(...params: unknown[]): unknown };

/** Run a style write through its prepared statement. The index handle always
 *  exposes a raw better-sqlite3 DB (`pipelineIndexHandle` in auditRunner is the
 *  only construction and always sets `rawDb`), so the prepared statements are
 *  always available — the former `else indexHandle.run(sql, params)` per-call
 *  fallback was unreachable and has been removed. */
function runStyleWrite(
  stmts: Record<string, StyleWriteStmt>,
  stmtKey: string,
  params: unknown[],
): void {
  stmts[stmtKey]!.run(...params);
}

/** Read a file's stored style content hash through its prepared statement. */
function getStyleHash(
  stmts: Record<string, StyleWriteStmt & { get(...params: unknown[]): unknown }>,
  filePath: string,
): { content_hash: string } | undefined {
  return stmts.getHash!.get(filePath) as { content_hash: string } | undefined;
}

/** Prepare the statements shared by both style inserters (source CSS-in-JS and
 *  compiled CSS). Each site layers its own extras (`getHash` for the source path,
 *  `insTok` for the compiled-CSS path) on top of this common set. */
function prepareCommonStyleStatements(
  rawDb: { prepare(sql: string): StyleWriteStmt },
): Record<string, StyleWriteStmt> {
  return {
    delDecl: rawDb.prepare(SQL_STYLE_DEL_DECL),
    delUsage: rawDb.prepare(SQL_STYLE_DEL_USAGE),
    delTok: rawDb.prepare(SQL_STYLE_DEL_TOKEN),
    delClass: rawDb.prepare(SQL_STYLE_DEL_CLASS),
    insDecl: rawDb.prepare(SQL_STYLE_INS_DECL),
    insClass: rawDb.prepare(SQL_STYLE_INS_CLASS),
    insUsage: rawDb.prepare(SQL_STYLE_INS_USAGE),
  };
}

/**
 * Insert TS/JS CSS-in-JS facts (from the styles-source visitor) into the
 * style_* tables. Mirrors the TS/JS branch the style indexer used to run
 * (Spec 10), but with the parse removed — stage 1 already parsed these files.
 *
 * The content-hash skip is a DB-WRITE guard, not a parse guard: stage 1 parses
 * every TS/JS file regardless and extraction is unconditional here, so the hash
 * exists only to avoid re-writing a file whose stored rows are already current.
 * This is the intended semantics — do not "restore" it back to a parse-time skip.
 *
 * Returns true when any file contributed a declaration or class-usage row (the
 * scoped short-circuit signal, equivalent to the old `contributingFiles`).
 */
function insertSourceStyleFacts(
  indexHandle: IndexHandle,
  sourceFacts: Record<string, {
    declarations: Array<{
      property: string; rawValue: string;
      normalizedValue: { type: string; value: string } | null;
      mechanism: string; filePath: string; line: number;
      context: string | null; variantContext: string | null;
      tokenRef: string | null;
    }>;
    classUsage: Array<{
      className: string; filePath: string; line: number;
      mechanism: string; unresolvable: boolean;
    }>;
    definedClasses: Array<{ className: string; filePath: string }>;
    contentHash: string;
  }> | undefined,
  isScoped: boolean,
): boolean {
  if (!sourceFacts) return false;
  const entries = Object.entries(sourceFacts);
  if (entries.length === 0) return false;

  const rawDb = indexHandle.rawDb as {
    prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
  };

  const stmts = {
    ...prepareCommonStyleStatements(rawDb),
    getHash: rawDb.prepare(SQL_STYLE_GET_HASH),
  };

  let contributed = false;

  const insertOne = (filePath: string, facts: (typeof entries)[number][1]): void => {
    if (facts.declarations.length > 0 || facts.classUsage.length > 0) contributed = true;

    // Full-run content-hash skip: leave already-current rows untouched. Scoped
    // runs always re-write, matching the old style indexer's `if (!scoped)` guard.
    if (!isScoped) {
      const stored = getStyleHash(stmts, filePath);
      if (stored?.content_hash === facts.contentHash) return;
    }

    // Delete stale rows — all four tables, mirroring the old deleteFileEntries
    // so a file that *lost* its styles also loses its stale rows.
    runStyleWrite(stmts, 'delDecl', [filePath]);
    runStyleWrite(stmts, 'delUsage', [filePath]);
    runStyleWrite(stmts, 'delTok', [filePath]);
    runStyleWrite(stmts, 'delClass', [filePath]);

    // Insert declarations (and their defined-class catalog entries).
    for (const decl of facts.declarations) {
      runStyleWrite(stmts, 'insDecl', [decl.property, decl.rawValue, decl.normalizedValue ? JSON.stringify(decl.normalizedValue) : null, decl.mechanism, decl.filePath, decl.line, decl.context, decl.variantContext, decl.tokenRef, facts.contentHash]);
    }
    // Defined classes come from the CSS parser over each CSS-in-JS template body
    // (harvested by the visitor and carried on the fact) — not a selector scan
    // over `declarations[].context`, so keyframes are excluded structurally.
    for (const ref of facts.definedClasses) {
      runStyleWrite(stmts, 'insClass', [ref.className, ref.filePath]);
    }

    // Insert class usage.
    for (const cu of facts.classUsage) {
      runStyleWrite(stmts, 'insUsage', [cu.className, cu.filePath, cu.line, cu.mechanism, cu.unresolvable ? 1 : 0]);
    }
  };

  rawDb.transaction(() => { for (const [fp, f] of entries) insertOne(fp, f); })();

  return contributed;
}

/**
 * Styles reducer — runs all style detectors on existing style_* tables.
 * Uses the analyzer.analyze([]) pattern: passes an empty file list so the
 * analyzer skips file iteration and only queries the DB.
 *
 * Spec 26 Phase 2: CSS facts from the styles-css visitor are inserted into
 * the DB before the analyzer runs. For .css files, the AST extraction replaces
 * the regex-based styleIndexer path (which now skips .css files).
 *
 * @returns The styles stage-3 reducer.
 */
export function createStylesReducer(): Stage3Reducer {
  return {
    name: 'styles',
    stage: 'reducer',
    consumes: [],
    getRuleIds: () => getRuleIdsFor('styles'),
    async reduce(_allFacts: Readonly<Record<string, unknown>>, context: ReducerContext) {
      if (!context.indexHandle) return { violations: [], facts: {} };
      const indexHandle = context.indexHandle;
      try {
        // ── Insert CSS visitor facts into style_* tables ──────────────────────
        const cssFacts = _allFacts['styles-css'] as
          Record<string, {
            declarations: Array<{
              property: string; rawValue: string;
              normalizedValue: { type: string; value: string };
              mechanism: string; filePath: string; line: number;
              context: string; variantContext: string | null;
              tokenRef: string | null;
            }>;
            tokens: Array<{
              name: string; value: string; filePath: string;
              mechanism: string;
            }>;
            classUsage: Array<{
              className: string; filePath: string; line: number;
              mechanism: string; unresolvable: boolean;
            }>;
          }> | undefined;

        // ── Source (TS/JS CSS-in-JS) visitor facts ───────────────────────────
        const sourceFacts = _allFacts['styles-source'] as
          Record<string, {
            declarations: Array<{
              property: string; rawValue: string;
              normalizedValue: { type: string; value: string } | null;
              mechanism: string; filePath: string; line: number;
              context: string | null; variantContext: string | null;
              tokenRef: string | null;
            }>;
            classUsage: Array<{
              className: string; filePath: string; line: number;
              mechanism: string; unresolvable: boolean;
            }>;
            definedClasses: Array<{ className: string; filePath: string }>;
            contentHash: string;
          }> | undefined;

        // ── Insert source facts, then decide whether to short-circuit ────────
        // The short-circuit fires when a scoped (changed/path-filtered) run has no
        // style-bearing work: no in-scope .css/.scss facts, no TS/JS file that
        // contributed a declaration/class-usage, and no markup file the style sync
        // contributed. Skipping the full-corpus query + O(n²) detectors removes the
        // ~590ms styles-reducer cost from the scoped gate.
        //
        // Source facts are inserted BEFORE the short-circuit so a scoped file that
        // *lost* its styles still has its stale rows dropped (the insertion always
        // runs; the analyzer is what gets skipped). `styles-*` facts are `{}` (empty
        // object) when nothing matched (pipeline.ts seeds every visitor with an empty
        // object), so test key-count rather than truthiness. `styleContributingFiles`
        // is `undefined` when the style sync did not run — reducers must NOT
        // short-circuit on `undefined`.
        const hasCssFacts = !!cssFacts && Object.keys(cssFacts).length > 0;
        const styleSyncContributedNothing =
          Array.isArray(context.styleContributingFiles) &&
          context.styleContributingFiles.length === 0;
        const sourceContributed = insertSourceStyleFacts(indexHandle, sourceFacts, context.isScoped ?? false);

        if (cssFacts) {
          // Prepare each statement once and run the whole re-insertion in a
          // single transaction. The prior code went through `indexHandle.run`,
          // which re-`prepare()`s the SQL on every call AND auto-commits per
          // statement — measured at 345ms for 5 files / ~13k declarations on
          // recall-protocol. Prepare-once + one transaction collapses that.
          const rawDb = context.indexHandle.rawDb as {
            prepare(sql: string): { run(...params: unknown[]): unknown };
            transaction<T extends (...args: unknown[]) => unknown>(fn: T): T;
          };
          const stmts = {
            ...prepareCommonStyleStatements(rawDb),
            insTok: rawDb.prepare(SQL_STYLE_INS_TOKEN),
          };

          const insertAll = (): void => {
            for (const [filePath, facts] of Object.entries(cssFacts)) {
              // Delete old entries for this file (replaces the styleIndexer path)
              runStyleWrite(stmts, 'delDecl', [filePath]);
              runStyleWrite(stmts, 'delTok', [filePath]);
              runStyleWrite(stmts, 'delUsage', [filePath]);
              runStyleWrite(stmts, 'delClass', [filePath]);

              // Compute content hash for the file
              const contentStr = JSON.stringify({ declarations: facts.declarations.length, tokens: facts.tokens.length, classUsage: facts.classUsage.length });
              const contentHash = createHash('sha256').update(contentStr).digest('hex').slice(0, 16);

              // Insert declarations
              for (const decl of facts.declarations) {
                runStyleWrite(stmts, 'insDecl', [decl.property, decl.rawValue, JSON.stringify(decl.normalizedValue), decl.mechanism, decl.filePath, decl.line, decl.context, decl.variantContext, decl.tokenRef, contentHash]);
              }
              // Populate the defined-class catalog (Spec 45) from the CSS parser's
              // class-selector harvest (`classUsage`) — keyframes and pseudo-classes
              // are excluded structurally, so no selector scrape over `context`.
              for (const ref of harvestDefinedClasses(facts.declarations, facts.classUsage, true)) {
                runStyleWrite(stmts, 'insClass', [ref.className, ref.filePath]);
              }

              // Insert tokens
              for (const tok of facts.tokens) {
                runStyleWrite(stmts, 'insTok', [tok.name, tok.value, tok.filePath, tok.mechanism]);
              }

              // Insert class usage
              for (const cu of facts.classUsage) {
                runStyleWrite(stmts, 'insUsage', [cu.className, cu.filePath, cu.line, cu.mechanism, cu.unresolvable ? 1 : 0]);
              }
            }
          };
          rawDb.transaction(insertAll)();
        }

        // Short-circuit on non-style-bearing scoped runs — the source and CSS
        // facts above are already written (so stale rows are dropped); only the
        // analyzer is skipped when nothing style-bearing changed.
        if (context.isScoped && !hasCssFacts && !sourceContributed && styleSyncContributedNothing) {
          return { violations: [], facts: {} };
        }

        // ── Run the analyzer (queries the now-populated style_* tables) ───────
        const { UniversalStylesAnalyzer } = await import(
          './analyzers/universal/UniversalStylesAnalyzer.js'
        );
        const analyzer = new UniversalStylesAnalyzer();
        const result = await analyzer.analyze([], { ...context.config, indexHandle: context.indexHandle });
        const factsConsumed = context.indexHandle.count('style_declarations')
                            + context.indexHandle.count('style_tokens')
                            + context.indexHandle.count('style_class_usage');
        return {
          violations: result.violations ?? [],
          facts: {},
          factsConsumed,
          ...((result.diagnostics?.length ?? 0) > 0 && { diagnostics: result.diagnostics }),
        };
      } catch {
        return { violations: [], facts: {} };
      }
    },
    defaultConfig: {},
    description: 'Detects style fragmentation, value drift, token bypass, and z-index sprawl',
    category: 'style',
  };
}

// ── Cross-language entity extraction + Stage-4 reducers ──────────────────────
//
// The three cross-language analyzers (SchemaValidator, APIContractAnalyzer,
// DependencyGraphBuilder) are corpus-wide: they compare schemas/endpoints/cycles
// across files and languages. They run as Stage-4 derived reducers over a single
// shared entity-extraction visitor, so each analyzer's rule IDs map to its own
// result row (coverage resolves by each rule's analyzer — one reducer per
// analyzer, not one reducer fanning out to three names).
//
// Scope-awareness ("Stage 4, and measure the gate"): the corpus-wide graph/cycle
// work is only meaningful on a full audit. On a scoped/diff run each reducer
// short-circuits with `notRunReason` BEFORE any corpus-wide work — the gate is in
// the design, not retrofitted after the budget blows. This is the shape that made
// the styles reducer 587ms; it must never run over a partial corpus.

// ── Entity helpers (ASTNode-based; parser-specific nodes stay in languages/) ──

/** A function body node — `statement_block` (TS/JS) or `block` (Go). */
function clBody(node: ASTNode): ASTNode | undefined {
  return node.children?.find(
    (c) => c.type === 'statement_block' || c.type === 'block',
  );
}

function clSignatureText(node: ASTNode, sourceCode: string): string {
  const body = clBody(node);
  const end = body ? body.range[0] : node.range[1];
  return sourceCode.slice(node.range[0], end).trim();
}

function clBodyText(node: ASTNode, sourceCode: string): string {
  const body = clBody(node);
  return body ? sourceCode.slice(body.range[0], body.range[1]) : '';
}

/** Prefer the `name` field (works across TS + Go), fall back to identifier children. */
function clNodeName(node: ASTNode, sourceCode: string): string | undefined {
  const field = getFieldNode(node, 'name');
  if (field) {
    const text = getNodeText(field, sourceCode);
    if (text) return text;
  }
  const id = node.children?.find((c) => c.type === 'identifier')
    ?? node.children?.find((c) => c.type === 'property_identifier');
  return id ? getNodeText(id, sourceCode) : undefined;
}

function clEntityId(filePath: string, type: string, name: string, line: number): string {
  return `${filePath}::${type}::${name}::${line}`;
}

function clIsExportedGo(name: string): boolean {
  return name.length > 0 && name[0] === name[0].toUpperCase();
}

/** Collect callee names from a function's body (TS `call_expression` / Go `call_expression`). */
function clCollectCallees(node: ASTNode, sourceCode: string): string[] {
  const names = new Set<string>();
  const walk = (n: ASTNode): void => {
    if (n.type === 'call_expression') {
      const fn = getFieldNode(n, 'function') ?? n.children?.[0];
      const text = fn ? getNodeText(fn, sourceCode).trim() : '';
      if (text && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(text)) {
        names.add(text);
      }
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return [...names];
}

/**
 * Whether a function node is lexically nested inside another function body.
 *
 * A nested function (a closure) is only reachable from its enclosing scope, not
 * from module top-level, so a flat name-based call graph cannot observe its use
 * the way it observes a top-level symbol's callers. The cross-language entity
 * extractor records this flag so orphan detection can treat a closure's "no
 * connections" as unproven rather than as evidence of dead code. Go named
 * functions are never nested (Go only admits anonymous function *literals*
 * inside a body, and those are not `function_declaration` nodes), so this is a
 * TS/JS-family signal.
 */
function clIsNestedFunction(node: ASTNode): boolean {
  let p: ASTNode | null = node.parent ?? null;
  while (p) {
    const t = p.type;
    if (
      t === 'function_declaration' ||
      t === 'method_definition' ||
      t === 'arrow_function' ||
      t === 'function_expression'
    ) {
      return true;
    }
    p = p.parent ?? null;
  }
  return false;
}

/**
 * Collect every reference name in a file's AST, independent of entity
 * boundaries. Orphan detection needs the complete same-file reference set —
 * `clCollectCallees` only walks the bodies of *extracted* entities, so a
 * reference made from an anonymous function (an inline route handler, an
 * object-literal method), a JSX component tag, or a bare function value
 * (`arr.map(singularize)`, `[missedClose, …]`) is invisible to it and leaves
 * the genuinely-referenced target looking orphaned.
 */
function clCollectFileReferences(node: ASTNode, sourceCode: string): string[] {
  const names = new Set<string>();
  const isIdentPath = (t: string) => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(t);
  const walk = (n: ASTNode): void => {
    const t = n.type;
    if (t === 'call_expression') {
      const fn = getFieldNode(n, 'function') ?? n.children?.[0];
      const text = fn ? getNodeText(fn, sourceCode).trim() : '';
      if (text && isIdentPath(text)) names.add(text);
    } else if (t === 'jsx_opening_element' || t === 'jsx_self_closing_element') {
      const nameNode = getFieldNode(n, 'name') ?? n.children?.[0];
      const text = nameNode ? getNodeText(nameNode, sourceCode).trim() : '';
      if (text && isIdentPath(text)) names.add(text);
    } else if (t === 'identifier') {
      // A bare identifier used as a value — an argument to a call
      // (`arr.map(singularize)`), an array element (`[missedClose, …]`), or an
      // object-literal value (`{ hostname: isValidHostname }`) — is a function
      // reference. Declaration names (`name` fields) and member accesses
      // (`property_identifier`) are separate node types and are not captured
      // here.
      const parent = n.parent;
      if (parent && (parent.type === 'arguments' || parent.type === 'array')) {
        const text = getNodeText(n, sourceCode).trim();
        if (text && /^[A-Za-z_$][\w$]*$/.test(text)) names.add(text);
      }
    } else if (t === 'shorthand_property_identifier') {
      // `{ isValidHostname }` — the shorthand key doubles as a reference to the
      // in-scope function of the same name. A function wired up only through an
      // object literal (`FORMAT_VALIDATORS`) has no call edge, so without this
      // it reads orphaned even though it is genuinely referenced.
      const text = getNodeText(n, sourceCode).trim();
      if (text && /^[A-Za-z_$][\w$]*$/.test(text)) names.add(text);
    } else if (t === 'pair') {
      // `{ key: value }` — the *value* may be a bare identifier referencing a
      // function (`{ hostname: isValidHostname }`); the key is a property name,
      // not a reference, and must not be added.
      const value = getFieldNode(n, 'value');
      if (value?.type === 'identifier') {
        const text = getNodeText(value, sourceCode).trim();
        if (text && /^[A-Za-z_$][\w$]*$/.test(text)) names.add(text);
      }
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return [...names];
}

function clMakeFunction(opts: {
  filePath: string;
  lang: string;
  name: string;
  line: number;
  signature: string;
  purpose: string;
  params: any[];
  callees: string[];
  exported: boolean;
  complexity: number;
  isMethod?: boolean;
}): CrossLanguageEntity {
  const { filePath, lang, name, line, signature, purpose, params, callees, exported, complexity, isMethod = false } = opts;
  return {
    id: clEntityId(filePath, 'function', name, line),
    name,
    language: lang,
    file: filePath,
    type: 'function',
    signature,
    parameters: params,
    startLine: line,
    visibility: exported ? 'public' : 'private',
    complexity,
    calls: [],
    calledBy: [],
    purpose,
    context: '',
    searchTokens: [name.toLowerCase()],
    metadata: { callees, isMethod },
  };
}

// ── TS/JS extraction ─────────────────────────────────────────────────────────

function clExtractTSParams(node: ASTNode, sourceCode: string): any[] {
  const params: any[] = [];
  const formal = node.children?.find((c) => c.type === 'formal_parameters');
  for (const p of formal?.children ?? []) {
    if (p.type !== 'required_parameter' && p.type !== 'optional_parameter') continue;
    const nameNode = getFieldNode(p, 'name') ?? p.children?.find((c) => c.type === 'identifier');
    const name = nameNode ? getNodeText(nameNode, sourceCode) : undefined;
    if (!name) continue;
    const typeNode = getFieldNode(p, 'type');
    const type = typeNode ? getNodeText(typeNode, sourceCode).trim() : undefined;
    params.push({ name, type, optional: p.type === 'optional_parameter', language: 'typescript' });
  }
  return params;
}

function clExtractTSInterfaceParams(node: ASTNode, sourceCode: string): any[] {
  const params: any[] = [];
  const walk = (n: ASTNode): void => {
    if (n.type === 'property_signature') {
      const nameNode = getFieldNode(n, 'name') ?? n.children?.find((c) => c.type === 'property_identifier');
      const name = nameNode ? getNodeText(nameNode, sourceCode) : undefined;
      if (!name) return;
      const typeNode = getFieldNode(n, 'type');
      const type = typeNode ? getNodeText(typeNode, sourceCode).trim() : undefined;
      const optional = n.children?.some((c) => c.type === '?') ?? false;
      params.push({ name, type, optional, language: 'typescript' });
    }
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  return params;
}

function clExtractTSEntities(
  root: ASTNode,
  filePath: string,
  sourceCode: string,
  lang: string,
  out: CrossLanguageEntity[],
): void {
  const fileReferences = clCollectFileReferences(root, sourceCode);
  walkAST(root, (node) => {
    if (node.type === 'function_declaration' || node.type === 'method_definition') {
      const name = clNodeName(node, sourceCode);
      if (!name) return;
      let displayName = name;
      if (node.type === 'method_definition') {
        let p: ASTNode | null = node.parent ?? null;
        while (p) {
          if (p.type === 'class_declaration') {
            const cn = clNodeName(p, sourceCode);
            if (cn) displayName = `${cn}.${name}`;
            break;
          }
          p = p.parent ?? null;
        }
      }
      const line = node.location.start.line;
      const entity = clMakeFunction({
        filePath, lang, name: displayName, line,
        signature: clSignatureText(node, sourceCode) || getNodeText(node, sourceCode),
        purpose: clBodyText(node, sourceCode),
        params: clExtractTSParams(node, sourceCode),
        callees: clCollectCallees(node, sourceCode),
        exported: isExported(node),
        complexity: calculateComplexity(node),
        isMethod: node.type === 'method_definition',
      });
      entity.metadata!.fileReferences = fileReferences;
      entity.metadata!.isNested = clIsNestedFunction(node);
      out.push(entity);
      return;
    }

    if (node.type === 'variable_declarator') {
      const arrow = node.children?.find((c) => c.type === 'arrow_function');
      if (!arrow) return;
      const nameNode = node.children?.find((c) => c.type === 'identifier');
      const name = nameNode ? getNodeText(nameNode, sourceCode) : undefined;
      if (!name) return;
      const line = node.location.start.line;
      const entity = clMakeFunction({
        filePath, lang, name, line,
        signature: clSignatureText(arrow, sourceCode) || getNodeText(arrow, sourceCode),
        purpose: clBodyText(arrow, sourceCode),
        params: [],
        callees: clCollectCallees(arrow, sourceCode),
        exported: isExported(node),
        complexity: calculateComplexity(node),
      });
      entity.metadata!.fileReferences = fileReferences;
      entity.metadata!.isNested = clIsNestedFunction(node);
      out.push(entity);
      return;
    }

    if (node.type === 'interface_declaration') {
      const name = clNodeName(node, sourceCode);
      if (!name) return;
      const line = node.location.start.line;
      out.push({
        id: clEntityId(filePath, 'interface', name, line),
        name,
        language: lang,
        file: filePath,
        type: 'interface',
        signature: getNodeText(node, sourceCode),
        parameters: clExtractTSInterfaceParams(node, sourceCode),
        startLine: line,
        visibility: isExported(node) ? 'public' : 'private',
        calls: [],
        calledBy: [],
        purpose: '',
        context: '',
        searchTokens: [name.toLowerCase()],
        metadata: {},
      });
      return;
    }
  });
}

// ── Go extraction ────────────────────────────────────────────────────────────

function clGoReceiverType(receiver: ASTNode, sourceCode: string): string | undefined {
  for (const child of receiver.children ?? []) {
    if (child.type === 'parameter_declaration') {
      const typeNode = getFieldNode(child, 'type');
      if (typeNode) return getNodeText(typeNode, sourceCode).replace(/^\*/, '');
    }
  }
  return undefined;
}

function clExtractGoParams(node: ASTNode, sourceCode: string): any[] {
  const params: any[] = [];
  const paramList = getFieldNode(node, 'parameters');
  for (const p of paramList?.children ?? []) {
    if (p.type !== 'parameter_declaration') continue;
    const nameNode = getFieldNode(p, 'name') ?? getFieldNode(p, 'type');
    const name = nameNode ? getNodeText(nameNode, sourceCode) : undefined;
    const typeNode = getFieldNode(p, 'type');
    const type = typeNode ? getNodeText(typeNode, sourceCode).trim() : undefined;
    if (!name && !type) continue;
    params.push({ name: name ?? type ?? '<unknown>', type, optional: false, language: 'go' });
  }
  return params;
}

function clExtractGoStructFields(structNode: ASTNode, sourceCode: string): any[] {
  const fields: any[] = [];
  // A struct's fields are not direct children of `struct_type` — tree-sitter-go
  // wraps them in a `field_declaration_list`. Iterate one level in so the
  // per-field name/type/tag extraction actually sees them.
  for (const child of structNode.children ?? []) {
    const decls = child.type === 'field_declaration_list' ? (child.children ?? []) : [child];
    for (const f of decls) {
      if (f.type !== 'field_declaration') continue;
      const nameNode = getFieldNode(f, 'name');
      const name = nameNode ? getNodeText(nameNode, sourceCode) : undefined;
      if (!name) continue;
      const typeNode = getFieldNode(f, 'type');
      const type = typeNode ? getNodeText(typeNode, sourceCode).trim() : undefined;
      const tagNode = getFieldNode(f, 'tag');
      const tag = tagNode ? getNodeText(tagNode, sourceCode) : undefined;
      fields.push({ name, type, isExported: clIsExportedGo(name), tag });
    }
  }
  return fields;
}

function clExtractGoEntities(
  root: ASTNode,
  filePath: string,
  sourceCode: string,
  out: CrossLanguageEntity[],
): void {
  const fileReferences = clCollectFileReferences(root, sourceCode);
  walkAST(root, (node) => {
    if (node.type === 'function_declaration') {
      const name = clNodeName(node, sourceCode);
      if (!name) return;
      const receiver = getFieldNode(node, 'receiver');
      const receiverType = receiver ? clGoReceiverType(receiver, sourceCode) : undefined;
      const displayName = receiverType ? `${receiverType}.${name}` : name;
      const line = node.location.start.line;
      const entity = clMakeFunction({
        filePath, lang: 'go', name: displayName, line,
        signature: clSignatureText(node, sourceCode) || getNodeText(node, sourceCode),
        purpose: clBodyText(node, sourceCode),
        params: clExtractGoParams(node, sourceCode),
        callees: clCollectCallees(node, sourceCode),
        exported: clIsExportedGo(name),
        complexity: calculateComplexity(node),
      });
      entity.metadata!.fileReferences = fileReferences;
      out.push(entity);
      return;
    }

    if (node.type === 'type_declaration') {
      for (const spec of node.children ?? []) {
        if (spec.type !== 'type_spec') continue;
        const nameNode = getFieldNode(spec, 'name');
        const name = nameNode ? getNodeText(nameNode, sourceCode) : undefined;
        if (!name) continue;
        const typeNode = getFieldNode(spec, 'type');
        const line = spec.location.start.line;
        if (typeNode?.type === 'struct_type') {
          out.push({
            id: clEntityId(filePath, 'struct', name, line),
            name,
            language: 'go',
            file: filePath,
            type: 'struct',
            signature: getNodeText(spec, sourceCode),
            parameters: [],
            startLine: line,
            visibility: clIsExportedGo(name) ? 'public' : 'private',
            calls: [],
            calledBy: [],
            purpose: '',
            context: '',
            searchTokens: [name.toLowerCase()],
            metadata: { fields: clExtractGoStructFields(typeNode, sourceCode) },
          });
        } else if (typeNode?.type === 'interface_type') {
          out.push({
            id: clEntityId(filePath, 'interface', name, line),
            name,
            language: 'go',
            file: filePath,
            type: 'interface',
            signature: getNodeText(spec, sourceCode),
            parameters: [],
            startLine: line,
            visibility: clIsExportedGo(name) ? 'public' : 'private',
            calls: [],
            calledBy: [],
            purpose: '',
            context: '',
            searchTokens: [name.toLowerCase()],
            metadata: {},
          });
        }
      }
      return;
    }
  });
}

// ── Shared entity visitor (Stage 2) ──────────────────────────────────────────

/**
 * Spec 68 §3.2 — the `cross-language-entities` FileProcessor extraction.
 *
 * The entity half of {@link createCrossLanguageEntityVisitor}, factored out so
 * the phase-model producer can call it directly without the Stage-2 `visit`
 * plumbing (violations/facts/indexFacts). Emits the same `CrossLanguageEntity[]`
 * the visitor feeds the cross-language analyzers; the per-file imports/exports
 * half of the visitor is the reachability/coverage concern (§8), not this fact.
 *
 * @param ast - The parsed file to extract entities from.
 * @param filePath - The file path stamping each extracted entity.
 * @param sourceCode - Source text used for names and signatures.
 * @param lang - The resolved language (`go`, `typescript`, or `javascript`).
 * @returns The cross-language entities extracted from the file.
 */
export function extractCrossLanguageEntities(
  ast: AST,
  filePath: string,
  sourceCode: string,
  lang: string,
): CrossLanguageEntity[] {
  const root = ast.root;
  const entities: CrossLanguageEntity[] = [];
  if (lang === 'go') {
    clExtractGoEntities(root, filePath, sourceCode, entities);
  } else {
    clExtractTSEntities(root, filePath, sourceCode, lang, entities);
  }
  return entities;
}

// ── Invariants reducer (stage 3) ──────────────────────────────────────────────

/**
 * Invariants reducer — enforces user-defined invariant rules from .codeauditor.json.
 * Receives the full file list via context.files and runs the rule engine across
 * all files at once (call-constraint rules inherently need cross-file scope).
 *
 * @returns The invariants stage-3 reducer.
 */
export function createInvariantsReducer(): Stage3Reducer {
  return {
    name: 'invariants',
    stage: 'reducer',
    consumes: [],
    getRuleIds: () => getRuleIdsFor('invariants'),
    async reduce(_allFacts: Readonly<Record<string, unknown>>, context: ReducerContext) {
      try {
        // Auto-disable when no rules are configured — signal notRun to the
        // pipeline so coverage reports invariants rules as notApplicable with
        // an accurate reason (Spec 05 R3.1, Spec 27 criterion 5).
        const rules = (context.config as any).rules;
        if (!rules || (Array.isArray(rules) && rules.length === 0)) {
          return {
            violations: [],
            facts: {},
            notRunReason: 'invariants disabled — no rules configured',
          };
        }

        const { analyzeInvariants } = await import(
          './analyzers/invariantsAnalyzer.js'
        );
        // Full file list is in _infra.files (merged into context.config via pipeline)
        const files = (context.config as any).files as string[] ?? [];
        // Absolute paths — format-equivalent to the old sourceMap.keys().
        const knownFiles: Set<string> = new Set(files);

        // B1: Build fileData from the function-index visitor's AST-extracted
        // imports/exports — replaces regex-based extractImports/extractExportedSymbols
        const functionIndexFacts = _allFacts['function-index'] as
          Record<string, { imports?: Array<{ moduleSpecifier: string; isStatic: boolean; isDynamic: boolean; isRequire: boolean; line: number }>; exports?: Array<{ name: string; location?: { start: { line: number } }; isDefault: boolean }> }> | undefined;

        let fileData: Map<string, {
          imports: Array<{ moduleSpecifier: string; isStatic: boolean; isDynamic: boolean; isRequire: boolean; line: number }>;
          exports: Array<{ name: string; line: number }>;
        }> | undefined;

        if (functionIndexFacts) {
          fileData = new Map();
          const projectRoot = context.projectRoot;
          for (const [filePath, data] of Object.entries(functionIndexFacts)) {
            if (data && (data.imports || data.exports)) {
              // Normalize absolute paths to project-relative (matching checkRules normalization)
              const normalized = path.isAbsolute(filePath)
                ? path.relative(projectRoot, filePath)
                : filePath;
              fileData.set(normalized, {
                imports: (data.imports || []).map((imp) => ({
                  moduleSpecifier: imp.moduleSpecifier,
                  isStatic: imp.isStatic,
                  isDynamic: imp.isDynamic,
                  isRequire: imp.isRequire,
                  line: imp.line,
                })),
                exports: (data.exports || []).map((exp) => ({
                  name: exp.name,
                  line: exp.location?.start?.line ?? 0,
                })),
              });
            }
          }
        }

        const result = await analyzeInvariants(
          files,
          { ...context.config, readSource: context.readSource, knownFiles, fileData, isScoped: context.isScoped },
          { projectRoot: context.projectRoot, indexHandle: context.indexHandle } as any,
        );
        return {
          violations: result.violations ?? [],
          facts: {},
          factsConsumed: files.length,
        };
      } catch {
        return { violations: [], facts: {} };
      }
    },
    defaultConfig: {},
    description: 'Enforces custom invariant rules (import bans, call constraints, module boundaries, naming)',
    category: 'architecture',
  };
}

// ── Schema visitors and reducer (Task #41 Part A) ──────────────────────────

// Need provenance for per-file gate + reference extraction
let _provenanceModule: any = null;
async function _getProvenanceModule() {
  if (!_provenanceModule) {
    _provenanceModule = await import('./analyzers/provenance.js');
  }
  return _provenanceModule;
}

/** The shared lazy `UniversalSchemaAnalyzer` for the schema-code visitor. Hoisted
 *  to module scope so the factory below stays a thin descriptor and the analyzer
 *  is constructed once, not per factory call. */
const getSchemaCodeAnalyzer = lazySingleton<any>(() =>
  import('./analyzers/universal/UniversalSchemaAnalyzer.js').then((m) => ({
    analyzer: new m.UniversalSchemaAnalyzer(),
    defaults: m.DEFAULT_SCHEMA_CONFIG,
    parseMigrationOps: m.parseMigrationOps,
    extractDdlColumnNames: m.extractDdlColumnNames,
    extractDdlTableColumns: m.extractDdlTableColumns,
  })),
);

/** The schema-code visitor's per-file `visit` body, extracted from
 *  `createSchemaCodeVisitor` (which exceeded the 200-line `function-length`
 *  budget) so the factory stays a thin descriptor over the shared analyzer. */
async function runSchemaCodeVisit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string) {
  const { defaults, parseMigrationOps, extractDdlColumnNames, extractDdlTableColumns } = await getSchemaCodeAnalyzer();
  const pm = await _getProvenanceModule();
  const violations: Violation[] = [];

  // Pipeline config for this analyzer (moved before table extraction, needed
  // by the table-source registry and provenance context).
  const schemaConfig = (context.config ?? {}) as Record<string, unknown>;
  // Spec 70 R1 — the corpus's named dialect (or null) threads to the DDL
  // extractors so DO-local DDL parses instead of regex. A null dialect is
  // cannot-fire (no DDL facts).
  const dialect = schemaConfig.sqlDialect as Dialect | null | undefined;

  // Spec 29 R2: Extract ORM table names via declarative table-source registry.
  // Adding an ORM is now a config entry, not code.  Falls back to Drizzle
  // entries when no user-specified tableSources are configured.
  const ormTables: string[] = [];
  const tableProvenances: Array<{ table: string; source: any }> = [];
  const tableSources = (schemaConfig.tableSources as any[]) ?? [
    { kind: 'callee', name: 'pgTable', arg: 0, description: 'Drizzle PostgreSQL table' },
    { kind: 'callee', name: 'mysqlTable', arg: 0, description: 'Drizzle MySQL table' },
    { kind: 'callee', name: 'sqliteTable', arg: 0, description: 'Drizzle SQLite table' },
  ];
  if (tableSources.length > 0) {
    const registered = extractTablesFromRegistry(tableSources, {
      ast: ast as AST,
      adapter: adapter as LanguageAdapter,
      sourceCode,
      filePath: context.filePath,
    });
    for (const { table, source } of registered) {
      ormTables.push(table);
      tableProvenances.push({ table, source });
    }
  }

  // Extract DDL from sql.exec(...) string literals inside Durable Object classes.
  // These are CREATE TABLE / DROP TABLE statements at runtime that migration
  // discovery never sees.  Extracting them completes the authoritative catalog
  // so unknown-table doesn't false-positive on DO-local tables.
  const doDDL: string[] = [];
  const doTemplateDDL = /`([^`]*(?:CREATE|DROP|ALTER)\s+(?:TABLE|VIRTUAL\s+TABLE)\s+[^`]+)`/gis;
  const doStringDDL = /(["'])((?:\s*(?:CREATE|DROP|ALTER)\s+(?:TABLE|VIRTUAL\s+TABLE)\s+[^"']+))\1/gis;
  let ddlMatch: RegExpExecArray | null;
  while ((ddlMatch = doTemplateDDL.exec(sourceCode)) !== null) {
    const sql = ddlMatch[1].trim();
    if (sql) doDDL.push(sql);
  }
  while ((ddlMatch = doStringDDL.exec(sourceCode)) !== null) {
    const sql = ddlMatch[2].trim();
    if (sql) doDDL.push(sql);
  }
  const doDDLSql = doDDL.length > 0 ? doDDL.join(';\n') : null;
  const doDDLColumns = doDDLSql ? extractDdlColumnNames(doDDLSql, dialect ?? null) : [];
  const doDDLTableColumns = doDDLSql ? extractDdlTableColumns(doDDLSql, dialect ?? null) : {};

  // Build provenance context for this file — defaults from DEFAULT_SCHEMA_CONFIG
  const detectionMode = ((schemaConfig.detection as any)?.mode as string) ?? ('hybrid' as any);
  const provenanceContext = pm.buildProvenanceContext(ast as AST, adapter as LanguageAdapter, sourceCode, {
    mode: detectionMode,
    dbBindingNames: (schemaConfig.dbBindingNames as string[]) ?? defaults.dbBindingNames,
    dbWrapperNames: (schemaConfig.dbWrapperNames as string[]) ?? defaults.dbWrapperNames,
    // Spec 70 criterion 8 — thread the corpus's named dialect so R3 can prove
    // a receiver by its parsed SQL argument (the criterion-9 type-annotation
    // tests are gone). Mirrors buildSchemaProvenanceContext in the analyzer.
    sqlDialect: dialect ?? null,
  });

  // Spec 70 criterion 2 — the declaration-resolution environment `identifyHandle`
  // reads for handle admission (mirrors buildSchemaHandleEnv). Absent for Go,
  // which has no local binding env and resolves cross-file.
  const handleEnv: RootResolutionEnv | undefined =
    (adapter as LanguageAdapter).name === 'go'
      ? undefined
      : {
          provenance: provenanceContext.dbProvenanced,
          bindings: buildBindingEnv(ast as AST, adapter as LanguageAdapter, sourceCode),
          adapter: adapter as LanguageAdapter,
          sourceCode,
        };

  // File gate — skip files without DB usage
  if (!passesFileGate(context.filePath, sourceCode, schemaConfig, provenanceContext)) {
    const facts: Record<string, unknown> = { [context.filePath]: { tableRefs: [], ormTables, tableProvenance: tableProvenances } };
    if (doDDL.length > 0) {
      (facts[context.filePath] as any).ddlOps = parseMigrationOps(doDDLSql!, dialect ?? null);
      if (doDDLColumns.length > 0) (facts[context.filePath] as any).ddlColumns = doDDLColumns;
      if (Object.keys(doDDLTableColumns).length > 0) (facts[context.filePath] as any).ddlTableColumns = doDDLTableColumns;
    }
    return { violations: [], facts };
  }

  // Build known-tables set from schemas config (pre-pipeline + DB-loaded schemas)
  const schemas = (schemaConfig.schemas as any[]) ?? [];
  const knownTablesArr: string[] = (schemaConfig.knownTables as string[]) ?? [];
  const allTables = new Set<string>();
  for (const t of knownTablesArr) allTables.add(t);
  for (const schema of schemas) {
    for (const table of (schema.tables ?? [])) {
      allTables.add(table.name);
    }
  }

  // Find table references (per-file, uses allTables for short-id false-positive
  // filtering). The `unresolved`/`unparseable` halves are no longer consumed
  // here: both the `unresolved-query` (Spec 58 R1 / 70 1b) and `unparseable`
  // (Spec 70 R2) coverage diagnostics are re-derived corpus-side
  // (classifyUnresolvedQuerySites / classifyUnparseableSql →
  // buildReceiverDiagnostics), so this visitor stops emitting them.
  const { references: tableRefs } = findTableReferences(ast as AST, adapter as LanguageAdapter, sourceCode, { config: schemaConfig, provenanceContext, allTables, handleEnv });

  // Check naming conventions
  if (schemaConfig.checkNamingConventions !== false) {
    violations.push(...checkNamingConventions(tableRefs, context.filePath));
  }

  // Check query patterns
  if (schemaConfig.validateQueryPatterns !== false) {
    violations.push(...checkQueryPatterns(ast as AST, adapter as LanguageAdapter, sourceCode, schemaConfig));
  }

  // Check SQL injection
  violations.push(...checkSQLInjection(ast as AST, adapter as LanguageAdapter, sourceCode));

  // Emit facts for the Stage 3 reducer. Fluent-builder references
  // (`origin: 'query-builder'`) are excluded from the unknown-table check:
  // a scratch/test table name carried by `db('t').select(...)` is not a
  // schema catalog miss, and feeding it in flips the 10:1 fail-open ratio.
  const fileFacts: Record<string, unknown> = {
    tableRefs: tableRefs
      .filter((r) => (r as { origin?: string }).origin !== 'query-builder')
      .map((r: { table: string; type: string; location: { line: number; column: number }; context: string }) => ({
        table: r.table,
        type: r.type,
        line: r.location.line,
        column: r.location.column,
        context: r.context,
      })),
    ormTables,
    tableProvenance: tableProvenances,
  };
  if (doDDL.length > 0) {
    (fileFacts as any).ddlOps = parseMigrationOps(doDDLSql!, dialect ?? null);
    if (doDDLColumns.length > 0) (fileFacts as any).ddlColumns = doDDLColumns;
    if (Object.keys(doDDLTableColumns).length > 0) (fileFacts as any).ddlTableColumns = doDDLTableColumns;
  }

  return {
    violations,
    facts: { [context.filePath]: fileFacts },
  };
}

/**
 * Schema code visitor (.ts/.tsx/.js/.jsx) — per-file analysis for naming conventions,
 * query patterns, SQL injection, table references, and ORM table extraction.
 *
 * @returns The schema-code stage-2 visitor.
 */
export function createSchemaCodeVisitor(): Stage2Visitor {
  return {
    name: 'schema-code',
    stage: 'visitor',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
    getRuleIds: () => getRuleIdsFor('schema'),
    visit: runSchemaCodeVisit,
    defaultConfig: {},
    description: 'Per-file schema analysis: naming conventions, query patterns, SQL injection, table references',
    category: 'database',
  };
}

/**
 * Flatten `allFacts` (keyed by visitor name, each value `{ [filePath]: facts }`)
 * into per-file `[filePath, fact]` pairs.
 */
function* iteratePerFileFacts(
  allFacts: Readonly<Record<string, unknown>>
): Generator<[string, Record<string, unknown>]> {
  for (const [, visitorFacts] of Object.entries(allFacts)) {
    if (typeof visitorFacts === 'object' && visitorFacts !== null) {
      for (const [filePath, fact] of Object.entries(visitorFacts as Record<string, unknown>)) {
        if (typeof fact === 'object' && fact !== null) {
          yield [filePath, fact as Record<string, unknown>];
        }
      }
    }
  }
}

/**
 * Build the known-tables catalog (and derived column sets) from the schema-sql,
 * schema-code, and schema-prisma facts. Also replays SQL migrations to compute
 * drop provenance for stale-table-reference detection.
 */
function buildSchemaCatalog(allFacts: Readonly<Record<string, unknown>>): {
  knownTables: Set<string>;
  tableProvenances: Map<string, any[]>;
  dropProvenance: Map<string, { migrationFile: string; createdInSameMigration: string[] }>;
  ddlColumns: Set<string>;
  tableColumns: Record<string, string[]>;
} {
  const knownTables = new Set<string>();
  const tableProvenances = new Map<string, any[]>(); // table name → origins

  // 1a. SQL DDL replay — collect all DDL facts, sort by numeric prefix, replay
  const sqlFiles: Array<{ filePath: string; ops: MigrationOp[] }> = [];
  for (const [filePath, fact] of iteratePerFileFacts(allFacts)) {
    if ('ddlOps' in fact) {
      sqlFiles.push({ filePath, ops: fact.ddlOps as MigrationOp[] });
    }
  }
  // Sort by numeric prefix in basename: "009_something" < "0010_rename"
  // Falls back to localeCompare for non-numeric-prefixed names.
  const numericPrefix = (p: string): number => {
    const base = p.split('/').pop() ?? p;
    const m = base.match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };
  sqlFiles.sort((a, b) => {
    const na = numericPrefix(a.filePath);
    const nb = numericPrefix(b.filePath);
    if (na !== nb) return na - nb;
    return a.filePath.localeCompare(b.filePath);
  });
  // Drop provenance — the last migration that removed a table, and the tables
  // that same migration introduced. Lets unknown-table detection distinguish
  // "never existed" from "existed and was dropped": the latter is a stale code
  // reference, not a typo. `dropProvenance` ends up holding exactly the tables
  // dropped and not subsequently recreated (CREATE clears the entry).
  const dropProvenance = new Map<string, { migrationFile: string; createdInSameMigration: string[] }>();
  for (const sqlFile of sqlFiles) {
    const before = new Set(knownTables);
    applyMigrationOps(sqlFile.ops, knownTables);
    // Record provenance for newly created tables
    for (const table of knownTables) {
      if (!before.has(table)) {
        const sources = tableProvenances.get(table) ?? [];
        sources.push({ table, tier: 'sql-migration', sourceFile: sqlFile.filePath, description: 'SQL migration' });
        tableProvenances.set(table, sources);
      }
    }
    // Genuinely-new tables introduced by this migration (excludes rename/rebuild
    // churn like `ALTER … RENAME TO x_old` + re-CREATE of the same name).
    const createdHere: string[] = [];
    const createdTables = new Set<string>();
    const droppedTables = new Set<string>();
    for (const op of sqlFile.ops) {
      const t = stripIdentifier(op.table);
      if (op.op === 'CREATE') {
        createdTables.add(t);
        if (!before.has(t)) createdHere.push(t);
      } else if (op.op === 'DROP') {
        droppedTables.add(t);
      }
    }
    for (const op of sqlFile.ops) {
      const t = stripIdentifier(op.table);
      if (op.op === 'DROP') {
        dropProvenance.set(t, { migrationFile: sqlFile.filePath, createdInSameMigration: createdHere });
      } else if (op.op === 'CREATE') {
        dropProvenance.delete(t);
      }
    }
    // A table created and dropped within this same file is a self-contained
    // fixture — a scratch table a test or script creates, uses, then tears
    // down. Its DROP is teardown, not a migration, so it must neither surface
    // as a stale-table-reference nor leave the name unknown: keep it known and
    // clear the drop provenance this file recorded for it. (A genuine dropped
    // table stays stale because its DROP lives in a migration that never also
    // CREATEs it — e.g. recall's `generation_queue`, dropped in 0198.)
    for (const t of createdTables) {
      if (droppedTables.has(t)) {
        knownTables.add(t);
        if (dropProvenance.get(t)?.migrationFile === sqlFile.filePath) {
          dropProvenance.delete(t);
        }
      }
    }
  }

  // 1b. ORM tables from code files — with provenance from the table-source registry
  for (const [filePath, fact] of iteratePerFileFacts(allFacts)) {
    const ormTables: string[] = (fact as any).ormTables ?? [];
    for (const t of ormTables) knownTables.add(t);

    const provenances: any[] = (fact as any).tableProvenance ?? [];
    for (const p of provenances) {
      const sources = tableProvenances.get(p.table) ?? [];
      sources.push(p.source);
      tableProvenances.set(p.table, sources);
    }
  }

  // 1c. Prisma models
  for (const [filePath, fact] of iteratePerFileFacts(allFacts)) {
    const prismaModels: string[] = (fact as any).prismaModels ?? [];
    for (const m of prismaModels) {
      knownTables.add(m);
      const sources = tableProvenances.get(m) ?? [];
      sources.push({ table: m, tier: 'prisma-model', sourceFile: filePath, description: 'Prisma model' });
      tableProvenances.set(m, sources);
    }
  }

  // 1d. Aggregate DDL-declared columns (Spec 39 — derived applicability).
  //      The schema-sql and schema-code visitors emit per-file `ddlColumns`;
  //      the reducer folds them into a single case-insensitive, deduplicated
  //      set so downstream applicability predicates can ask "does ANY table
  //      carry a tenant-scoping column?" without per-table column lists.
  //
  //      Spec 62 Amendment B — additionally fold the per-table
  //      `ddlTableColumns` into a corpus-wide `tableColumns` (Record<table,
  //      string[]>) so the Stage-4 missing-org-filter reducer can answer the
  //      per-query question "does THIS table carry a tenant column?" that the
  //      flat set cannot.
  const ddlColumns = new Set<string>();
  const tableColumnsMap = new Map<string, Set<string>>();
  for (const [filePath, fact] of iteratePerFileFacts(allFacts)) {
    const cols: string[] = (fact as any).ddlColumns ?? [];
    for (const c of cols) ddlColumns.add(String(c).toLowerCase());

    const perTable: Record<string, string[]> = (fact as any).ddlTableColumns ?? {};
    for (const [table, tableCols] of Object.entries(perTable)) {
      let set = tableColumnsMap.get(table);
      if (!set) {
        set = new Set<string>();
        tableColumnsMap.set(table, set);
      }
      for (const c of tableCols) set.add(String(c).toLowerCase());
    }
  }
  const tableColumns: Record<string, string[]> = {};
  for (const [table, set] of tableColumnsMap) tableColumns[table] = [...set];

  return { knownTables, tableProvenances, dropProvenance, ddlColumns, tableColumns };
}

/**
 * Merge external config tables into the catalog and detect table references
 * that resolve to no known table. Emits `unknown-table` and
 * `stale-table-reference` violations.
 */
function detectUnknownTables(opts: {
  knownTables: Set<string>;
  tableProvenances: Map<string, any[]>;
  dropProvenance: Map<string, { migrationFile: string; createdInSameMigration: string[] }>;
  allFacts: Readonly<Record<string, unknown>>;
  schemaConfig: Record<string, unknown>;
}): Violation[] {
  const { knownTables, tableProvenances, dropProvenance, allFacts, schemaConfig } = opts;
  const violations: Violation[] = [];

  // ── 2. Unknown-table detection ────────────────────────────────────────
  //
  // Fail-open guardrail: we can only accuse when the table catalog is
  // built from authoritative sources.  Empty catalog → cannot accuse.
  //
  // Authoritative sources (independent of query sites, not circular):
  //   • SQL migration files via schema-sql     (step 1a)
  //   • ORM model definitions via schema-code  (step 1b)
  //   • Prisma schemas via schema-prisma       (step 1c)
  //
  // External config tables (schemas from CodeIndexDB, wrangler.toml
  // pre-discovered tables) are added as a bonus but are not required.
  //
  // NOT authoritative: tables inferred from query-text alone.  Those
  // never enter the catalog (table refs are for checking, not building).

  // Merge external tables from config (bonus, not required).
  const externalKnownTables: string[] = (schemaConfig.knownTables as string[]) ?? [];
  for (const t of externalKnownTables) {
    knownTables.add(t);
    const sources = tableProvenances.get(t) ?? [];
    sources.push({ table: t, tier: 'external-config', description: 'External configuration' });
    tableProvenances.set(t, sources);
  }

  // Also read the documented schemas config (structured {name, tables} objects).
  // The standalone UniversalSchemaAnalyzer.analyze() path reads schemas; the
  // pipeline reducer must read it too, otherwise configuring only schemas
  // silently triggers fail-open (knownTables.size === 0).
  const externalSchemas: Array<{
    name: string; tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
  }> = (schemaConfig.schemas as any) ?? [];
  for (const schema of externalSchemas) {
    for (const table of schema.tables) {
      knownTables.add(table.name);
      const sources = tableProvenances.get(table.name) ?? [];
      sources.push({ table: table.name, tier: 'external-config', description: `Schema: ${schema.name}` });
      tableProvenances.set(table.name, sources);
    }
  }

  if (knownTables.size > 0) {
    // Collect all table references across all files
    const allTableRefs: Array<{ file: string; table: string; type: string; line: number; column: number; context: string }> = [];
    for (const [filePath, fact] of iteratePerFileFacts(allFacts)) {
      const refs: any[] = (fact as any).tableRefs ?? [];
      for (const ref of refs) {
        allTableRefs.push({ file: filePath, ...ref });
      }
    }

    // 10:1 fail-open ratio guard
    const unknownRefs = allTableRefs.filter(ref => !knownTables.has(ref.table));
    if (unknownRefs.length / Math.max(knownTables.size, 1) <= 10) {
      for (const ref of unknownRefs) {
        // The table existed and was dropped in a migration — a stale code
        // reference, not a typo. Name the dropping migration and the tables
        // that migration introduced (evidence, not proof of a successor).
        const drop = dropProvenance.get(ref.table);
        if (drop) {
          const migrationName = drop.migrationFile.split('/').pop() ?? drop.migrationFile;
          const created = drop.createdInSameMigration;
          const msg = created.length > 0
            ? `${ref.table} was dropped in ${migrationName}; that migration creates ${joinEnglish(created)}.`
            : `${ref.table} was dropped in ${migrationName} and was not recreated.`;
          violations.push({
            file: ref.file,
            line: ref.line,
            column: ref.column,
            severity: 'critical' as const,
            message: msg,
            rule: 'stale-table-reference',
            analyzer: 'schema',
            symbol: ref.table,
            resolution: {
              action: 'update-stale-reference',
              // The tables `created` are evidence the migration replaced the
              // dropped table, not proof of a drop-in successor — schemas can
              // be split or changed incompatibly, in which case the file must
              // be removed rather than updated. The summary names them as
              // context and leaves update-vs-remove to the reviewer.
              summary: created.length > 0
                ? `The table '${ref.table}' was dropped in ${migrationName}. That migration introduces ${joinEnglish(created)} — review this reference and update or remove it.`
                : `The table '${ref.table}' was dropped in ${migrationName} and was not recreated — update or remove this reference.`,
              symbols: created.length > 0 ? created : [ref.table],
              files: [ref.file],
              lines: [ref.line],
            },
          } as Violation);
          continue;
        }
        const suggestions = getNearestTableSuggestions(ref.table, knownTables, 2);
        const msg = suggestions.length > 0
          ? `Reference to unknown table '${ref.table}' (${ref.type}). Did you mean: ${suggestions.join(', ')}?`
          : `Reference to unknown table '${ref.table}' (${ref.type})`;
        const suggestionNames = suggestions.map((s) => s.replace(/^'|'$/g, ''));
        violations.push({
          file: ref.file,
          line: ref.line,
          column: ref.column,
          severity: 'critical' as const,
          message: msg,
          rule: 'unknown-table',
          analyzer: 'schema',
          symbol: ref.table,
          resolution: {
            action: suggestionNames.length > 0 ? 'use-known-table' : 'register-or-fix-table',
            summary: suggestionNames.length > 0
              ? `Rename the table reference '${ref.table}' to the nearest known table: ${suggestions.join(', ')}.`
              : `The table '${ref.table}' is not in the known catalog — register it, or fix the reference to a known table.`,
            symbols: suggestionNames.length > 0 ? suggestionNames : [ref.table],
            files: [ref.file],
            lines: [ref.line],
          },
        } as Violation);
      }
    }
  }

  return violations;
}

/**
 * Validate JSON schemas found in the corpus. Best-effort: failures are non-fatal.
 */
function validateJsonSchemas(opts: {
  schemaConfig: Record<string, unknown>;
  allFacts: Readonly<Record<string, unknown>>;
  context: ReducerContext;
  analyzeJsonSchemas: any;
}): Violation[] {
  const { schemaConfig, allFacts, context, analyzeJsonSchemas } = opts;
  const violations: Violation[] = [];

  if (schemaConfig.validateJsonSchemas !== false) {
    try {
      // Collect JSON file paths from the lightweight visitor markers, then
      // parse each on demand so parsed objects never survive past this loop.
      const jsonFiles: string[] = [];
      for (const [filePath, fact] of iteratePerFileFacts(allFacts)) {
        if ('isJson' in (fact as any)) {
          jsonFiles.push(filePath);
        }
      }
      const readJson = (filePath: string): object | null => {
        const raw = context.readSource?.(filePath);
        if (raw === undefined) return null;
        try {
          const parsed = JSON.parse(raw);
          return parsed !== null && typeof parsed === 'object' ? (parsed as object) : null;
        } catch {
          return null;
        }
      };
      const jsonResult = analyzeJsonSchemas(jsonFiles, readJson, schemaConfig);
      violations.push(...(jsonResult?.violations ?? []));
    } catch (e: any) {
      // JSON schema validation is best-effort (non-fatal)
    }
  }

  return violations;
}

