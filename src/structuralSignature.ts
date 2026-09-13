/**
 * Spec 57 — structural AST signature.
 *
 * The telemetry payload describes *the shape* of the code a finding points at,
 * so the service can cluster "these are all for-loops with a `.save()` inside"
 * without ever receiving source text. The only thing this module reads off a
 * node is `type` — the tree-sitter grammar kind (`for_statement`,
 * `call_expression`, `identifier`, `string`, …) — a fixed, finite vocabulary.
 * It never reads `getNodeText`/`getNodeName`/`raw`, so identifiers, string
 * literals, table names, paths, and comments can never enter a signature.
 *
 * Acceptance 6 (the shipping gate) hinges on exactly this: a finding on code
 * containing a secret + a table name + a distinctive identifier must produce a
 * signature containing none of the three. The `structuralSignature.spec.ts`
 * guard test asserts that directly.
 */
import type { AST, ASTNode } from './languages/types.js';
import { isFunctionType, isClassType } from './languages/tree-sitter/converter.js';

export interface SignatureOptions {
  /** Stop descending past this depth (default 8). Keeps the shape coarse. */
  maxDepth?: number;
  /** Stop after this many node kinds (default 128). Bounds large subtrees. */
  maxNodes?: number;
}

/**
 * Canonical structural signature of a node's subtree: a parenthesized pre-order
 * encoding of node kinds. Only `type` is read; content is never touched, so the
 * output is safe to transmit.
 *
 * Example: `for_statement ( ) call_expression ( member_expression ( identifier property_identifier ) argument_list ( ) )`
 */
export function structuralSignature(node: ASTNode, opts: SignatureOptions = {}): string {
  const maxDepth = opts.maxDepth ?? 8;
  const maxNodes = opts.maxNodes ?? 128;
  const parts: string[] = [];
  let count = 0;

  const walk = (n: ASTNode, depth: number): boolean => {
    if (count >= maxNodes) return false;
    count += 1;
    parts.push(n.type);
    const kids = n.children ?? [];
    if (depth >= maxDepth || kids.length === 0) return true;
    parts.push('(');
    for (const child of kids) {
      if (!walk(child, depth + 1)) break;
    }
    parts.push(')');
    return true;
  };

  walk(node, 0);
  return parts.join(' ');
}

/**
 * The node whose shape represents the finding's code: the nearest enclosing
 * function/class/method boundary, else the nearest top-level statement, else the
 * located node itself. Climbing to the function boundary means the signature
 * captures the finding's *context* (the whole for-loop, not just the `.save()`),
 * while `maxNodes` keeps a giant function from producing a giant signature.
 */
function findSignatureRoot(located: ASTNode): ASTNode {
  let funcOrClass: ASTNode | null = null;
  let topLevel: ASTNode | null = null;
  let cur: ASTNode | undefined = located;

  while (cur) {
    if (!funcOrClass && (isFunctionType(cur.type) || isClassType(cur.type))) {
      funcOrClass = cur;
    }
    const parent: ASTNode | undefined = cur.parent;
    if (parent && !parent.parent) {
      // `parent` is the root — `cur` is a top-level statement/declaration.
      if (!topLevel) topLevel = cur;
    }
    cur = parent;
  }

  return funcOrClass ?? topLevel ?? located;
}

/**
 * Locate the deepest node containing the given 1-based line/column.
 * Returns null when the location is outside the tree.
 */
function findDeepestNodeAt(root: ASTNode, location: { line: number; column: number }): ASTNode | null {
  let best: ASTNode | null = null;
  let bestDepth = -1;

  const walk = (node: ASTNode, depth: number): void => {
    const s = node.location.start;
    const e = node.location.end;
    const contains =
      (s.line < location.line || (s.line === location.line && s.column <= location.column)) &&
      (e.line > location.line || (e.line === location.line && e.column >= location.column));
    if (!contains) return;
    if (depth > bestDepth) {
      best = node;
      bestDepth = depth;
    }
    for (const child of node.children ?? []) walk(child, depth + 1);
  };

  walk(root, 0);
  return best;
}

/**
 * Produce the structural signature for a finding at a 1-based source location.
 * The located node is walked up to its function/class boundary before signing.
 * Returns null when no node contains the location.
 */
export function signatureForLocation(
  ast: AST,
  location: { line: number; column: number },
  opts: SignatureOptions = {},
): string | null {
  const located = findDeepestNodeAt(ast.root, location);
  if (!located) return null;
  return structuralSignature(findSignatureRoot(located), opts);
}
