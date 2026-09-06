/**
 * Pipeline adapter factories (Spec 24).
 *
 * Each factory converts an existing analyzer into a Stage2Visitor,
 * Stage3Reducer, or Stage4Reducer for the pipeline. Lazy-loads analyzer
 * classes via dynamic import() to avoid circular dependency issues.
 *
 * Key patterns:
 *   - Per-file (solid, data-access, doc, schema): wrap analyzeAST()
 *   - DRY: wraps analyzeAST(), accumulates dryPairs internally →
 *     factory returns { visitor, getDryPairs } for post-pipeline extraction
 *   - React: wraps scanFile() per file, accumulates scan results →
 *     factory returns { visitor, finalizeCrossComponent }
 *   - DB-based (styles, conventions, cross-domain): reducers call
 *     analyzer.analyze([]) with rawDb injected through config
 *   - Invariants: Stage 3 reducer — receives full file list, runs rule engine
 */

import { createHash } from 'crypto';
import path from 'path';
import { RULE_REGISTRY } from './analyzers/ruleRegistry.js';
import type {
  IndexHandle,
  IndexFactsEntry,
  Stage2Visitor,
  Stage3Reducer,
  Stage4Reducer,
  Violation,
  VisitorContext,
  ReducerContext,
} from './types.js';
import type { AST, LanguageAdapter } from './languages/types.js';
import type { MigrationOp } from './analyzers/universal/UniversalSchemaAnalyzer.js';
import { TYPESCRIPT_EXTENSIONS, JAVASCRIPT_EXTENSIONS, getLanguageFromPath } from './utils/fileDiscovery.js';
import {
  walkAST,
  isExported,
  hasModifier,
  getNodeName,
  getLineAndColumn,
  calculateComplexity,
  getFunctionBody,
} from './languages/adapterBridge.js';
import {
  buildImportMap,
  extractFunctionCalls,
} from './utils/dependencyExtractor.js';
import { resolveDependency, basenameNoExt } from './graph/importGraph.js';
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
import { applyMigrationOps } from './analyzers/universal/schema/migrations.js';
import type { CrossLanguageEntity, CrossReference } from './types/crossLanguage.js';

// ── Rule ID helpers ──────────────────────────────────────────────────────────

function getRuleIdsFor(name: string): string[] {
  return Object.entries(RULE_REGISTRY)
    .filter(([, entry]) => entry.analyzer === name)
    .map(([id]) => id);
}

// ── Lazy import singleton ────────────────────────────────────────────────────

function lazySingleton<T>(loader: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    if (!promise) promise = loader();
    return promise;
  };
}

// ── SOLID visitor ────────────────────────────────────────────────────────────

export function createSolidVisitor(): Stage2Visitor {
  const getAnalyzer = lazySingleton<any>(() =>
    import('./analyzers/universal/UniversalSOLIDAnalyzer.js').then(
      (m) => new m.UniversalSOLIDAnalyzer(),
    ),
  );

  return {
    name: 'solid',
    stage: 'visitor',
    getRuleIds: () => getRuleIdsFor('solid'),
    async visit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string) {
      const a = await getAnalyzer();
      const violations: Violation[] = await a.analyzeAST(
        ast as AST, adapter as LanguageAdapter, context.config, sourceCode,
      );
      return {
        violations,
        facts: {},
      };
    },
    defaultConfig: {},
    description: 'Detects violations of SOLID principles',
    category: 'architecture',
  };
}

// ── DRY visitor ──────────────────────────────────────────────────────────────

export interface DryVisitorBundle {
  visitor: Stage2Visitor;
  /** Extract accumulated dryPairs after the pipeline finishes stage 2. */
  getDryPairs: () => Promise<Array<{
    pairFingerprint: string;
    file1: string; symbol1: string; line1: number; contentHash1: string;
    file2: string; symbol2: string; line2: number; contentHash2: string;
    similarity: number;
  }>>;
}

export function createDryVisitor(fullFunctionIndex?: any[]): DryVisitorBundle {
  const getAnalyzer = lazySingleton<any>(() =>
    import('./analyzers/universal/UniversalDRYAnalyzer.js').then(
      (m) => new m.UniversalDRYAnalyzer(),
    ),
  );

  const visitor: Stage2Visitor = {
    name: 'dry',
    stage: 'visitor',
    getRuleIds: () => getRuleIdsFor('dry'),
    async visit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string) {
      const a = await getAnalyzer();
      const config = fullFunctionIndex
        ? { ...context.config, fullFunctionIndex }
        : context.config;
      const violations: Violation[] = await a.analyzeAST(
        ast as AST, adapter as LanguageAdapter, config, sourceCode,
      );
      return { violations, facts: {} };
    },
    defaultConfig: {},
    description: 'Detects code duplication across the codebase',
    category: 'maintainability',
  };

  return {
    visitor,
    getDryPairs: async () => {
      try {
        const a = await getAnalyzer();
        return a.dryPairs ?? [];
      } catch {
        return [];
      }
    },
  };
}

// ── Data-Access visitor ──────────────────────────────────────────────────────

export function createDataAccessVisitor(): Stage2Visitor {
  const getAnalyzer = lazySingleton<any>(() =>
    import('./analyzers/universal/UniversalDataAccessAnalyzer.js').then(
      (m) => new m.UniversalDataAccessAnalyzer(),
    ),
  );

  return {
    name: 'data-access',
    stage: 'visitor',
    getRuleIds: () => getRuleIdsFor('data-access'),
    async visit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string) {
      const a = await getAnalyzer();
      const violations: Violation[] = await a.analyzeAST(
        ast as AST, adapter as LanguageAdapter, context.config, sourceCode,
      );
      return { violations, facts: {} };
    },
    defaultConfig: {},
    description: 'Analyzes database access patterns and data layer interactions',
    category: 'security',
  };
}

// ── Documentation visitor ────────────────────────────────────────────────────

export function createDocumentationVisitor(): Stage2Visitor {
  const getAnalyzer = lazySingleton<any>(() =>
    import('./analyzers/universal/UniversalDocumentationAnalyzer.js').then(
      (m) => new m.UniversalDocumentationAnalyzer(),
    ),
  );

  return {
    name: 'documentation',
    stage: 'visitor',
    getRuleIds: () => getRuleIdsFor('documentation'),
    async visit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string) {
      const a = await getAnalyzer();
      const violations: Violation[] = await a.analyzeAST(
        ast as AST, adapter as LanguageAdapter, context.config, sourceCode,
      );
      return { violations, facts: {} };
    },
    defaultConfig: {},
    description: 'Checks documentation completeness',
    category: 'style',
  };
}

// ── Secrets visitor ──────────────────────────────────────────────────────────

export function createSecretsVisitor(): Stage2Visitor {
  const getAnalyzer = lazySingleton<any>(() =>
    import('./analyzers/universal/UniversalSecretsAnalyzer.js').then(
      (m) => new m.UniversalSecretsAnalyzer(),
    ),
  );

  return {
    name: 'secrets',
    stage: 'visitor',
    getRuleIds: () => getRuleIdsFor('secrets'),
    async visit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string) {
      const a = await getAnalyzer();
      const violations: Violation[] = await a.analyzeAST(
        ast as AST, adapter as LanguageAdapter, context.config, sourceCode,
      );
      return { violations, facts: {} };
    },
    defaultConfig: {},
    description: 'Detects hardcoded credentials, API keys, and tokens',
    category: 'security',
  };
}

// ── Function-Index visitor (infrastructure) ──────────────────────────────────
// Always-on Stage 2 visitor that populates the `functions` table with
// per-file definitions so the conventions and cross-domain reducers have data
// to mine — even on a cold run with no prior `index sync`.
// The function_calls table is rebuilt post-pipeline after functions rows have
// their auto-increment IDs assigned.

function computeContentHash(body: string | undefined, signature: string | undefined): string {
  const normalized = (body ?? '').replace(/\s+/g, ' ').trim() + '|' + (signature ?? '').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/** Raw text from an ASTNode (tree-sitter node stored on `.raw`). */
function rawText(node: { raw?: unknown }): string {
  return (node.raw as { text?: string })?.text ?? '';
}

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

      // Only index TS/JS files
      const lang = getLanguageFromPath(filePath);
      if (lang === 'unknown') return { violations: [], facts: {} };

      // Clear existing entries for this file
      indexFacts.push({
        table: 'functions',
        data: { _action: 'clear-by-file', file_path: filePath },
      });

      // Build import map once per file for resolving call targets
      const importMap = buildImportMap(root);

      // Collect function-like nodes in two passes:
      //  1) function_declaration + method_definition nodes
      //  2) arrow functions assigned to variables (variable_declarator children)

      const fnEntries: Array<{
        name: string;
        line: number;
        endLine: number;
        entityType: string;
        componentType: string | null;
        isExported: boolean;
        complexity: number;
        body: string | undefined;
        functionCalls: string[];
      }> = [];

      // Pass 1 — named function declarations and methods
      walkAST(root, (node) => {
        if (node.type === 'function_declaration') {
          const nameNode = node.children?.find((c) => c.type === 'identifier');
          if (!nameNode) return;
          const name = rawText(nameNode);
          if (!name) return;

          const { line } = getLineAndColumn(node);
          const raw = node.raw as { startPosition?: { row: number }; endPosition?: { row: number } } | undefined;
          const endLine = line + (raw?.endPosition?.row ?? raw?.startPosition?.row ?? 0) - (raw?.startPosition?.row ?? line) + 1;
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
          const methodName = rawText(nameNode);
          if (!methodName) return;

          // Walk up to find class name
          let parent = (node as any).parent;
          let className = 'AnonymousClass';
          while (parent) {
            if (parent.type === 'class_declaration') {
              const cn = parent.children?.find((c: any) => c.type === 'identifier');
              if (cn) className = rawText(cn);
              break;
            }
            parent = parent.parent;
          }

          const { line } = getLineAndColumn(node);
          const raw = node.raw as { startPosition?: { row: number }; endPosition?: { row: number } } | undefined;
          const endLine = line + (raw?.endPosition?.row ?? raw?.startPosition?.row ?? 0) - (raw?.startPosition?.row ?? line) + 1;
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
        const name = rawText(nameNode);
        if (!name) return;

        // Don't duplicate if already covered as function_declaration
        // (shouldn't happen — function_declaration is a different node type)
        const { line } = getLineAndColumn(arrowFunc);
        const raw = arrowFunc.raw as { startPosition?: { row: number }; endPosition?: { row: number } } | undefined;
        const endLine = line + (raw?.endPosition?.row ?? raw?.startPosition?.row ?? 0) - (raw?.startPosition?.row ?? line) + 1;
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
          if (!isReactComponent(node)) return;
          const ct = detectComponentType(node);
          if (!ct) return;
          const cName = getComponentName(node);
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
            const raw =
              node.raw as
                | {
                    startPosition?: { row: number };
                    endPosition?: { row: number };
                  }
                | undefined;
            const endLine =
              line +
              (raw?.endPosition?.row ?? raw?.startPosition?.row ?? 0) -
              (raw?.startPosition?.row ?? line) +
              1;
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

      // Build IndexFactsEntry for each function
      for (const fn of fnEntries) {
        const metadata: Record<string, unknown> = {
          entityType: fn.entityType,
          isExported: fn.isExported,
          complexity: fn.complexity,
          functionCalls: fn.functionCalls,
          body: fn.body,
        };

        const contentHash = computeContentHash(fn.body, '');
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
            signature: '',
            return_type: null,
            complexity: fn.complexity,
            is_exported: fn.isExported ? 1 : 0,
            has_jsdoc: 0,
            jsdoc_description: '',
            parameters: null,
            body: fn.body ?? null,
            content_hash: contentHash,
            last_modified: now,
            metadata_json: JSON.stringify(metadata),
          },
          conflictKey: 'name, file_path, line_number',
        });
      }

      // ── Extract imports and exports from AST for downstream consumers ──
      // B1: Replaces regex-based extractImports()/extractExportedSymbols() in
      // ruleEngine.ts.  Also consumed by conventions (B2: detectExportForm).
      const langAdapter = _adapter as LanguageAdapter;
      const langAst = ast as AST;

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

      // Dynamic import() and require() — first attempt with pure NodePattern
      // Plan note: import keyword is an anonymous tree-sitter node, so
      // hasChild cannot see it.  We use `custom` with raw node access.
      const dynamicCallNodes = langAdapter.findNodes(langAst, {
        type: 'call_expression',
        custom: (node) => {
          const raw = (node.raw as any);
          const fn = raw?.firstChild;
          return (fn?.type === 'import') ||
                 (fn?.type === 'identifier' && fn.text === 'require');
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
        const raw = node.raw as any;
        const fn = raw?.firstChild;
        const isImport = fn?.type === 'import';
        const isRequire = !isImport && (fn?.type === 'identifier' && fn.text === 'require');

        // Walk the raw tree to find the string argument
        const argsNode = raw?.children?.find((c: any) => c.type === 'arguments') as any;
        const stringNode = argsNode?.children?.find((c: any) => c.type === 'string') as any;
        if (stringNode) {
          const text = stringNode.text as string;
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
        violations: [],
        facts: {
          [filePath]: {
            imports: [...staticImports, ...dynamicImports],
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

// ── React visitor ────────────────────────────────────────────────────────────

export interface ReactVisitorBundle {
  visitor: Stage2Visitor;
  /**
   * Run cross-component checks after all files have been visited.
   * Must be called after stage 2 completes.
   */
  finalizeCrossComponent: (config: any) => Promise<Violation[]>;
}

export function createReactVisitor(): ReactVisitorBundle {
  const scanResults: any[] = [];

  const visitor: Stage2Visitor = {
    name: 'react',
    stage: 'visitor',
    getRuleIds: () => getRuleIdsFor('react'),
    async visit(_ast: unknown, _adapter: unknown, context: VisitorContext, _sourceCode: string) {
      const filePath: string | undefined = context.filePath;
      if (!filePath) return { violations: [], facts: {} };

      try {
        const { scanFile } = await import('./componentScanner.js');
        const { analyzeComponent: analyzeComp, DEFAULT_REACT_CONFIG } = await import(
          './analyzers/reactAnalyzer.js'
        );
        // Merge with defaults so partial configs get all required fields
        const cfg = { ...DEFAULT_REACT_CONFIG, ...context.config };
        const sr = await scanFile(filePath, {
          includeTests: false,
          includeStories: false,
          extractProps: true,
          extractHooks: cfg.checkHooksRules,
          extractImports: true,
          detectComplexity: true,
        });

        scanResults.push(sr);

        if (sr.parseErrors && sr.parseErrors.length > 0) {
          return { violations: [], facts: {} };
        }

        // Per-component checks — same logic as reactAnalyzer.analyze()
        const violations: Violation[] = [];
        for (const comp of sr.components ?? []) {
          violations.push(...analyzeComp(comp, cfg, sr));
        }
        return { violations, facts: {} };
      } catch {
        return { violations: [], facts: {} };
      }
    },
    defaultConfig: {},
    description: 'Analyzes React components for best practices and performance',
    category: 'frontend',
  };

  return {
    visitor,
    finalizeCrossComponent: async (config: any) => {
      if (scanResults.length === 0) return [];
      const violations: Violation[] = [];
      try {
        const {
          checkCircularDependencies,
          checkErrorBoundaryUsage,
          checkRawElements,
          DEFAULT_REACT_CONFIG,
        } = await import('./analyzers/reactAnalyzer.js');

        // Merge with defaults — mirrors the visitor's
        // `{ ...DEFAULT_REACT_CONFIG, ...context.config }` so a partial config
        // still yields every required field, and so the `react.*` flags set in
        // .codeauditor.json reach the cross-component checks.
        const cfg = { ...DEFAULT_REACT_CONFIG, ...(config ?? {}) };

        // Build component tree and check for circular dependencies
        const { buildComponentTree } = await import('./componentScanner.js');
        const tree = buildComponentTree(scanResults);
        violations.push(...checkCircularDependencies(tree));

        // Check for missing error boundaries
        if (cfg.requireErrorBoundaries !== false) {
          violations.push(...checkErrorBoundaryUsage(scanResults));
        }

        // Check for raw element usage (Spec 10 R4)
        if (cfg.rawElementCheck !== false) {
          violations.push(...checkRawElements(scanResults, cfg));
        }
      } catch {
        // Cross-component checks are advisory
      }
      return violations;
    },
  };
}

// ── Styles reducer (stage 3) ─────────────────────────────────────────────────

// ── Styles CSS visitor (Spec 26 Phase 2) ───────────────────────────────────────

/**
 * Styles CSS visitor — extracts declarations, tokens, and class usage from
 * tree-sitter-css and tree-sitter-scss parsed ASTs. Replaces the regex-based
 * CSS/SCSS extraction in styleExtractor.ts for .css and .scss files.
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
            tokens: extractTokensFromCSSAst(cssAst, cssAdapter, filePath),
            classUsage: extractClassUsageFromCSSAst(cssAst, cssAdapter, filePath),
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
 */
export function createStylesSourceVisitor(): Stage2Visitor {
  return {
    name: 'styles-source',
    stage: 'visitor',
    extensions: [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS],
    getRuleIds: () => [],
    async visit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string) {
      // Lazy-load to avoid circular dependency issues at module load time.
      const { extractDeclarations } = await import('./styles/styleExtractor.js');
      const { extractClassUsage } = await import('./styles/styleIndexer.js');
      const { loadTailwindConfig } = await import('./styles/tailwindConfigLoader.js');
      const tsAst = ast as AST;
      const tsAdapter = adapter as LanguageAdapter;
      const filePath = context.filePath;

      // Memoized per projectRoot (the style-index sync already called it this
      // run), so this is a cache hit — never a re-walk of the project tree.
      const tailwindTokens = loadTailwindConfig(context.projectRoot).tokens;

      const declarations = extractDeclarations(filePath, tsAdapter, sourceCode, tsAst, tailwindTokens);
      const classUsage = extractClassUsage(filePath, sourceCode);
      const contentHash = createHash('sha256').update(sourceCode).digest('hex');

      return {
        violations: [],
        facts: {
          [filePath]: { declarations, classUsage, contentHash },
        },
      };
    },
    defaultConfig: {},
    description: 'Extracts CSS-in-JS declarations and class usage from TS/JS ASTs',
    category: 'style',
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
  } | undefined;

  const stmts = rawDb
    ? {
        getHash: rawDb.prepare('SELECT content_hash FROM style_declarations WHERE file_path = ? LIMIT 1'),
        delDecl: rawDb.prepare('DELETE FROM style_declarations WHERE file_path = ?'),
        delUsage: rawDb.prepare('DELETE FROM style_class_usage WHERE file_path = ?'),
        delTok: rawDb.prepare('DELETE FROM style_tokens WHERE file_path = ?'),
        delUnread: rawDb.prepare('DELETE FROM style_unread_sources WHERE file_path = ?'),
        delClass: rawDb.prepare('DELETE FROM style_defined_classes WHERE file_path = ?'),
        insDecl: rawDb.prepare('INSERT INTO style_declarations (property, raw_value, normalized_value, mechanism, file_path, line, context, variant_context, token_ref, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
        insClass: rawDb.prepare('INSERT OR IGNORE INTO style_defined_classes (class_name, file_path) VALUES (?, ?)'),
        insUsage: rawDb.prepare('INSERT INTO style_class_usage (class_name, file_path, line, mechanism, unresolvable) VALUES (?, ?, ?, ?, ?)'),
      }
    : null;

  let contributed = false;

  const insertOne = (filePath: string, facts: (typeof entries)[number][1]): void => {
    if (facts.declarations.length > 0 || facts.classUsage.length > 0) contributed = true;

    // Full-run content-hash skip: leave already-current rows untouched. Scoped
    // runs always re-write, matching the old style indexer's `if (!scoped)` guard.
    if (!isScoped) {
      const stored = stmts
        ? (stmts.getHash.get(filePath) as { content_hash: string } | undefined)
        : (indexHandle.query('SELECT content_hash FROM style_declarations WHERE file_path = ? LIMIT 1', [filePath])[0] as { content_hash: string } | undefined);
      if (stored?.content_hash === facts.contentHash) return;
    }

    // Delete stale rows — all five tables, mirroring the old deleteFileEntries
    // so a file that *lost* its styles also loses its stale unread-sources row.
    if (stmts) {
      stmts.delDecl.run(filePath);
      stmts.delUsage.run(filePath);
      stmts.delTok.run(filePath);
      stmts.delUnread.run(filePath);
      stmts.delClass.run(filePath);
    } else {
      indexHandle.run('DELETE FROM style_declarations WHERE file_path = ?', [filePath]);
      indexHandle.run('DELETE FROM style_class_usage WHERE file_path = ?', [filePath]);
      indexHandle.run('DELETE FROM style_tokens WHERE file_path = ?', [filePath]);
      indexHandle.run('DELETE FROM style_unread_sources WHERE file_path = ?', [filePath]);
      indexHandle.run('DELETE FROM style_defined_classes WHERE file_path = ?', [filePath]);
    }

    // Insert declarations (and their defined-class catalog entries).
    for (const decl of facts.declarations) {
      if (stmts) {
        stmts.insDecl.run(decl.property, decl.rawValue, decl.normalizedValue ? JSON.stringify(decl.normalizedValue) : null, decl.mechanism, decl.filePath, decl.line, decl.context, decl.variantContext, decl.tokenRef, facts.contentHash);
      } else {
        indexHandle.run(
          'INSERT INTO style_declarations (property, raw_value, normalized_value, mechanism, file_path, line, context, variant_context, token_ref, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [decl.property, decl.rawValue, decl.normalizedValue ? JSON.stringify(decl.normalizedValue) : null, decl.mechanism, decl.filePath, decl.line, decl.context, decl.variantContext, decl.tokenRef, facts.contentHash],
        );
      }
      if (decl.context) {
        for (const m of decl.context.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
          if (stmts) stmts.insClass.run(m[1], decl.filePath);
          else indexHandle.run('INSERT OR IGNORE INTO style_defined_classes (class_name, file_path) VALUES (?, ?)', [m[1], decl.filePath]);
        }
      }
    }

    // Insert class usage.
    for (const cu of facts.classUsage) {
      if (stmts) stmts.insUsage.run(cu.className, cu.filePath, cu.line, cu.mechanism, cu.unresolvable ? 1 : 0);
      else indexHandle.run(
        'INSERT INTO style_class_usage (class_name, file_path, line, mechanism, unresolvable) VALUES (?, ?, ?, ?, ?)',
        [cu.className, cu.filePath, cu.line, cu.mechanism, cu.unresolvable ? 1 : 0],
      );
    }
  };

  if (stmts) rawDb!.transaction(() => { for (const [fp, f] of entries) insertOne(fp, f); })();
  else for (const [fp, f] of entries) insertOne(fp, f);

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
          } | undefined;
          const stmts = rawDb
            ? {
                delDecl: rawDb.prepare('DELETE FROM style_declarations WHERE file_path = ?'),
                delTok: rawDb.prepare('DELETE FROM style_tokens WHERE file_path = ?'),
                delUsage: rawDb.prepare('DELETE FROM style_class_usage WHERE file_path = ?'),
                delClass: rawDb.prepare('DELETE FROM style_defined_classes WHERE file_path = ?'),
                insDecl: rawDb.prepare('INSERT INTO style_declarations (property, raw_value, normalized_value, mechanism, file_path, line, context, variant_context, token_ref, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
                insClass: rawDb.prepare('INSERT OR IGNORE INTO style_defined_classes (class_name, file_path) VALUES (?, ?)'),
                insTok: rawDb.prepare('INSERT INTO style_tokens (name, value, file_path, mechanism) VALUES (?, ?, ?, ?)'),
                insUsage: rawDb.prepare('INSERT INTO style_class_usage (class_name, file_path, line, mechanism, unresolvable) VALUES (?, ?, ?, ?, ?)'),
              }
            : null;

          const insertAll = (): void => {
            for (const [filePath, facts] of Object.entries(cssFacts)) {
              // Delete old entries for this file (replaces the styleIndexer path)
              if (stmts) {
                stmts.delDecl.run(filePath);
                stmts.delTok.run(filePath);
                stmts.delUsage.run(filePath);
                stmts.delClass.run(filePath);
              } else {
                indexHandle.run('DELETE FROM style_declarations WHERE file_path = ?', [filePath]);
                indexHandle.run('DELETE FROM style_tokens WHERE file_path = ?', [filePath]);
                indexHandle.run('DELETE FROM style_class_usage WHERE file_path = ?', [filePath]);
                indexHandle.run('DELETE FROM style_defined_classes WHERE file_path = ?', [filePath]);
              }

              // Compute content hash for the file
              const contentStr = JSON.stringify({ declarations: facts.declarations.length, tokens: facts.tokens.length, classUsage: facts.classUsage.length });
              const contentHash = createHash('sha256').update(contentStr).digest('hex').slice(0, 16);

              // Insert declarations
              for (const decl of facts.declarations) {
                if (stmts) {
                  stmts.insDecl.run(decl.property, decl.rawValue, JSON.stringify(decl.normalizedValue), decl.mechanism, decl.filePath, decl.line, decl.context, decl.variantContext, decl.tokenRef, contentHash);
                } else {
                  indexHandle.run(
                    'INSERT INTO style_declarations (property, raw_value, normalized_value, mechanism, file_path, line, context, variant_context, token_ref, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [decl.property, decl.rawValue, JSON.stringify(decl.normalizedValue), decl.mechanism, decl.filePath, decl.line, decl.context, decl.variantContext, decl.tokenRef, contentHash],
                  );
                }
                // Populate the defined-class catalog (Spec 45) from any class
                // selectors in the rule's context so styles/undefined-class can
                // resolve names via `style_defined_classes` instead of a
                // full-corpus regex scan over every declaration.
                if (decl.context) {
                  for (const m of decl.context.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
                    if (stmts) stmts.insClass.run(m[1], decl.filePath);
                    else indexHandle.run('INSERT OR IGNORE INTO style_defined_classes (class_name, file_path) VALUES (?, ?)', [m[1], decl.filePath]);
                  }
                }
              }

              // Insert tokens
              for (const tok of facts.tokens) {
                if (stmts) stmts.insTok.run(tok.name, tok.value, tok.filePath, tok.mechanism);
                else indexHandle.run(
                  'INSERT INTO style_tokens (name, value, file_path, mechanism) VALUES (?, ?, ?, ?)',
                  [tok.name, tok.value, tok.filePath, tok.mechanism],
                );
              }

              // Insert class usage
              for (const cu of facts.classUsage) {
                if (stmts) stmts.insUsage.run(cu.className, cu.filePath, cu.line, cu.mechanism, cu.unresolvable ? 1 : 0);
                else indexHandle.run(
                  'INSERT INTO style_class_usage (class_name, file_path, line, mechanism, unresolvable) VALUES (?, ?, ?, ?, ?)',
                  [cu.className, cu.filePath, cu.line, cu.mechanism, cu.unresolvable ? 1 : 0],
                );
              }
            }
          };
          if (rawDb) rawDb.transaction(insertAll)();
          else insertAll();
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
        return { violations: result.violations ?? [], facts: {}, factsConsumed };
      } catch {
        return { violations: [], facts: {} };
      }
    },
    defaultConfig: {},
    description: 'Detects style fragmentation, value drift, token bypass, and z-index sprawl',
    category: 'style',
  };
}

// ── Conventions reducer (stage 3) ────────────────────────────────────────────

/**
 * Conventions reducer — queries conventions table and flags deviations
 * (usage-pair, import-form, error-handling, export-shape, naming).
 * Uses analyzer.analyze([]) with rawDb injected.
 */
export function createConventionsReducer(): Stage3Reducer {
  return {
    name: 'conventions',
    stage: 'reducer',
    consumes: [],
    getRuleIds: () => getRuleIdsFor('conventions'),
    async reduce(_allFacts: Readonly<Record<string, unknown>>, context: ReducerContext) {
      if (!context.indexHandle) return { violations: [], facts: {} };
      try {
        const { UniversalConventionsAnalyzer } = await import(
          './analyzers/universal/UniversalConventionsAnalyzer.js'
        );
        const analyzer = new UniversalConventionsAnalyzer();

        // B2: Build exports map from function-index visitor facts (AST-extracted)
        const functionIndexFacts = _allFacts['function-index'] as
          Record<string, { exports?: Array<{ name: string; location?: { start: { line: number } }; isDefault: boolean }> }> | undefined;
        const exportsMap = functionIndexFacts
          ? new Map(
              Object.entries(functionIndexFacts)
                .filter(([, data]) => data?.exports?.length)
                .map(([filePath, data]) => [filePath, data!.exports!]),
            )
          : undefined;

        // Scoped/diff audits: thread the in-scope file set so the analyzer scopes
        // its function/file queries to only the changed files. `_infra.files` are
        // absolute; `functions.file_path` is also absolute (function-index visitor
        // stores `context.filePath`), so the IN clause matches directly.
        const scopedFiles = context.isScoped ? ((context.config as any).files as string[] ?? []) : undefined;
        const config = { ...context.config, indexHandle: context.indexHandle, projectRoot: context.projectRoot, readSource: context.readSource, exportsMap, scopedFiles, isScoped: context.isScoped };
        const result = await analyzer.analyze([], config);
        // Count the INPUT the conventions analyzer reads (the function index the
        // function-index visitor populated), not the derived `conventions` table it
        // writes. `conventions` is an output cache (mineAllConventions) that can be
        // empty when `minCorpus` is unmet even though thousands of functions fed the
        // analyzer — counting it as "facts consumed" misreports a present input as
        // notApplicable. (Spec 39 R2/R3 bug B)
        const factsConsumed = context.indexHandle.count('functions');
        return { violations: result.violations ?? [], facts: {}, factsConsumed };
      } catch {
        return { violations: [], facts: {} };
      }
    },
    defaultConfig: {},
    description: 'Mines codebase conventions and flags deviations',
    category: 'style',
  };
}

// ── Cross-Domain reducer (stage 4) ───────────────────────────────────────────

/**
 * Cross-domain reducer — runs written-never-read, read-never-written,
 * transaction-boundary risk, validation-bypass, and uncovered-risk detectors.
 * Uses analyzer.analyze([]) with rawDb injected.
 */
export function createCrossDomainReducer(): Stage4Reducer {
  return {
    name: 'cross-domain',
    stage: 'derivedReducer',
    consumes: [],
    getRuleIds: () => getRuleIdsFor('cross-domain'),
    async reduce(_allFacts: Readonly<Record<string, unknown>>, context: ReducerContext) {
      if (!context.indexHandle) return { violations: [], facts: {} };
      try {
        const { CrossDomainAnalyzer } = await import(
          './analyzers/crossDomain/CrossDomainAnalyzer.js'
        );
        const analyzer = new CrossDomainAnalyzer();
        // Thread the in-scope file set (absolute, from _infra.files) so detectors
        // anchor to changed files on diff audits; full audits keep the root-LIKE
        // scope (resolveFileScope falls back when isScoped is false).
        const scopedFiles = context.isScoped ? ((context.config as any).files as string[] ?? []) : undefined;
        const config = { ...context.config, indexHandle: context.indexHandle, projectRoot: context.projectRoot, scopedFiles, isScoped: context.isScoped };
        const result = await analyzer.analyze([], config);
        // Count DB rows consumed across primary cross-domain tables
        let factsConsumed = 0;
        try { factsConsumed += context.indexHandle.count('schema_usage'); } catch { /* table may not exist */ }
        // `indexed_functions` is not a real table — the function index lives in
        // `functions`. The old name made this term silently no-op (swallowed by the
        // catch), undercounting the input for read/write coverage detectors.
        // (Spec 39 R2/R3 bug C)
        try { factsConsumed += context.indexHandle.count('functions'); } catch { /* table may not exist */ }
        return { violations: result.violations ?? [], facts: {}, factsConsumed };
      } catch (e: any) {
        console.error('[cross-domain reducer] error:', e.message);
        return { violations: [], facts: {} };
      }
    },
    defaultConfig: {},
    description: 'Detects cross-domain issues (schema lifecycle, validation bypass, coverage gaps)',
    category: 'architecture',
  };
}

// ── Cross-language entity extraction + Stage-4 reducers ──────────────────────
//
// The three cross-language analyzers (SchemaValidator, APIContractAnalyzer,
// DependencyGraphBuilder) are corpus-wide: they compare schemas/endpoints/cycles
// across files and languages. They run as Stage-4 derived reducers over a single
// shared entity-extraction visitor, so each analyzer's rule IDs map to its own
// result row (coverage resolves by RULE_REGISTRY analyzer name — one reducer per
// analyzer, not one reducer fanning out to three names).
//
// Scope-awareness ("Stage 4, and measure the gate"): the corpus-wide graph/cycle
// work is only meaningful on a full audit. On a scoped/diff run each reducer
// short-circuits with `notRunReason` BEFORE any corpus-wide work — the gate is in
// the design, not retrofitted after the budget blows. This is the shape that made
// the styles reducer 587ms; it must never run over a partial corpus.

// ── Raw-node helpers (tree-sitter raw nodes are `any` here — strict is off) ──

function clRawField(raw: any, field: string): any {
  return typeof raw?.childForFieldName === 'function' ? raw.childForFieldName(field) : null;
}

function clRawNamedChild(raw: any, type: string): any {
  return raw?.namedChildren?.find((c: any) => c.type === type) ?? null;
}

/** A function body node — `statement_block` (TS/JS) or `block` (Go). */
function clRawBody(raw: any): any {
  return raw?.namedChildren?.find(
    (c: any) => c.type === 'statement_block' || c.type === 'block',
  ) ?? null;
}

function clSignatureText(raw: any, sourceCode: string): string {
  if (!raw) return '';
  const body = clRawBody(raw);
  const end = body ? body.startIndex : raw.endIndex;
  return sourceCode.slice(raw.startIndex, end).trim();
}

function clBodyText(raw: any, sourceCode: string): string {
  const body = clRawBody(raw);
  return body ? sourceCode.slice(body.startIndex, body.endIndex) : '';
}

/** Prefer the `name` field (works across TS + Go), fall back to identifier children. */
function clNodeName(raw: any): string | undefined {
  const field = clRawField(raw, 'name');
  if (field?.text) return field.text;
  const id = clRawNamedChild(raw, 'identifier') ?? clRawNamedChild(raw, 'property_identifier');
  return id?.text;
}

function clEntityId(filePath: string, type: string, name: string, line: number): string {
  return `${filePath}::${type}::${name}::${line}`;
}

function clIsExportedGo(name: string): boolean {
  return name.length > 0 && name[0] === name[0].toUpperCase();
}

/** Collect callee names from a function's body (TS `call_expression` / Go `call_expression`). */
function clCollectCallees(raw: any): string[] {
  const names = new Set<string>();
  const walk = (node: any): void => {
    if (!node) return;
    if (node.type === 'call_expression') {
      const fn = typeof node.childForFieldName === 'function'
        ? node.childForFieldName('function')
        : null;
      const callee = fn ?? node.namedChildren?.[0];
      const text = callee?.text?.trim();
      if (text && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(text)) {
        names.add(text);
      }
    }
    for (const child of node.namedChildren ?? []) walk(child);
  };
  walk(raw);
  return [...names];
}

function clMakeFunction(
  filePath: string,
  lang: string,
  name: string,
  line: number,
  signature: string,
  purpose: string,
  params: any[],
  callees: string[],
  exported: boolean,
  complexity: number,
  isMethod = false,
): CrossLanguageEntity {
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

interface ClFileInfo {
  imports: string[];
  hasExports: boolean;
}

/**
 * Collect a file's import specifiers and whether it declares any exports.
 *
 * Feeds file-level reachability: an `import_statement` (TS/JS) or
 * `import_declaration` (Go) records a dependency; an `export_statement`
 * (TS/JS) records that the file exposes symbols to importers. Go exports are
 * computed separately from the extracted entities (capitalized top-level
 * names), since Go has no `export` keyword.
 */
function clCollectFileInfo(root: any, lang: string): ClFileInfo {
  const imports = new Set<string>();
  let hasExports = false;
  walkAST(root, (node) => {
    const raw = (node as any).raw as any;
    if (node.type === 'import_statement') {
      const source = clRawField(raw, 'source');
      if (source?.text) imports.add(source.text.replace(/^['"]|['"]$/g, ''));
    } else if (node.type === 'import_declaration') {
      for (const spec of raw?.namedChildren ?? []) {
        if (spec.type === 'import_spec') {
          const p = clRawField(spec, 'path');
          if (p?.text) imports.add(p.text.replace(/^['"]|['"]$/g, ''));
        }
      }
    } else if (node.type === 'export_statement') {
      hasExports = true;
      // Re-exports (`export { x } from './y'`, `export * from './y'`) are import
      // edges for reachability: a barrel re-exporting a module marks it live,
      // not dead. The `source` field is present only on the `from` form.
      const source = clRawField(raw, 'source');
      if (source?.text) imports.add(source.text.replace(/^['"]|['"]$/g, ''));
    }
  });
  return { imports: [...imports], hasExports };
}

// ── TS/JS extraction ─────────────────────────────────────────────────────────

function clExtractTSParams(raw: any): any[] {
  const params: any[] = [];
  const formal = clRawNamedChild(raw, 'formal_parameters');
  for (const p of formal?.namedChildren ?? []) {
    if (p.type !== 'required_parameter' && p.type !== 'optional_parameter') continue;
    const name = clRawField(p, 'name')?.text ?? clRawNamedChild(p, 'identifier')?.text;
    if (!name) continue;
    const type = clRawField(p, 'type')?.text?.trim();
    params.push({ name, type, optional: p.type === 'optional_parameter', language: 'typescript' });
  }
  return params;
}

function clExtractTSInterfaceParams(raw: any): any[] {
  const params: any[] = [];
  const walk = (node: any): void => {
    if (!node) return;
    if (node.type === 'property_signature') {
      const name = clRawField(node, 'name')?.text ?? clRawNamedChild(node, 'property_identifier')?.text;
      if (!name) return;
      const type = clRawField(node, 'type')?.text?.trim();
      const optional = node.children?.some((c: any) => c.type === '?') ?? false;
      params.push({ name, type, optional, language: 'typescript' });
    }
    for (const child of node.namedChildren ?? []) walk(child);
  };
  walk(raw);
  return params;
}

function clExtractTSEntities(
  root: any,
  filePath: string,
  sourceCode: string,
  lang: string,
  out: CrossLanguageEntity[],
): void {
  walkAST(root, (node) => {
    const raw = (node as any).raw as any;

    if (node.type === 'function_declaration' || node.type === 'method_definition') {
      const name = clNodeName(raw);
      if (!name) return;
      let displayName = name;
      if (node.type === 'method_definition') {
        let p = raw?.parent;
        while (p) {
          if (p.type === 'class_declaration') {
            const cn = clNodeName(p);
            if (cn) displayName = `${cn}.${name}`;
            break;
          }
          p = p.parent;
        }
      }
      const line = (raw?.startPosition?.row ?? 0) + 1;
      out.push(clMakeFunction(
        filePath, lang, displayName, line,
        clSignatureText(raw, sourceCode) || raw?.text || '',
        clBodyText(raw, sourceCode),
        clExtractTSParams(raw),
        clCollectCallees(raw),
        isExported(node),
        calculateComplexity(node),
        node.type === 'method_definition',
      ));
      return;
    }

    if (node.type === 'variable_declarator') {
      const arrow = clRawNamedChild(raw, 'arrow_function');
      if (!arrow) return;
      const name = clRawNamedChild(raw, 'identifier')?.text;
      if (!name) return;
      const line = (raw?.startPosition?.row ?? 0) + 1;
      out.push(clMakeFunction(
        filePath, lang, name, line,
        clSignatureText(arrow, sourceCode) || arrow?.text || '',
        clBodyText(arrow, sourceCode),
        [],
        clCollectCallees(arrow),
        isExported(node),
        calculateComplexity(node),
      ));
      return;
    }

    if (node.type === 'interface_declaration') {
      const name = clNodeName(raw);
      if (!name) return;
      const line = (raw?.startPosition?.row ?? 0) + 1;
      out.push({
        id: clEntityId(filePath, 'interface', name, line),
        name,
        language: lang,
        file: filePath,
        type: 'interface',
        signature: raw?.text ?? '',
        parameters: clExtractTSInterfaceParams(raw),
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

function clGoReceiverType(receiver: any): string | undefined {
  for (const child of receiver?.namedChildren ?? []) {
    if (child.type === 'parameter_declaration') {
      const typeNode = clRawField(child, 'type');
      if (typeNode) return typeNode.text.replace(/^\*/, '');
    }
  }
  return undefined;
}

function clExtractGoParams(raw: any): any[] {
  const params: any[] = [];
  const paramList = clRawField(raw, 'parameters');
  for (const p of paramList?.namedChildren ?? []) {
    if (p.type !== 'parameter_declaration') continue;
    const name = clRawField(p, 'name')?.text ?? clRawField(p, 'type')?.text;
    const type = clRawField(p, 'type')?.text?.trim();
    if (!name && !type) continue;
    params.push({ name: name ?? type ?? '<unknown>', type, optional: false, language: 'go' });
  }
  return params;
}

function clExtractGoStructFields(structNode: any): any[] {
  const fields: any[] = [];
  for (const f of structNode?.namedChildren ?? []) {
    if (f.type !== 'field_declaration') continue;
    const name = clRawField(f, 'name')?.text;
    if (!name) continue;
    const type = clRawField(f, 'type')?.text?.trim();
    const tag = clRawField(f, 'tag')?.text;
    fields.push({ name, type, isExported: clIsExportedGo(name), tag });
  }
  return fields;
}

function clExtractGoEntities(
  root: any,
  filePath: string,
  sourceCode: string,
  out: CrossLanguageEntity[],
): void {
  walkAST(root, (node) => {
    const raw = (node as any).raw as any;

    if (node.type === 'function_declaration') {
      const name = clNodeName(raw);
      if (!name) return;
      const receiver = clRawField(raw, 'receiver');
      const receiverType = receiver ? clGoReceiverType(receiver) : undefined;
      const displayName = receiverType ? `${receiverType}.${name}` : name;
      const line = (raw?.startPosition?.row ?? 0) + 1;
      out.push(clMakeFunction(
        filePath, 'go', displayName, line,
        clSignatureText(raw, sourceCode) || raw?.text || '',
        clBodyText(raw, sourceCode),
        clExtractGoParams(raw),
        clCollectCallees(raw),
        clIsExportedGo(name),
        calculateComplexity(node),
      ));
      return;
    }

    if (node.type === 'type_declaration') {
      for (const spec of raw?.namedChildren ?? []) {
        if (spec.type !== 'type_spec') continue;
        const name = clRawField(spec, 'name')?.text;
        if (!name) continue;
        const typeNode = clRawField(spec, 'type');
        const line = (spec?.startPosition?.row ?? 0) + 1;
        if (typeNode?.type === 'struct_type') {
          out.push({
            id: clEntityId(filePath, 'struct', name, line),
            name,
            language: 'go',
            file: filePath,
            type: 'struct',
            signature: spec?.text ?? '',
            parameters: [],
            startLine: line,
            visibility: clIsExportedGo(name) ? 'public' : 'private',
            calls: [],
            calledBy: [],
            purpose: '',
            context: '',
            searchTokens: [name.toLowerCase()],
            metadata: { fields: clExtractGoStructFields(typeNode) },
          });
        } else if (typeNode?.type === 'interface_type') {
          out.push({
            id: clEntityId(filePath, 'interface', name, line),
            name,
            language: 'go',
            file: filePath,
            type: 'interface',
            signature: spec?.text ?? '',
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

export function createCrossLanguageEntityVisitor(): Stage2Visitor {
  return {
    name: 'cross-language-entities',
    stage: 'visitor',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.go'],
    getRuleIds: () => [],
    async visit(ast: unknown, _adapter: unknown, context: VisitorContext, sourceCode: string) {
      const filePath = context.filePath;
      if (!filePath) return { violations: [], facts: {} };
      const lang = getLanguageFromPath(filePath);
      if (lang === 'unknown') return { violations: [], facts: {} };

      const root = (ast as AST).root;
      const entities: CrossLanguageEntity[] = [];
      if (lang === 'go') {
        clExtractGoEntities(root, filePath, sourceCode, entities);
      } else {
        clExtractTSEntities(root, filePath, sourceCode, lang, entities);
      }

      const fileInfo = clCollectFileInfo(root, lang);
      // Go has no `export` keyword — an exported symbol is a capitalized
      // top-level name, which the entity extractor already records as public.
      const hasExports = lang === 'go'
        ? entities.some((e) => e.visibility === 'public')
        : fileInfo.hasExports;

      return {
        violations: [],
        facts: { [filePath]: { entities, imports: fileInfo.imports, hasExports } },
      };
    },
    defaultConfig: {},
    description: 'Extracts cross-language entities (functions, structs, interfaces) for the cross-language analyzers',
    category: 'infrastructure',
  };
}

// ── Shared flatten + reference building ──────────────────────────────────────

function clFlattenEntities(allFacts: Readonly<Record<string, unknown>>): CrossLanguageEntity[] {
  const facts = allFacts['cross-language-entities'] as
    | Record<string, { entities?: CrossLanguageEntity[] }>
    | undefined;
  if (!facts) return [];
  const entities: CrossLanguageEntity[] = [];
  for (const data of Object.values(facts)) {
    if (data?.entities) entities.push(...data.entities);
  }
  return entities;
}

/** Extract per-file `{ imports, hasExports }` from the cross-language facts. */
function clFileFacts(allFacts: Readonly<Record<string, unknown>>): Map<string, ClFileInfo> {
  const facts = allFacts['cross-language-entities'] as
    | Record<string, { entities?: CrossLanguageEntity[]; imports?: string[]; hasExports?: boolean }>
    | undefined;
  const map = new Map<string, ClFileInfo>();
  if (!facts) return map;
  for (const [filePath, data] of Object.entries(facts)) {
    if (!data) continue;
    map.set(filePath, { imports: data.imports ?? [], hasExports: data.hasExports ?? false });
  }
  return map;
}

function clIsTestFile(fp: string): boolean {
  const lower = fp.toLowerCase();
  return lower.includes('.test.') || lower.includes('.spec.') ||
    lower.includes('__tests__') || lower.includes('/test/') || lower.includes('/tests/') ||
    lower.endsWith('_test.go');
}

// Files the framework loads directly rather than via an import from sibling
// code. Skipped when flagging unreferenced modules — a route/page/entry file
// that nothing imports is an entry point, not dead code.
const CL_ENTRY_BASENAMES = new Set([
  'route', 'page', 'layout', 'loading', 'error', 'not-found', 'template', 'default',
  'middleware', 'instrumentation', 'server', 'client', 'cli', 'main', 'app', 'index', 'worker',
  'setup', 'seed',
]);

function clIsEntryPointFile(fp: string): boolean {
  const segments = fp.replace(/\\/g, '/').split('/').filter(Boolean);
  const base = segments[segments.length - 1] ?? '';
  const stem = base.replace(/\.[^.]+$/, '');
  if (CL_ENTRY_BASENAMES.has(stem)) return true;
  if (stem.endsWith('.config')) return true; // next.config, vite.config, tailwind.config, …
  const joined = '/' + segments.join('/') + '/';
  if (joined.includes('/app/api/') || joined.includes('/pages/api/')) return true;
  if (joined.includes('/scripts/') || joined.includes('/bin/') || joined.includes('/cmd/')) return true;
  return false;
}

/**
 * Compute file-level reachability from per-file imports.
 *
 * A file is a framework entry point (live → 1.0), imported by another file
 * (live → 0.5), or referenced by nothing (dead → 0.0). The resolver mirrors
 * importGraph.ts and handles relative paths, npm/alias basenames, and fuzzy
 * path-segment matches.
 */
function clComputeReachability(
  fileFacts: Map<string, ClFileInfo>,
): { reachability: Map<string, number>; importersOf: Map<string, Set<string>> } {
  const filePaths = new Set(fileFacts.keys());
  const moduleToFile = new Map<string, Set<string>>();
  for (const fp of filePaths) {
    const bn = basenameNoExt(fp);
    if (!moduleToFile.has(bn)) moduleToFile.set(bn, new Set());
    moduleToFile.get(bn)!.add(fp);
  }

  const importersOf = new Map<string, Set<string>>();
  for (const [fp, info] of fileFacts) {
    for (const dep of info.imports) {
      const targets = resolveDependency(dep, filePaths, moduleToFile, fp);
      for (const t of targets) {
        if (t === fp) continue;
        if (!importersOf.has(t)) importersOf.set(t, new Set());
        importersOf.get(t)!.add(fp);
      }
    }
  }

  const reachability = new Map<string, number>();
  for (const fp of filePaths) {
    const entry = clIsEntryPointFile(fp);
    const imported = (importersOf.get(fp)?.size ?? 0) > 0;
    reachability.set(fp, entry ? 1 : imported ? 0.5 : 0);
  }
  return { reachability, importersOf };
}

/**
 * Build `calls` cross-references by resolving each entity's extracted callee
 * names against the corpus entity name index. Library calls (fetch, map, …)
 * resolve to nothing and are dropped — only real intra-corpus call edges become
 * references.
 */
function clBuildReferences(entities: CrossLanguageEntity[]): CrossReference[] {
  const byName = new Map<string, CrossLanguageEntity[]>();
  for (const e of entities) {
    const key = e.name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(e);
    byName.set(key, list);
  }

  const refs: CrossReference[] = [];
  for (const e of entities) {
    const callees = (e.metadata?.callees as string[] | undefined) ?? [];
    const eDir = e.file.split('/').slice(0, -1).join('/');
    for (const callee of callees) {
      const name = (callee.split('.').pop() ?? callee).toLowerCase();
      const others = (byName.get(name) ?? []).filter((t) => t.id !== e.id);
      if (others.length === 0) continue;

      // A bare call-expression name (`log`) can collide with many entities
      // across the corpus. Resolving it to *every* entity of that name
      // fabricates a dense graph (125k edges / 5.9k false cycles on a ~7.8k
      // node corpus) that corrupts cycle/hub/coupling detection. Narrow the
      // resolution to an unambiguous match — same file, then same directory,
      // then a unique global match — and drop the edge when the name is still
      // ambiguous: a missing edge is safer than a fabricated one for
      // structural analysis.
      const sameFile = others.filter((t) => t.file === e.file);
      const sameDir = sameFile.length === 0
        ? others.filter((t) => t.file.split('/').slice(0, -1).join('/') === eDir)
        : [];
      const uniqueGlobal = others.length === 1 ? others : [];

      const chosen = sameFile.length === 1
        ? sameFile
        : sameDir.length === 1
          ? sameDir
          : uniqueGlobal;

      for (const t of chosen) {
        refs.push({
          sourceId: e.id,
          targetId: t.id,
          type: 'calls',
          sourceLanguage: e.language,
          targetLanguage: t.language,
          confidence: 0.7,
        });
      }
    }
  }
  return refs;
}

// ── schema-validator reducer (Stage 4) ───────────────────────────────────────

export function createSchemaValidatorReducer(): Stage4Reducer {
  return {
    name: 'schema-validator',
    stage: 'derivedReducer',
    consumes: ['cross-language-entities'],
    getRuleIds: () => getRuleIdsFor('schema-validator'),
    async reduce(allFacts, context) {
      if (context.isScoped) {
        return {
          violations: [],
          facts: {},
          notRunReason: 'schema-validator requires a full-corpus audit (cross-language schema comparison is unavailable on scoped/diff runs)',
        };
      }
      const entities = clFlattenEntities(allFacts);
      if (entities.length === 0) return { violations: [], facts: {}, factsConsumed: 0 };
      try {
        const { SchemaValidator, extractSchemas, countCrossLanguagePairs } = await import(
          './analyzers/cross-language/SchemaValidator.js'
        );
        const schemas = extractSchemas(entities);
        // A zero here would otherwise surface as `clean` in coverage — which
        // reads as "compared everything and found no mismatch" when the truth
        // is "there is nothing to compare". Distinguish the two: no schemas at
        // all, or schemas all in one language, is `notApplicable`, not `clean`.
        if (schemas.length === 0) {
          return { violations: [], facts: {}, notRunReason: 'no schema definitions found (no interfaces/structs to compare)' };
        }
        if (countCrossLanguagePairs(schemas) === 0) {
          return { violations: [], facts: {}, notRunReason: 'no cross-language pairs found (schema comparison requires ≥2 languages)' };
        }
        const validator = new SchemaValidator();
        const violations = await validator.validateSchemas(schemas);
        return { violations, facts: {}, factsConsumed: schemas.length };
      } catch (e: any) {
        console.error('[schema-validator reducer] error:', e.message);
        return { violations: [], facts: {}, factsConsumed: 0 };
      }
    },
    defaultConfig: {},
    description: 'Validates schema consistency across language boundaries (TS interfaces vs Go structs)',
    category: 'cross-language',
  };
}

// ── api-contract reducer (Stage 4) ───────────────────────────────────────────

export function createAPIContractReducer(): Stage4Reducer {
  return {
    name: 'api-contract',
    stage: 'derivedReducer',
    consumes: ['cross-language-entities'],
    getRuleIds: () => getRuleIdsFor('api-contract'),
    async reduce(allFacts, context) {
      if (context.isScoped) {
        return {
          violations: [],
          facts: {},
          notRunReason: 'api-contract requires a full-corpus audit (cross-language API comparison is unavailable on scoped/diff runs)',
        };
      }
      const entities = clFlattenEntities(allFacts);
      if (entities.length === 0) return { violations: [], facts: {}, factsConsumed: 0 };
      try {
        const { APIContractAnalyzer, extractEndpoints, extractAPICalls } = await import(
          './analyzers/cross-language/APIContractAnalyzer.js'
        );
        const endpoints = extractEndpoints(entities);
        const calls = extractAPICalls(entities);
        const analyzer = new APIContractAnalyzer();
        const violations = await analyzer.analyzeContracts(endpoints, calls);
        return { violations, facts: {}, factsConsumed: endpoints.length + calls.length };
      } catch (e: any) {
        console.error('[api-contract reducer] error:', e.message);
        return { violations: [], facts: {}, factsConsumed: 0 };
      }
    },
    defaultConfig: {},
    description: 'Validates API contracts between frontend calls and backend endpoints across languages',
    category: 'cross-language',
  };
}

// ── dependency-graph reducer (Stage 4) ───────────────────────────────────────

export function createDependencyGraphReducer(): Stage4Reducer {
  return {
    name: 'dependency-graph',
    stage: 'derivedReducer',
    consumes: ['cross-language-entities'],
    getRuleIds: () => getRuleIdsFor('dependency-graph'),
    async reduce(allFacts, context) {
      if (context.isScoped) {
        return {
          violations: [],
          facts: {},
          notRunReason: 'dependency-graph requires a full-corpus audit (cycle/SCC/hub/orphan detection is unavailable on scoped/diff runs)',
        };
      }
      const entities = clFlattenEntities(allFacts);
      if (entities.length === 0) return { violations: [], facts: {}, factsConsumed: 0 };
      try {
        const { DependencyGraphBuilder } = await import(
          './analyzers/cross-language/DependencyGraphBuilder.js'
        );
        const builder = new DependencyGraphBuilder({ includeTestFiles: false });
        const references = clBuildReferences(entities);
        const graph = await builder.buildGraph(entities, references);
        const health = await builder.analyzeDependencyHealth(graph);
        const idToEntity = new Map(entities.map((e) => [e.id, e] as const));
        const violations: Violation[] = [];
        for (const issue of health.issues) {
          if (issue.type === 'orphaned-nodes') {
            // Emit one violation per orphan so each is attributed to its own
            // file/line. The aggregated form anchored every orphan to the first
            // node's location while the message listed all of them — foreign
            // symbols leaked into the wrong file.
            for (const id of issue.affectedNodes) {
              const orphan = idToEntity.get(id);
              if (!orphan) continue;
              violations.push({
                file: orphan.file,
                line: orphan.startLine,
                severity: issue.severity,
                message: `Orphaned node "${orphan.name}" has no connections.`,
                rule: issue.type,
                type: issue.type, // dependency-graph rules match on field: 'type'
                analyzer: 'dependency-graph',
                category: 'cross-language-dependency',
                functionName: orphan.name,
                details: { orphanId: id },
              } as Violation);
            }
            continue;
          }
          const anchor = issue.affectedNodes.map((id) => idToEntity.get(id)).find(Boolean);
          violations.push({
            file: anchor?.file ?? '(unknown)',
            line: anchor?.startLine ?? 0,
            severity: issue.severity,
            message: issue.description,
            rule: issue.type,
            type: issue.type, // dependency-graph rules match on field: 'type'
            analyzer: 'dependency-graph',
            category: 'cross-language-dependency',
            details: issue.details,
          } as Violation);
        }

        // ── File-level reachability: unreferenced modules + ranking axis ──
        const fileFacts = clFileFacts(allFacts);
        if (fileFacts.size > 0) {
          const { reachability, importersOf } = clComputeReachability(fileFacts);

          // Persist reachability to graph_cache so the post-pipeline reorder
          // (auditRunner hotspot block) can rank every finding by live/dead.
          if (context.indexHandle?.rawDb) {
            try {
              const db = context.indexHandle.rawDb as any;
              const del = db.prepare("DELETE FROM graph_cache WHERE graph_type = 'reachability'");
              const ins = db.prepare(
                "INSERT OR REPLACE INTO graph_cache (graph_type, node_key, neighbor_key, weight) VALUES ('reachability', ?, '', ?)"
              );
              const tx = db.transaction(() => {
                del.run();
                for (const [fp, score] of reachability) {
                  ins.run(fp, score);
                }
              });
              tx();
            } catch {
              // Reachability persistence is advisory — ranking falls back to a
              // neutral default without it.
            }
          }

          // Flag files that export symbols yet are imported by nothing and are
          // not framework entry points — a dead module. This is the signal the
          // orphaned-nodes check missed: a whole unreferenced file whose every
          // internal symbol still forms a connected component.
          for (const [fp, info] of fileFacts) {
            if (!info.hasExports) continue;
            if (clIsTestFile(fp)) continue;
            if (clIsEntryPointFile(fp)) continue;
            if ((importersOf.get(fp)?.size ?? 0) > 0) continue;
            violations.push({
              file: fp,
              line: 1,
              // Promoted suggestion → warning (Spec 11 R5, one tier). The
              // method-dispatch fix removed the class-prefixed / isMethod false
              // positives, so a module that exports and is imported by nothing
              // is a genuine dead-module signal — a defect that should block,
              // not a suggestion to weigh. Validated across four corpora.
              severity: 'warning',
              message: 'Module is not imported by any other file and is not a framework entry point — dead code candidate.',
              rule: 'unreferenced-module',
              type: 'unreferenced-module',
              analyzer: 'dependency-graph',
              category: 'cross-language-dependency',
              details: { imports: info.imports },
            } as Violation);
          }
        }

        for (const s of health.suggestions) {
          violations.push({
            file: '(multiple)',
            line: 0,
            severity: s.priority === 'low' ? 'suggestion' : 'warning',
            message: s.description,
            rule: s.type,
            type: s.type,
            analyzer: 'dependency-graph',
            category: 'cross-language-dependency',
            details: s.affectedNodes ? { affectedNodes: s.affectedNodes } : undefined,
          } as Violation);
        }
        return { violations, facts: {}, factsConsumed: entities.length };
      } catch (e: any) {
        console.error('[dependency-graph reducer] error:', e.message);
        return { violations: [], facts: {}, factsConsumed: 0 };
      }
    },
    defaultConfig: {},
    description: 'Builds a cross-language dependency graph and detects cycles, hubs, orphans, and tight coupling',
    category: 'cross-language',
  };
}

// ── Invariants reducer (stage 3) ──────────────────────────────────────────────

/**
 * Invariants reducer — enforces user-defined invariant rules from .codeauditor.json.
 * Receives the full file list via context.files and runs the rule engine across
 * all files at once (call-constraint rules inherently need cross-file scope).
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

/**
 * Schema SQL visitor (.sql files) — extracts ordered DDL operations for the
 * Stage 3 reducer to replay into the known-tables catalog. Emits the parsed
 * ops, not raw source, so the reducer retains only state transitions.
 */
export function createSchemaSqlVisitor(): Stage2Visitor {
  const getMigrationExtractor = lazySingleton(() =>
    import('./analyzers/universal/UniversalSchemaAnalyzer.js'),
  );

  return {
    name: 'schema-sql',
    stage: 'visitor',
    extensions: ['.sql'],
    getRuleIds: () => [],
    async visit(_ast: unknown, _adapter: unknown, context: VisitorContext, sourceCode: string) {
      const { extractMigrationOpsFromFile } = await getMigrationExtractor();
      const { ops, columns, skipped, bytes } = await extractMigrationOpsFromFile(context.filePath, sourceCode);
      return {
        violations: [],
        facts: {
          [context.filePath]: {
            ddlOps: ops,
            ...(columns.length > 0 && { ddlColumns: columns }),
            ...(skipped && { skipped: true, bytes }),
          },
        },
      };
    },
    defaultConfig: {},
    description: 'Extracts SQL DDL operations for known-table catalog',
    category: 'database',
  };
}

/**
 * Schema code visitor (.ts/.tsx/.js/.jsx) — per-file analysis for naming conventions,
 * query patterns, SQL injection, table references, and ORM table extraction.
 */
export function createSchemaCodeVisitor(): Stage2Visitor {
  const getAnalyzer = lazySingleton<any>(() =>
    import('./analyzers/universal/UniversalSchemaAnalyzer.js').then((m) => ({
      analyzer: new m.UniversalSchemaAnalyzer(),
      defaults: m.DEFAULT_SCHEMA_CONFIG,
      parseMigrationOps: m.parseMigrationOps,
      extractDdlColumnNames: m.extractDdlColumnNames,
    })),
  );

  return {
    name: 'schema-code',
    stage: 'visitor',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
    getRuleIds: () => getRuleIdsFor('schema'),
    async visit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string) {
      const { analyzer: a, defaults, parseMigrationOps, extractDdlColumnNames } = await getAnalyzer();
      const pm = await _getProvenanceModule();
      const violations: Violation[] = [];
      const indexFacts: IndexFactsEntry[] = [];

      // Pipeline config for this analyzer (moved before table extraction, needed
      // by the table-source registry and provenance context).
      const schemaConfig = (context.config ?? {}) as Record<string, unknown>;

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
      const doDDLColumns = doDDLSql ? extractDdlColumnNames(doDDLSql) : [];

      // Build provenance context for this file — defaults from DEFAULT_SCHEMA_CONFIG
      const detectionMode = ((schemaConfig.detection as any)?.mode as string) ?? ('hybrid' as any);
      const provenanceContext = pm.buildProvenanceContext(ast as AST, adapter as LanguageAdapter, sourceCode, {
        mode: detectionMode,
        dbReceiverNames: (schemaConfig.dbReceiverNames as string[]) ?? defaults.dbReceiverNames,
        dbBindingNames: (schemaConfig.dbBindingNames as string[]) ?? defaults.dbBindingNames,
        dbCallMethods: (schemaConfig.dbCallMethods as string[]) ?? defaults.dbCallMethods,
        dbWrapperNames: (schemaConfig.dbWrapperNames as string[]) ?? defaults.dbWrapperNames,
      });

      // File gate — skip files without DB usage
      if (!passesFileGate(context.filePath, sourceCode, schemaConfig, provenanceContext)) {
        const facts: Record<string, unknown> = { [context.filePath]: { tableRefs: [], ormTables, tableProvenance: tableProvenances } };
        if (doDDL.length > 0) {
          (facts[context.filePath] as any).ddlOps = parseMigrationOps(doDDLSql!);
          if (doDDLColumns.length > 0) (facts[context.filePath] as any).ddlColumns = doDDLColumns;
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

      // Find table references (per-file, uses allTables for short-id false-positive filtering)
      const tableRefs = findTableReferences(ast as AST, adapter as LanguageAdapter, sourceCode, { config: schemaConfig, provenanceContext, allTables });

      // Record schema usage → emit as indexFacts via the shared instance
      a.recordTableUsage(ast as AST, adapter as LanguageAdapter, context.filePath, tableRefs);
      const pending = a.getPendingSchemaRecords();

      // Emit clear-by-file + per-usage index facts
      if (pending.clearFiles.length > 0) {
        for (const filePath of pending.clearFiles) {
          indexFacts.push({ table: 'schema_usage', data: { _action: 'clear-by-file', file_path: filePath } });
        }
      }
      for (const usage of pending.usages) {
        indexFacts.push({
          table: 'schema_usage',
          data: {
            file_path: usage.filePath,
            table_name: usage.tableName,
            function_name: usage.functionName,
            usage_type: usage.usageType,
            line: usage.line,
            column: usage.column,
            raw_query: usage.rawQuery,
          },
        });
      }

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

      // Emit facts for the Stage 3 reducer
      const fileFacts: Record<string, unknown> = {
        tableRefs: tableRefs.map((r: { table: string; type: string; location: { line: number; column: number }; context: string }) => ({
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
        (fileFacts as any).ddlOps = parseMigrationOps(doDDLSql!);
        if (doDDLColumns.length > 0) (fileFacts as any).ddlColumns = doDDLColumns;
      }

      return {
        violations,
        facts: { [context.filePath]: fileFacts },
        indexFacts: indexFacts.length > 0 ? indexFacts : undefined,
      };
    },
    defaultConfig: {},
    description: 'Per-file schema analysis: naming conventions, query patterns, SQL injection, table references',
    category: 'database',
  };
}

/**
 * Schema Prisma visitor (.prisma files) — extracts model names for known-table catalog.
 */
export function createSchemaPrismaVisitor(): Stage2Visitor {
  return {
    name: 'schema-prisma',
    stage: 'visitor',
    extensions: ['.prisma'],
    getRuleIds: () => [],
    async visit(_ast: unknown, _adapter: unknown, context: VisitorContext, sourceCode: string) {
      const models: string[] = [];
      const modelRe = /model\s+(\w+)\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = modelRe.exec(sourceCode)) !== null) {
        const modelName = m[1];
        // Scope @@map to this model's block by matching braces.
        // Depth starts at 1 for the opening { already consumed by the regex.
        const blockStart = m.index + m[0].length;
        let depth = 1;
        let blockEnd = blockStart;
        for (; blockEnd < sourceCode.length && depth > 0; blockEnd++) {
          if (sourceCode[blockEnd] === '{') depth++;
          else if (sourceCode[blockEnd] === '}') depth--;
        }
        const blockContent = sourceCode.slice(blockStart, blockEnd - 1);
        // @@map (block-level, double @) renames the table. @map (single @)
        // is field-level — column rename — and must not be treated as a table name.
        const mapMatch = blockContent.match(/@@map\s*\(\s*"([^"]+)"\s*\)/);
        models.push(mapMatch ? mapMatch[1] : modelName);
      }
      return {
        violations: [],
        facts: { [context.filePath]: { prismaModels: models } },
      };
    },
    defaultConfig: {},
    description: 'Extracts Prisma model names for known-table catalog',
    category: 'database',
  };
}

/**
 * Schema JSON visitor (.json files) — parses JSON for the Stage 3 reducer to validate.
 */
export function createSchemaJsonVisitor(): Stage2Visitor {
  return {
    name: 'schema-json',
    stage: 'visitor',
    extensions: ['.json'],
    getRuleIds: () => [],
    async visit(_ast: unknown, _adapter: unknown, context: VisitorContext, _sourceCode: string) {
      // Emit only a lightweight marker — the Stage 3 reducer reads and parses
      // each JSON file on demand via context.readSource, so parsed objects are
      // transient rather than retained in allFacts through stage 4.
      return {
        violations: [],
        facts: { [context.filePath]: { isJson: true } },
      };
    },
    defaultConfig: {},
    description: 'Parses JSON files for schema validation',
    category: 'database',
  };
}

/**
 * Schema Stage 3 reducer — cross-file unknown-table detection and JSON schema validation.
 *
 * Consumes facts from schema-sql, schema-code, schema-prisma, and schema-json visitors.
 * Builds the complete known-tables catalog and checks all table references against it.
 */
export function createSchemaReducer(): Stage3Reducer {
  const getAnalyzer = lazySingleton<any>(() =>
    import('./analyzers/universal/UniversalSchemaAnalyzer.js').then((m) => ({
      analyzer: new m.UniversalSchemaAnalyzer(),
      defaults: m.DEFAULT_SCHEMA_CONFIG,
      analyzeJsonSchemas: m.analyzeJsonSchemas,
    })),
  );

  return {
    name: 'schema',
    stage: 'reducer',
    consumes: [],
    getRuleIds: () => getRuleIdsFor('schema'),
    async reduce(allFacts: Readonly<Record<string, unknown>>, context: ReducerContext) {
      const { analyzer: a, analyzeJsonSchemas } = await getAnalyzer();
      const violations: Violation[] = [];
      const schemaConfig = (context.config ?? {}) as Record<string, unknown>;

      // allFacts is keyed by visitor name, each value is { [filePath]: { ...per-file facts } }
      // Flatten to per-file iteration helpers.
      const perFile = function* (): Generator<[string, Record<string, unknown>]> {
        for (const [, visitorFacts] of Object.entries(allFacts)) {
          if (typeof visitorFacts === 'object' && visitorFacts !== null) {
            for (const [filePath, fact] of Object.entries(visitorFacts as Record<string, unknown>)) {
              if (typeof fact === 'object' && fact !== null) {
                yield [filePath, fact as Record<string, unknown>];
              }
            }
          }
        }
      };

      // ── 1. Build known-tables catalog ──────────────────────────────────────

      const knownTables = new Set<string>();
      const tableProvenances = new Map<string, any[]>(); // table name → origins

      // 1a. SQL DDL replay — collect all DDL facts, sort by numeric prefix, replay
      const sqlFiles: Array<{ filePath: string; ops: MigrationOp[] }> = [];
      for (const [filePath, fact] of perFile()) {
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
      }

      // 1b. ORM tables from code files — with provenance from the table-source registry
      for (const [filePath, fact] of perFile()) {
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
      for (const [filePath, fact] of perFile()) {
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
      const ddlColumns = new Set<string>();
      for (const [filePath, fact] of perFile()) {
        const cols: string[] = (fact as any).ddlColumns ?? [];
        for (const c of cols) ddlColumns.add(String(c).toLowerCase());
      }

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
        for (const [filePath, fact] of perFile()) {
          const refs: any[] = (fact as any).tableRefs ?? [];
          for (const ref of refs) {
            allTableRefs.push({ file: filePath, ...ref });
          }
        }

        // 10:1 fail-open ratio guard
        const unknownRefs = allTableRefs.filter(ref => !knownTables.has(ref.table));
        if (unknownRefs.length / Math.max(knownTables.size, 1) <= 10) {
          for (const ref of unknownRefs) {
            const suggestions = getNearestTableSuggestions(ref.table, knownTables, 2);
            const msg = suggestions.length > 0
              ? `Reference to unknown table '${ref.table}' (${ref.type}). Did you mean: ${suggestions.join(', ')}?`
              : `Reference to unknown table '${ref.table}' (${ref.type})`;
            const suggestionNames = suggestions.map((s) => s.replace(/^'|'$/g, ''));
            violations.push({
              file: ref.file,
              line: ref.line,
              column: ref.column,
              severity: 'suggestion' as const,
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

      // ── 3. JSON schema validation ──────────────────────────────────────────

      if (schemaConfig.validateJsonSchemas !== false) {
        try {
          // Collect JSON file paths from the lightweight visitor markers, then
          // parse each on demand so parsed objects never survive past this loop.
          const jsonFiles: string[] = [];
          for (const [filePath, fact] of perFile()) {
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

      // ── 4. Build table catalog for metadata ───────────────────────────────

      const catalogEntries: Array<{ table: string; sources: any[] }> = [];
      for (const [table, sources] of tableProvenances) {
        catalogEntries.push({ table, sources });
      }

      return {
        violations,
        facts: { tableCatalog: catalogEntries, ddlColumns: [...ddlColumns].sort() },
        factsConsumed: [...perFile()].length,
      };
    },
    defaultConfig: {},
    description: 'Cross-file schema analysis: unknown-table detection and JSON schema validation',
    category: 'database',
  };
}
