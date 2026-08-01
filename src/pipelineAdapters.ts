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
import { RULE_REGISTRY } from './analyzers/ruleRegistry.js';
import type {
  IndexFactsEntry,
  Stage2Visitor,
  Stage3Reducer,
  Stage4Reducer,
  Violation,
  VisitorContext,
  ReducerContext,
} from './types.js';
import type { AST, LanguageAdapter } from './languages/types.js';
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
import {
  isReactComponent,
  detectComponentType,
  getComponentName,
} from './utils/reactDetection.js';
import { ALL_EXTENSIONS } from './utils/fileDiscovery.js';

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

// ── File-sources infrastructure visitor ──────────────────────────────────────

/**
 * Infrastructure visitor that records every file's source code so Stage 3
 * reducers can access it without calling readFileSync(). Always registered;
 * declares all known extensions so it covers both parsed and raw tuples.
 */
export function createFileSourcesVisitor(): Stage2Visitor {
  return {
    name: 'file-sources',
    stage: 'visitor',
    extensions: ALL_EXTENSIONS,
    getRuleIds: () => [],
    async visit(_ast: unknown, _adapter: unknown, context: VisitorContext, sourceCode: string) {
      return {
        violations: [],
        facts: { [context.filePath]: sourceCode },
      };
    },
    defaultConfig: {},
    description: 'Records every file source for Stage 3 reducers (infrastructure)',
    category: 'infrastructure',
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

// ── Function-Index visitor (infrastructure) ──────────────────────────────────
// Always-on Stage 2 visitor that populates the `functions` table with
// per-file definitions so the conventions and cross-domain reducers have data
// to mine — even on a cold run with no prior `index sync`.
// The function_calls table is rebuilt post-pipeline after functions rows have
// their auto-increment IDs assigned.

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
      return 'javascript';
    default:
      return 'unknown';
  }
}

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

      return { violations: [], facts: {}, indexFacts };
    },
    defaultConfig: {},
    description: 'Indexes function definitions for conventions and cross-domain analysis',
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
        } = await import('./analyzers/reactAnalyzer.js');

        // Build component tree and check for circular dependencies
        const { buildComponentTree } = await import('./componentScanner.js');
        const tree = buildComponentTree(scanResults);
        violations.push(...checkCircularDependencies(tree));

        // Check for missing error boundaries
        if (config.requireErrorBoundaries !== false) {
          violations.push(...checkErrorBoundaryUsage(scanResults));
        }

        // Check for raw element usage (Spec 10 R4)
        if (config.rawElementCheck !== false) {
          violations.push(...checkRawElements(scanResults, config));
        }
      } catch {
        // Cross-component checks are advisory
      }
      return violations;
    },
  };
}

// ── Styles reducer (stage 3) ─────────────────────────────────────────────────

/**
 * Styles reducer — runs all style detectors on existing style_* tables.
 * Uses the analyzer.analyze([]) pattern: passes an empty file list so the
 * analyzer skips file iteration and only queries the DB.
 */
export function createStylesReducer(): Stage3Reducer {
  return {
    name: 'styles',
    stage: 'reducer',
    consumes: [],
    getRuleIds: () => getRuleIdsFor('styles'),
    async reduce(_allFacts: Readonly<Record<string, unknown>>, context: ReducerContext) {
      if (!context.indexHandle) return { violations: [], facts: {} };
      try {
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
        // Extract per-file source map from the file-sources infrastructure visitor
        const fileSources = _allFacts['file-sources'] as Record<string, string> | undefined;
        const sourceMap: Map<string, string> | undefined = fileSources
          ? new Map(Object.entries(fileSources))
          : undefined;
        const config = { ...context.config, indexHandle: context.indexHandle, projectRoot: context.projectRoot, sourceMap };
        const result = await analyzer.analyze([], config);
        const factsConsumed = context.indexHandle.count('conventions');
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
        const config = { ...context.config, indexHandle: context.indexHandle, projectRoot: context.projectRoot };
        const result = await analyzer.analyze([], config);
        // Count DB rows consumed across primary cross-domain tables
        let factsConsumed = 0;
        try { factsConsumed += context.indexHandle.count('schema_usage'); } catch { /* table may not exist */ }
        try { factsConsumed += context.indexHandle.count('indexed_functions'); } catch { /* table may not exist */ }
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
        const { analyzeInvariants } = await import(
          './analyzers/invariantsAnalyzer.js'
        );
        // Full file list is in _infra.files (merged into context.config via pipeline)
        const files = (context.config as any).files as string[] ?? [];
        // Extract per-file source map from the file-sources infrastructure visitor
        const fileSources = _allFacts['file-sources'] as Record<string, string> | undefined;
        const sourceMap: Map<string, string> | undefined = fileSources
          ? new Map(Object.entries(fileSources))
          : undefined;
        const knownFiles: Set<string> | undefined = sourceMap
          ? new Set(sourceMap.keys())
          : undefined;
        const result = await analyzeInvariants(
          files,
          { ...context.config, sourceMap, knownFiles },
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
 * Schema SQL visitor (.sql files) — extracts raw DDL source for the Stage 3
 * reducer to replay into the known-tables catalog.
 */
export function createSchemaSqlVisitor(): Stage2Visitor {
  return {
    name: 'schema-sql',
    stage: 'visitor',
    extensions: ['.sql'],
    getRuleIds: () => [],
    async visit(_ast: unknown, _adapter: unknown, context: VisitorContext, sourceCode: string) {
      return {
        violations: [],
        facts: { [context.filePath]: { ddlSource: sourceCode } },
      };
    },
    defaultConfig: {},
    description: 'Captures SQL DDL source for known-table catalog',
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
    })),
  );

  return {
    name: 'schema-code',
    stage: 'visitor',
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    getRuleIds: () => getRuleIdsFor('schema'),
    async visit(ast: unknown, adapter: unknown, context: VisitorContext, sourceCode: string) {
      const { analyzer: a, defaults } = await getAnalyzer();
      const pm = await _getProvenanceModule();
      const violations: Violation[] = [];
      const indexFacts: IndexFactsEntry[] = [];

      // Extract ORM table names (Drizzle) from source
      const ormTables: string[] = [];
      const drizzleRe = /(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([^'"]+)['"]/g;
      let dm: RegExpExecArray | null;
      while ((dm = drizzleRe.exec(sourceCode)) !== null) {
        ormTables.push(dm[1]);
      }

      // Build provenance context for this file — defaults from DEFAULT_SCHEMA_CONFIG
      const schemaConfig = (context.config ?? {}) as Record<string, unknown>;
      const detectionMode = ((schemaConfig.detection as any)?.mode as string) ?? ('hybrid' as any);
      const provenanceContext = pm.buildProvenanceContext(ast as AST, adapter as LanguageAdapter, sourceCode, {
        mode: detectionMode,
        dbReceiverNames: (schemaConfig.dbReceiverNames as string[]) ?? defaults.dbReceiverNames,
        dbBindingNames: (schemaConfig.dbBindingNames as string[]) ?? defaults.dbBindingNames,
        dbCallMethods: (schemaConfig.dbCallMethods as string[]) ?? defaults.dbCallMethods,
      });

      // File gate — skip files without DB usage
      if (!a.passesFileGate(context.filePath, sourceCode, schemaConfig, provenanceContext)) {
        return {
          violations: [],
          facts: { [context.filePath]: { tableRefs: [], ormTables } },
        };
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
      const tableRefs = a.findTableReferences(ast as AST, adapter as LanguageAdapter, sourceCode, schemaConfig, provenanceContext, allTables);

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
        violations.push(...a.checkNamingConventions(tableRefs, context.filePath));
      }

      // Check query patterns
      if (schemaConfig.validateQueryPatterns !== false) {
        violations.push(...a.checkQueryPatterns(ast as AST, adapter as LanguageAdapter, sourceCode, schemaConfig));
      }

      // Check SQL injection
      violations.push(...a.checkSQLInjection(ast as AST, adapter as LanguageAdapter, sourceCode));

      // Emit facts for the Stage 3 reducer
      return {
        violations,
        facts: {
          [context.filePath]: {
            tableRefs: tableRefs.map((r: { table: string; type: string; location: { line: number; column: number }; context: string }) => ({
              table: r.table,
              type: r.type,
              line: r.location.line,
              column: r.location.column,
              context: r.context,
            })),
            ormTables,
          },
        },
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
        models.push(m[1]);
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
    async visit(_ast: unknown, _adapter: unknown, context: VisitorContext, sourceCode: string) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(sourceCode);
      } catch {
        // Invalid JSON — skip
      }
      return {
        violations: [],
        facts: { [context.filePath]: { jsonParsed: parsed !== null, jsonRaw: sourceCode } },
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
    })),
  );

  return {
    name: 'schema',
    stage: 'reducer',
    consumes: [],
    getRuleIds: () => getRuleIdsFor('schema'),
    async reduce(allFacts: Readonly<Record<string, unknown>>, context: ReducerContext) {
      const { analyzer: a } = await getAnalyzer();
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

      // 1a. SQL DDL replay — collect all .sql file facts, sort by numeric prefix, replay
      const sqlFiles: Array<{ filePath: string; source: string }> = [];
      for (const [filePath, fact] of perFile()) {
        if ('ddlSource' in fact) {
          sqlFiles.push({ filePath, source: fact.ddlSource as string });
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
        a.processMigrationSource(sqlFile.source, knownTables);
      }

      // 1b. ORM tables from code files
      for (const [, fact] of perFile()) {
        const ormTables: string[] = (fact as any).ormTables ?? [];
        for (const t of ormTables) knownTables.add(t);
      }

      // 1c. Prisma models
      for (const [, fact] of perFile()) {
        const prismaModels: string[] = (fact as any).prismaModels ?? [];
        for (const m of prismaModels) knownTables.add(m);
      }

      // ── 2. Unknown-table detection ────────────────────────────────────────

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
      if (knownTables.size > 0 && unknownRefs.length / Math.max(knownTables.size, 1) <= 10) {
        for (const ref of unknownRefs) {
          const suggestions = a.getNearestTableSuggestions(ref.table, knownTables, 2);
          const msg = suggestions.length > 0
            ? `Reference to unknown table '${ref.table}' (${ref.type}). Did you mean: ${suggestions.join(', ')}?`
            : `Reference to unknown table '${ref.table}' (${ref.type})`;
          violations.push({
            file: ref.file,
            line: ref.line,
            column: ref.column,
            severity: 'suggestion' as const,
            message: msg,
            rule: 'unknown-table',
            analyzer: 'schema',
            symbol: ref.table,
          } as Violation);
        }
      }

      // ── 3. JSON schema validation ──────────────────────────────────────────

      if (schemaConfig.validateJsonSchemas !== false) {
        try {
          // Build content Map from json facts for the refactored analyzeJsonSchemas
          const jsonContents = new Map<string, { parsed: object | null; raw: string }>();
          for (const [filePath, fact] of perFile()) {
            if ('jsonParsed' in (fact as any)) {
              jsonContents.set(filePath, {
                parsed: ((fact as any).jsonParsed ?? null) as object | null,
                raw: ((fact as any).jsonRaw ?? (fact as any).sourceCode ?? '') as string,
              });
            }
          }
          const jsonResult = a.analyzeJsonSchemas(jsonContents, schemaConfig);
          violations.push(...(jsonResult?.violations ?? []));
        } catch {
          // JSON schema validation is best-effort
        }
      }

      return {
        violations,
        facts: {},
        factsConsumed: [...perFile()].length,
      };
    },
    defaultConfig: {},
    description: 'Cross-file schema analysis: unknown-table detection and JSON schema validation',
    category: 'database',
  };
}
