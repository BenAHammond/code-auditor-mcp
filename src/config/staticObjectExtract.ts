/**
 * Static config extraction (Spec 61 R3.1).
 *
 * Reads a project-supplied JS/TS config and evaluates only its literal export —
 * without `require()`, `import()`, `createRequire(...)()` or a factory
 * invocation. A config file inside a cloned repository is data, not code; the
 * tool must be able to read it without executing the untrusted module.
 *
 * The extractor never runs the file. It parses it with tree-sitter and reduces
 * the export expression to a plain value. Anything it cannot prove is a literal
 * (a call, a computed key, an imported spread, a template substitution) is an
 * unresolved result — a first-class value, not an exception — that the caller
 * surfaces as a `cannot-fire` coverage diagnostic.
 */

import { parseFile, findNodes, getNodeText, getFieldNode } from '../languages/adapterBridge.js';
import type { AST, ASTNode } from '../languages/types.js';
import { isInitialized } from '../languages/tree-sitter/parser.js';

export type StaticExtractResult =
  | { resolved: true; value: unknown }
  | { resolved: false; reason: string; node?: { line: number; column: number } };

type EvalResult = { resolved: true; value: unknown } | { resolved: false; reason: string };

interface EvalContext {
  sourceText: string;
  /** name → the value node of a `const`/`let`/`var` declared anywhere in the file. */
  consts: Map<string, ASTNode>;
}

/** One-based line/column of a node, for diagnostics. */
function loc(node: ASTNode): { line: number; column: number } {
  return { line: node.location.start.line, column: node.location.start.column };
}

/**
 * Extract the module export of `filePath` as a static value.
 *
 * Returns `{ resolved: true, value }` when the export reduces to a literal, or
 * `{ resolved: false, reason, node? }` naming why it could not. Reasons are the
 * spec's vocabulary: `call-expression`, `imported-spread`, `computed-key`,
 * `function-value`, `template-substitution`, `dynamic-export`, `parse-error`.
 */
export function extractModuleExport(filePath: string, sourceText: string): StaticExtractResult {
  if (!isInitialized()) {
    return { resolved: false, reason: 'parse-error' };
  }

  const ast = parseFile(filePath, sourceText);
  if (!ast) return { resolved: false, reason: 'parse-error' };

  try {
    if (ast.errors && ast.errors.length > 0) {
      return { resolved: false, reason: 'parse-error' };
    }

    const ctx = buildContext(ast, sourceText);
    const exportNode = findExportValue(ast, ctx);
    if (!exportNode) return { resolved: false, reason: 'dynamic-export' };

    const r = evaluate(exportNode, ctx, 0);
    return r.resolved
      ? { resolved: true, value: r.value }
      : { resolved: false, reason: r.reason, node: loc(exportNode) };
  } finally {
    try {
      ast.dispose?.();
    } catch {
      // WASM tree reclaim is best-effort; a dispose failure must not mask a result.
    }
  }
}

/** Collect every top-level-or-nested `const x = <value>` for identifier resolution. */
function buildContext(ast: AST, sourceText: string): EvalContext {
  const consts = new Map<string, ASTNode>();
  for (const d of findNodes(ast.root, (n) => n.type === 'variable_declarator')) {
    const name = getFieldNode(d, 'name');
    const value = getFieldNode(d, 'value');
    if (name && value) {
      consts.set(getNodeText(name, sourceText), value);
    }
  }
  return { sourceText, consts };
}

/** Locate the value node of the module export (or null when no recognized form). */
function findExportValue(ast: AST, ctx: EvalContext): ASTNode | null {
  const root = ast.root;

  // `export default <expr>` / `export default <ident>` / `export const X = <expr>`.
  for (const stmt of findNodes(root, (n) => n.type === 'export_statement')) {
    const value = getFieldNode(stmt, 'value');
    if (value) return value;

    const declaration = getFieldNode(stmt, 'declaration');
    if (declaration && (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration')) {
      const declarator = declaration.children?.find((c) => c.type === 'variable_declarator');
      const valueNode = declarator ? getFieldNode(declarator, 'value') : undefined;
      if (valueNode) return valueNode;
    }
  }

  // `module.exports = <expr>` (CommonJS).
  for (const a of findNodes(root, (n) => n.type === 'assignment_expression')) {
    const left = getFieldNode(a, 'left');
    if (left && getNodeText(left, ctx.sourceText) === 'module.exports') {
      const right = getFieldNode(a, 'right');
      if (right) return right;
    }
  }

  return null;
}

/** Reduce an expression node to a plain value, or return an unresolved reason. */
function evaluate(node: ASTNode, ctx: EvalContext, depth: number): EvalResult {
  if (depth > 64) return { resolved: false, reason: 'dynamic-export' };

  switch (node.type) {
    case 'object':
      return evalObject(node, ctx, depth);
    case 'array':
      return evalArray(node, ctx, depth);
    case 'string':
      return { resolved: true, value: parseStringLiteral(getNodeText(node, ctx.sourceText)) };
    case 'number':
      return { resolved: true, value: Number(getNodeText(node, ctx.sourceText)) };
    case 'true':
      return { resolved: true, value: true };
    case 'false':
      return { resolved: true, value: false };
    case 'null':
      return { resolved: true, value: null };
    case 'undefined':
      return { resolved: true, value: undefined };
    case 'template_string':
      return evalTemplate(node, ctx);
    case 'identifier':
    case 'shorthand_property_identifier':
      return evalIdentifier(node, ctx, depth);
    case 'unary_expression':
      return evalUnary(node, ctx, depth);
    case 'satisfies_expression':
    case 'as_expression':
    case 'parenthesized_expression':
    case 'non_null_expression':
      return evalWrapped(node, ctx, depth);
    case 'spread_element':
      return evalSpread(node, ctx, depth);
    case 'call_expression':
    case 'new_expression':
      return { resolved: false, reason: 'call-expression' };
    case 'arrow_function':
    case 'function_expression':
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'generator_function_expression':
    case 'class_declaration':
    case 'class_expression':
      return { resolved: false, reason: 'function-value' };
    case 'computed_property_name':
      return { resolved: false, reason: 'computed-key' };
    default:
      return { resolved: false, reason: 'dynamic-export' };
  }
}

function evalObject(node: ASTNode, ctx: EvalContext, depth: number): EvalResult {
  const out: Record<string, unknown> = {};

  for (const child of node.children ?? []) {
    if (child.type === 'pair') {
      const keyNode = getFieldNode(child, 'key');
      const valueNode = getFieldNode(child, 'value');
      if (!valueNode) continue;

      let key: string;
      if (!keyNode) {
        continue;
      } else if (keyNode.type === 'property_identifier' || keyNode.type === 'identifier' || keyNode.type === 'shorthand_property_identifier') {
        key = getNodeText(keyNode, ctx.sourceText);
      } else if (keyNode.type === 'string') {
        key = parseStringLiteral(getNodeText(keyNode, ctx.sourceText));
      } else if (keyNode.type === 'number') {
        key = getNodeText(keyNode, ctx.sourceText);
      } else {
        return { resolved: false, reason: 'computed-key' };
      }

      const vr = evaluate(valueNode, ctx, depth + 1);
      if (!vr.resolved) return vr;
      out[key] = vr.value;
    } else if (child.type === 'spread_element') {
      const sr = evalSpread(child, ctx, depth + 1);
      if (!sr.resolved) return sr;
      if (sr.value !== null && typeof sr.value === 'object' && !Array.isArray(sr.value)) {
        Object.assign(out, sr.value as Record<string, unknown>);
      }
    } else if (child.type === 'shorthand_property_identifier') {
      const key = getNodeText(child, ctx.sourceText);
      const ir = evalIdentifier(child, ctx, depth + 1);
      if (!ir.resolved) return ir;
      out[key] = ir.value;
    }
  }

  return { resolved: true, value: out };
}

function evalArray(node: ASTNode, ctx: EvalContext, depth: number): EvalResult {
  const out: unknown[] = [];
  for (const child of node.children ?? []) {
    if (child.type === ',') continue;
    if (child.type === 'spread_element') {
      const sr = evalSpread(child, ctx, depth + 1);
      if (!sr.resolved) return sr;
      if (Array.isArray(sr.value)) out.push(...sr.value);
      else return { resolved: false, reason: 'imported-spread' };
    } else {
      const r = evaluate(child, ctx, depth + 1);
      if (!r.resolved) return r;
      out.push(r.value);
    }
  }
  return { resolved: true, value: out };
}

function evalTemplate(node: ASTNode, ctx: EvalContext): EvalResult {
  let text = '';
  for (const child of node.children ?? []) {
    if (child.type === 'template_substitution') {
      return { resolved: false, reason: 'template-substitution' };
    }
    if (child.type === 'string_fragment') {
      text += getNodeText(child, ctx.sourceText);
    }
  }
  return { resolved: true, value: text };
}

function evalIdentifier(node: ASTNode, ctx: EvalContext, depth: number): EvalResult {
  const name = getNodeText(node, ctx.sourceText);
  const valueNode = ctx.consts.get(name);
  if (!valueNode) {
    return { resolved: false, reason: 'imported-spread' };
  }
  return evaluate(valueNode, ctx, depth + 1);
}

function evalSpread(node: ASTNode, ctx: EvalContext, depth: number): EvalResult {
  const operand = node.children?.find((c) => c.type !== '...');
  if (!operand) return { resolved: false, reason: 'imported-spread' };
  const r = evaluate(operand, ctx, depth + 1);
  if (!r.resolved) return r;
  if (r.value === null || typeof r.value !== 'object') {
    return { resolved: false, reason: 'imported-spread' };
  }
  return r;
}

function evalWrapped(node: ASTNode, ctx: EvalContext, depth: number): EvalResult {
  for (const child of node.children ?? []) {
    if (isPunctuationNode(child)) continue;
    if (TYPE_NODE_TYPES.has(child.type)) continue;
    return evaluate(child, ctx, depth + 1);
  }
  return { resolved: false, reason: 'dynamic-export' };
}

function evalUnary(node: ASTNode, ctx: EvalContext, depth: number): EvalResult {
  const arg = getFieldNode(node, 'argument');
  if (!arg) return { resolved: false, reason: 'dynamic-export' };
  const op = getNodeText(node, ctx.sourceText).trim()[0];
  const r = evaluate(arg, ctx, depth + 1);
  if (!r.resolved) return r;

  if (op === '-') {
    return typeof r.value === 'number' ? { resolved: true, value: -r.value } : { resolved: false, reason: 'dynamic-export' };
  }
  if (op === '+') {
    return typeof r.value === 'number' ? { resolved: true, value: r.value } : { resolved: false, reason: 'dynamic-export' };
  }
  if (op === '!') {
    return { resolved: true, value: !r.value };
  }
  return { resolved: false, reason: 'dynamic-export' };
}

/** Type-side children of `as`/`satisfies` wrappers — never the value. */
const TYPE_NODE_TYPES = new Set([
  'type_identifier', 'predefined_type', 'generic_type', 'union_type',
  'intersection_type', 'object_type', 'function_type', 'type_annotation',
  'type_arguments', 'array_type', 'tuple_type', 'conditional_type',
  'literal_type', 'type_query', 'nested_type_identifier', 'this_type',
  'optional_type', 'rest_type', 'member_type', 'template_literal_type',
  'type_predicate', 'parenthesized_type', 'infer_type', 'lookup_type',
  'constructor_type', 'type_parameter', 'type_parameters', 'flow_maybe_type',
]);

/** Single significant-anonymous punctuation tokens (`(`, `,`, `.`, `=>`, …). */
function isPunctuationNode(node: ASTNode): boolean {
  const t = node.type;
  if (t.length === 1 && !/[A-Za-z0-9_]/.test(t)) return true;
  return ['=>', '...', '&&', '||', '==', '===', '!==', '!=', '**'].includes(t);
}

/** Strip quotes and process the handful of escapes config strings actually use. */
function parseStringLiteral(raw: string): string {
  const quote = raw[0];
  if ((quote === '"' || quote === "'") && raw.length >= 2 && raw[raw.length - 1] === quote) {
    return raw
      .slice(1, -1)
      .replace(/\\\\/g, '\\')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r');
  }
  return raw;
}
