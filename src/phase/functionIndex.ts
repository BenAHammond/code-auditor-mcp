/**
 * Spec 68 §3.2 — the `function-index` FileProcessor extraction.
 *
 * Re-homes the function/method/component extraction from
 * `createFunctionIndexVisitor` (pipelineAdapters.ts) as a pure per-file
 * processor. The visitor did three jobs: extract function rows, emit DB
 * `indexFacts` (import_specifiers, function_calls rebuild), and extract
 * imports/exports for the invariants/conventions layers. The processor keeps
 * only the function-row extraction — the other two jobs belong to other facts,
 * and §3.2 is "one fact kind per producer". The DB-assigned `id` is dropped: a
 * function's identity is `(file, name, line)`, which is what the diff-scoped
 * content hash keys on.
 *
 * The three passes mirror the visitor exactly: (1) `function_declaration` and
 * `method_definition`, (2) `variable_declarator` → `arrow_function`, (3) React
 * component detection (which upgrades an existing pass-1/2 entry to
 * `entityType: 'component'` or appends a new one for class / wrapper
 * components).
 */

import type { ParsedFile, FunctionIndexFact } from './types.js';
import {
  walkAST,
  isExported,
  getNodeText,
  getFieldNode,
  getLineAndColumn,
  calculateComplexity,
  getFunctionBody,
} from '../languages/adapterBridge.js';
import { buildImportMap, extractFunctionCalls } from '../utils/dependencyExtractor.js';
import { isReactComponent, detectComponentType, getComponentName } from '../utils/reactDetection.js';
import { getLanguageFromPath } from '../utils/fileDiscovery.js';
import type { ASTNode } from '../languages/types.js';

/** A function/method node's name — `name` field first (works for both
 *  `function_declaration` and `method_definition`, whose name is a
 *  `property_identifier`, not an `identifier`), then the identifier children.
 *  Mirrors `clNodeName` in pipelineAdapters.ts. */
function nodeName(node: ASTNode, sourceCode: string): string | undefined {
  const field = getFieldNode(node, 'name');
  if (field) {
    const text = getNodeText(field, sourceCode);
    if (text) return text;
  }
  const id = node.children?.find((c) => c.type === 'identifier')
    ?? node.children?.find((c) => c.type === 'property_identifier');
  return id ? getNodeText(id, sourceCode) : undefined;
}

/** Build one function-row fact from a function-like node. `exportedNode` is the
 *  node whose export status to read (the arrow's `variable_declarator`, not the
 *  arrow itself — matches the visitor's `isExported(node)` target). */
function row(
  node: ASTNode,
  name: string,
  entityType: FunctionIndexFact['entityType'],
  componentType: string | null,
  filePath: string,
  sourceCode: string,
  lang: string,
  importMap: ReturnType<typeof buildImportMap>,
  exportedNode: ASTNode = node,
): FunctionIndexFact {
  const { line } = getLineAndColumn(node);
  const body = getFunctionBody(node, sourceCode);
  const calls = extractFunctionCalls(node, sourceCode, importMap);
  return {
    file: filePath,
    name,
    line,
    endLine: node.location.end.line,
    entityType,
    componentType,
    isExported: isExported(exportedNode),
    complexity: calculateComplexity(node),
    body: body ?? null,
    functionCalls: [...new Set(calls.map((c) => c.callee))],
    language: lang,
  };
}

/** Extract every function/method/component from one parsed file. */
export function extractFunctionIndex(file: ParsedFile): FunctionIndexFact[] {
  const root = file.ast.root;
  const filePath = file.file;
  const sourceCode = file.source;

  const lang = getLanguageFromPath(filePath);
  if (lang === 'unknown') return [];

  const importMap = buildImportMap(root, sourceCode);
  const entries: FunctionIndexFact[] = [];

  // Pass 1 — named function declarations and class methods.
  walkAST(root, (node) => {
    if (node.type === 'function_declaration') {
      const name = nodeName(node, sourceCode);
      if (!name) return;
      entries.push(row(node, name, 'function', null, filePath, sourceCode, lang, importMap));
    } else if (node.type === 'method_definition') {
      const methodName = nodeName(node, sourceCode);
      if (!methodName) return;

      let parent: ASTNode | null = node.parent ?? null;
      let className = 'AnonymousClass';
      while (parent) {
        if (parent.type === 'class_declaration') {
          // A class name is a `type_identifier`, not an `identifier` — read the
          // `name` field (nodeName falls back to type_identifier via getFieldNode).
          className = nodeName(parent, sourceCode) ?? 'AnonymousClass';
          break;
        }
        parent = parent.parent ?? null;
      }
      entries.push(row(node, `${className}.${methodName}`, 'method', null, filePath, sourceCode, lang, importMap));
    }
  });

  // Pass 2 — arrow functions assigned to variables. The export status is read
  // from the `variable_declarator`, not the arrow (matches the visitor).
  walkAST(root, (node) => {
    if (node.type !== 'variable_declarator') return;
    const nameNode = node.children?.find((c) => c.type === 'identifier');
    const arrowFunc = node.children?.find((c) => c.type === 'arrow_function');
    if (!nameNode || !arrowFunc) return;
    const name = getNodeText(nameNode, sourceCode);
    if (!name) return;
    entries.push(row(arrowFunc, name, 'function', null, filePath, sourceCode, lang, importMap, node));
  });

  // Pass 3 — React component detection. Upgrade an existing entry (function /
  // arrow declared with the component's name) or append a new one (class
  // component, function_expression, memo/forwardRef wrapper).
  const hasReactImport = [...importMap.values()].some((v) => v.modulePath === 'react');
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

      const existing = entries.find((f) => f.name === cName);
      if (existing) {
        existing.entityType = 'component';
        existing.componentType = ct;
      } else {
        entries.push(row(node, cName, 'component', ct, filePath, sourceCode, lang, importMap));
      }
    });
  }

  return entries;
}
