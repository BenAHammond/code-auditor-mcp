/**
 * Spec 69 R3 — local binding resolution for `.where(and(...conditions))`.
 *
 * A `.where(...)` whose predicate spreads a local array binding
 * (`and(...conditions)`) hides the tenant predicate from the query text: the
 * `data-access-calls` producer extracts the candidate node's own text, which
 * mentions `conditions` but not the `eq(orders.organizationId, …)` elements
 * assembled in prior statements. This module resolves that spread to the
 * elements — a local `const`/`let` array binding and its `.push(...)` calls —
 * within the enclosing function body only. Syntactic and repo-local, no type
 * checker, no cross-function analysis (Spec 69 R3's stated ceiling).
 *
 * The result distinguishes all-paths from some-paths: an element present in the
 * array initializer, or pushed unconditionally, scopes the query on every path;
 * an element pushed under an `if`/`switch`/ternary/`&&`/`||`/loop scopes it on
 * only some paths. `missing-org-filter` reads this to go quiet only on an
 * all-paths tenant predicate — a some-paths predicate still fires (the query
 * executes unscoped on the branch where the guard is absent).
 */

import type { ASTNode, LanguageAdapter } from '../languages/types.js';
import type { ResolvedPredicateElement, ResolvedWhere } from './types.js';

const FUNCTION_NODE_TYPES = new Set([
  'arrow_function',
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function_expression',
  'method_definition',
]);

/** Loop kinds whose body runs 0..N times — a push inside is some-paths. */
const LOOP_TYPES = new Set([
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
]);

function textOf(node: ASTNode, sourceCode: string, adapter: LanguageAdapter): string {
  return adapter.getNodeText(node, sourceCode);
}

/** Direct children of a given node type (name/property/condition discovery). */
function childrenOfType(node: ASTNode, type: string): ASTNode[] {
  return (node.children ?? []).filter((c) => c.type === type);
}

/** Array/argument expression children — filter out the `,` separator (the only
 *  significant anonymous node inside an array literal or an argument list). */
function expressionChildren(node: ASTNode): ASTNode[] {
  return (node.children ?? []).filter((c) => c.type !== ',');
}

/** Depth-first traversal that never descends into a nested function body — the
 *  binding resolution is within-function only (Spec 69 R3's ceiling). */
function collectWithin(node: ASTNode, predicate: (n: ASTNode) => boolean): ASTNode[] {
  const out: ASTNode[] = [];
  const visit = (n: ASTNode, isRoot: boolean): void => {
    if (!isRoot && FUNCTION_NODE_TYPES.has(n.type)) return;
    if (predicate(n)) out.push(n);
    for (const c of n.children ?? []) visit(c, false);
  };
  visit(node, true);
  return out;
}

/** Plain full-subtree walk (used to find the spread inside the candidate call). */
function walk(node: ASTNode, fn: (n: ASTNode) => void): void {
  fn(node);
  for (const c of node.children ?? []) walk(c, fn);
}

/** True when `node` is a `<binding>.push(...)` call. */
function isPushCall(
  node: ASTNode,
  bindingName: string,
  sourceCode: string,
  adapter: LanguageAdapter,
): boolean {
  if (node.type !== 'call_expression') return false;
  const member = (node.children ?? []).find((c) => c.type === 'member_expression');
  if (!member) return false;
  const object = (member.children ?? []).find((c) => c.type === 'identifier');
  const property = (member.children ?? []).find((c) => c.type === 'property_identifier');
  if (!object || !property) return false;
  return (
    textOf(object, sourceCode, adapter) === bindingName &&
    textOf(property, sourceCode, adapter) === 'push'
  );
}

/** First argument of a call (the pushed element), skipping the `,` separator. */
function firstArgument(
  callNode: ASTNode,
  sourceCode: string,
  adapter: LanguageAdapter,
): ASTNode | null {
  const args = (callNode.children ?? []).find((c) => c.type === 'arguments');
  if (!args) return null;
  return expressionChildren(args)[0] ?? null;
}

/** The `if (...)` condition text with the outer parens stripped. */
function conditionLabel(
  ifNode: ASTNode,
  sourceCode: string,
  adapter: LanguageAdapter,
): string {
  const cond = (ifNode.children ?? []).find((c) => c.type === 'parenthesized_expression');
  if (cond) {
    const t = textOf(cond, sourceCode, adapter).trim();
    return t.replace(/^\((.*)\)$/s, '$1').trim();
  }
  return 'if';
}

/** Best-effort condition label for a switch-case / ternary gating node. */
function branchLabel(
  node: ASTNode,
  sourceCode: string,
  adapter: LanguageAdapter,
): string {
  if (node.type === 'if_statement') return conditionLabel(node, sourceCode, adapter);
  if (node.type === 'switch_case' || node.type === 'ternary_expression') {
    const first = (node.children ?? []).find(
      (c) => c.type !== ':' && c.type !== '?' && c.type !== '{' && c.type !== '}',
    );
    if (first) return textOf(first, sourceCode, adapter).trim();
  }
  return node.type;
}

/**
 * Classify a `.push(...)` call as all-paths or some-paths by walking up from it
 * to the enclosing function. A push gated by an `if`/`switch`/ternary/`&&`/
 * `||`/loop is some-paths, with the guard's text as the branch name.
 */
function gateInfo(
  pushNode: ASTNode,
  fnNode: ASTNode,
  sourceCode: string,
  adapter: LanguageAdapter,
): { gated: boolean; branch?: string } {
  let child = pushNode;
  let cur: ASTNode | null = pushNode.parent ?? null;
  while (cur && cur !== fnNode) {
    const t = cur.type;
    if (t === 'if_statement' || t === 'switch_case' || t === 'ternary_expression') {
      return { gated: true, branch: branchLabel(cur, sourceCode, adapter) };
    }
    if (LOOP_TYPES.has(t)) {
      return { gated: true, branch: t };
    }
    if (t === 'binary_expression') {
      const kids = cur.children ?? [];
      const opIdx = kids.findIndex((c) => c.type === '&&' || c.type === '||');
      // A push on the right of `&&`/`||` runs only when the guard short-circuits
      // it there; a push on the left always runs.
      if (opIdx >= 0 && kids.indexOf(child) > opIdx) {
        const left = kids
          .slice(0, opIdx)
          .map((c) => textOf(c, sourceCode, adapter).trim())
          .join(' ');
        return { gated: true, branch: left || kids[opIdx].type };
      }
    }
    child = cur;
    cur = cur.parent ?? null;
  }
  return { gated: false };
}

/**
 * Resolve a `.where(...)` spread (`and(...conditions)`) to the elements of the
 * local `conditions` binding, classified all-paths vs some-paths.
 *
 * @param callNode The data-access candidate node (the whole query statement).
 * @param sourceCode The file source for text extraction.
 * @param adapter The language adapter (text/type/parent navigation).
 * @returns The resolved elements, or null when there is no spread, no local
 *          binding, or no elements to resolve (the caller then fires as today).
 */
export function resolveWhereBinding(
  callNode: ASTNode,
  sourceCode: string,
  adapter: LanguageAdapter,
): ResolvedWhere | null {
  // 1. The spread identifier (`...conditions`) inside the candidate call.
  let bindingName: string | null = null;
  walk(callNode, (n) => {
    if (bindingName !== null || n.type !== 'spread_element') return;
    const id = childrenOfType(n, 'identifier')[0];
    if (id && /^[A-Za-z_$][\w$]*$/.test(textOf(id, sourceCode, adapter))) {
      bindingName = textOf(id, sourceCode, adapter);
    }
  });
  if (bindingName === null) return null;

  // 2. The enclosing function — the resolution ceiling.
  let fn: ASTNode | null = callNode.parent ?? null;
  while (fn && !FUNCTION_NODE_TYPES.has(fn.type)) fn = fn.parent ?? null;
  if (!fn) return null;

  const name = bindingName;
  const elements: ResolvedPredicateElement[] = [];

  // 3. Array-initializer elements — all-paths by construction.
  const declarators = collectWithin(fn, (n) => n.type === 'variable_declarator')
    .filter((d) => d.range[1] <= callNode.range[0]) // declared before use
    .filter((d) => {
      const id = childrenOfType(d, 'identifier')[0];
      return id && textOf(id, sourceCode, adapter) === name;
    });
  const declarator = declarators[declarators.length - 1] ?? null;
  if (declarator) {
    const value = (declarator.children ?? []).find((c) => c.type === 'array');
    if (value) {
      for (const el of expressionChildren(value)) {
        elements.push({ text: textOf(el, sourceCode, adapter).trim(), allPaths: true });
      }
    }
  }

  // 4. `.push(...)` elements — all-paths only when not gated.
  for (const push of collectWithin(fn, (n) => isPushCall(n, name, sourceCode, adapter))) {
    if (push.range[1] > callNode.range[0]) continue; // pushed after the query ran
    const arg = firstArgument(push, sourceCode, adapter);
    if (!arg) continue;
    const gate = gateInfo(push, fn, sourceCode, adapter);
    elements.push({
      text: textOf(arg, sourceCode, adapter).trim(),
      allPaths: !gate.gated,
      branch: gate.gated ? gate.branch : undefined,
    });
  }

  if (elements.length === 0) return null;
  return { elements };
}
