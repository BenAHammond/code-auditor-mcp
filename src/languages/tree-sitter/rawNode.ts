/**
 * Adapter-internal tree-sitter node retention.
 *
 * `ASTNode` deliberately has no `raw` member — nothing outside `src/languages/`
 * may hold (or reach) a parser-specific node. Adapters still need the live
 * tree-sitter node to do their own work (named-field access, node identity,
 * complexity over the raw subtree), so the mapping is kept here, in a side
 * `WeakMap`, keyed by the `ASTNode` the converter produced.
 *
 * The value is *not* reachable from an `ASTNode` held outside this directory:
 * an `ASTNode` carries only `type`/`range`/`location`/`children`/`parent`, and
 * the accessor below is exported from within `src/languages/` only (never from
 * the package entry point). The map is `WeakMap` so a discarded `ASTNode` lets
 * its tree-sitter node be collected.
 */

import type { Node as TreeSitterNode } from 'web-tree-sitter';
import type { ASTNode } from '../types.js';

const rawNodes = new WeakMap<ASTNode, TreeSitterNode>();

/** Register the tree-sitter node backing an `ASTNode` (called by `toASTNode`). */
export function registerRawNode(astNode: ASTNode, raw: TreeSitterNode): void {
  rawNodes.set(astNode, raw);
}

/**
 * Return the tree-sitter node backing an `ASTNode`.
 *
 * Every `ASTNode` an adapter walks came from `toASTNode`, which registers its
 * raw node, so this is always present in adapter code. The one synthetic node
 * (`SAFE_STRING_NODE`) is short-circuited by identity before any raw access.
 * Throwing here — rather than returning `undefined` and letting strict-null
 * checks surface a soft miss deep in a traversal — keeps the adapter's
 * "raw is always present" invariant explicit.
 */
export function getRawNode(node: ASTNode): TreeSitterNode {
  const raw = rawNodes.get(node);
  if (!raw) {
    throw new Error('ASTNode is not backed by a registered tree-sitter node');
  }
  return raw;
}
