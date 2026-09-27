/**
 * Spec 68 §3.2 — the per-file `file-header` producer.
 *
 * Projects the legacy `getFileDocumentation` walk (UniversalDocumentationAnalyzer)
 * onto a single serializable fact: the file's leading documentation comment
 * (trimmed), or `null` when there is none. The producer does not judge whether
 * the comment is a *file header* (a `@fileoverview`/`@file`/`@module`/
 * `@overview`/`@purpose` marker) — that classification is `file-documentation`'s,
 * re-applied over the projected text so the producer stays a pure projection
 * and the tree dies with the file.
 */

import type { AST, LanguageAdapter, ASTNode } from '../languages/types.js';
import type { AstFile, FileHeaderFact } from './types.js';

/**
 * The leading documentation comment a file carries. Re-homes the legacy
 * `getFileDocumentation`: when the AST's first child is itself a comment, that
 * comment IS the candidate header (looking for a comment *preceding* it would
 * wrongly return null); otherwise ask the adapter for the doc comment preceding
 * the first node.
 */
function getFileDocumentation(ast: AST, adapter: LanguageAdapter, sourceCode: string): string | null {
  const firstChild: ASTNode | undefined = ast.root.children?.[0];
  if (!firstChild) return null;
  if (firstChild.type === 'comment') {
    const text = adapter.getNodeText(firstChild, sourceCode);
    return text ? text.trim() : null;
  }
  return adapter.getDocumentation(firstChild);
}

/** One file's leading documentation comment as a `FileHeaderFact`. */
export function extractFileHeader(file: AstFile): FileHeaderFact[] {
  return [{ file: file.file, headerDoc: getFileDocumentation(file.ast, file.adapter, file.source) }];
}
