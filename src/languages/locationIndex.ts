/**
 * Per-file AST location index — replaces the per-block BFS `findNodeByLocation`.
 *
 * The legacy `findNodeByLocation` ran a fresh breadth-first search from the file
 * root for every symbol it resolved (one BFS per class method, function, or
 * block). Each BFS is O(n), and running one per symbol makes the aggregate
 * O(blocks × n²). This module builds a single `line:column` → node index per
 * file (one O(n) index-pointer BFS, first-wins to preserve the BFS "shallowest
 * match" semantics) and memoizes it per root via a WeakMap, turning every lookup
 * into an O(1) map read.
 *
 * `skipRoot` reproduces the one deliberate divergence among the legacy copies:
 * the DRY analyzer and the code-block producer start their search from
 * `root.children`, never the root itself, because the whole-file wrapper
 * (`program`/`source_file`) shares its start position with its first top-level
 * child and returning the wrapper broke `deduplicateBlocks`. Every other call
 * site searched from the root, so the root wins the collision there.
 */
import type { ASTNode } from './types.js';

/** The `line:column` key a node's start position maps to. */
export function locationKey(location: { line: number; column: number }): string {
  return `${location.line}:${location.column}`;
}

const rootIndexCache = new WeakMap<ASTNode, Map<string, ASTNode>>();
const childIndexCache = new WeakMap<ASTNode, Map<string, ASTNode>>();

/** Build (and memoize per root) the `line:column` → node index, in the same
 *  first-wins BFS order the legacy search returned nodes in.
 *  @param root The file's root node, the BFS start.
 *  @param skipRoot When true the root wrapper is excluded, so its first
 *  top-level child wins the shared start position.
 *  @returns The `line:column` → node map, cached per root. */
export function buildLocationIndex(root: ASTNode, skipRoot = false): Map<string, ASTNode> {
  const cache = skipRoot ? childIndexCache : rootIndexCache;
  const cached = cache.get(root);
  if (cached) return cached;

  const index = new Map<string, ASTNode>();
  const queue: ASTNode[] = skipRoot ? [...(root.children ?? [])] : [root];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++];
    const key = locationKey(node.location.start);
    if (!index.has(key)) index.set(key, node);
    if (node.children) {
      for (const child of node.children) queue.push(child);
    }
  }
  cache.set(root, index);
  return index;
}

/** Look up the node whose start position matches `location`.
 *  @param root The file's root node, the index root.
 *  @param location The `line`/`column` start position to resolve.
 *  @param skipRoot When true the root wrapper is excluded from the index.
 *  @returns The node whose start position matches, or null when absent. */
export function findNodeByLocation(
  root: ASTNode,
  location: { line: number; column: number },
  skipRoot = false,
): ASTNode | null {
  return buildLocationIndex(root, skipRoot).get(locationKey(location)) ?? null;
}
