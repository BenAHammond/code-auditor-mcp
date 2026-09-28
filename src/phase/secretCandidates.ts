/**
 * Spec 68 §3.2 — the per-file `secret-candidates` producer.
 *
 * Projects the credential-position strings a source file holds onto the
 * serializable `SecretCandidate` fact. It re-homes the *extraction* half of
 * `UniversalSecretsAnalyzer` — `inspectNode`'s four cases and the AST-dependent
 * helpers it used (`stringValue`, `directStringChild`, `declaratorName`,
 * `assignmentKey`, `pairKeyAndValue`) — while leaving the *classification*
 * (`isSecretName`, `looksLikeRealSecret`, `isCredentialSelector`,
 * `isTestOrFixtureFile`) to the rule. The producer only projects what the AST
 * makes reachable: a candidate's name/key/args plus the enclosing node's start
 * position (the legacy analyzer anchored at the enclosing node, not the string).
 *
 * A `call` candidate carries the sibling string-argument *values* (not nodes) so
 * the rule can re-run the selector/secret split `checkCredentialCall` did. The
 * producer emits a call candidate only when the call has ≥2 string arguments
 * (the legacy early-return), but does not apply `isCredentialSelector` — that is
 * the rule's pure decision over the extracted text.
 */

import type { AstFile, SecretCandidate } from './types.js';
import { walkAST } from '../languages/adapterBridge.js';
import type { ASTNode, LanguageAdapter } from '../languages/types.js';

/** Extract the raw text of a `string` literal, preferring the `string_fragment`
 *  child (content without quotes) and falling back to stripping delimiters. */
function stringValue(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string {
  const frag = node.children?.find((c) => c.type === 'string_fragment');
  if (frag) return adapter.getNodeText(frag, sourceCode);
  let text = adapter.getNodeText(node, sourceCode).trim();
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith('`') && text.endsWith('`'))
  ) {
    text = text.slice(1, -1);
  }
  return text;
}

/** Find a direct `string` child (the literal value), not a nested one. */
function directStringChild(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  for (const c of node.children ?? []) {
    if (c.type === 'string') return stringValue(c, adapter, sourceCode);
  }
  return null;
}

/** Extract the variable name from a `variable_declarator`. */
function declaratorName(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const name = node.children?.find((c) => c.type === 'identifier');
  return name ? adapter.getNodeText(name, sourceCode) : null;
}

/** Extract the assigned field name from an `assignment_expression` left side. */
function assignmentKey(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const left = node.children?.find(
    (c) => c.type === 'member_expression' || c.type === 'subscript_expression' || c.type === 'identifier',
  );
  if (!left) return null;
  if (left.type === 'member_expression') {
    const prop = left.children?.find((c) => c.type === 'property_identifier');
    return prop ? adapter.getNodeText(prop, sourceCode) : null;
  }
  if (left.type === 'subscript_expression') {
    const key = left.children?.find((c) => c.type === 'string');
    return key ? stringValue(key, adapter, sourceCode) : null;
  }
  return adapter.getNodeText(left, sourceCode);
}

/** Extract `{ key, value }` from an object `pair` node. */
function pairKeyAndValue(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): { key: string; value: string } | null {
  const strings = (node.children ?? []).filter((c) => c.type === 'string');
  if (strings.length === 0) return null;
  const keyNode = node.children?.find((c) => c.type === 'property_identifier') ?? strings[0];
  const valueNode = strings[strings.length - 1];
  if (valueNode === keyNode && strings.length < 2) return null;
  const key = keyNode.type === 'property_identifier'
    ? adapter.getNodeText(keyNode, sourceCode)
    : stringValue(keyNode, adapter, sourceCode);
  const value = stringValue(valueNode, adapter, sourceCode);
  return { key, value };
}

/** Project one node onto a candidate, or `null` when it is not a credential
 *  position (or has no string value to carry). */
function candidateFor(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  filePath: string,
): SecretCandidate | null {
  const loc = { file: filePath, line: node.location.start.line, column: node.location.start.column };

  // 1. `const <name> = '<value>'`
  if (node.type === 'variable_declarator') {
    const name = declaratorName(node, adapter, sourceCode);
    const value = directStringChild(node, adapter, sourceCode);
    if (name && value !== null) return { position: 'declarator', name, value, ...loc };
    return null;
  }

  // 2. `<obj>.<field> = '<value>'` / `<field> = '<value>'`
  if (node.type === 'assignment_expression') {
    const key = assignmentKey(node, adapter, sourceCode);
    const value = directStringChild(node, adapter, sourceCode);
    if (key && value !== null) return { position: 'assignment', name: key, value, ...loc };
    return null;
  }

  // 3. `{ <key>: '<value>' }`
  if (node.type === 'pair') {
    const pv = pairKeyAndValue(node, adapter, sourceCode);
    if (pv) return { position: 'pair', name: pv.key, value: pv.value, ...loc };
    return null;
  }

  // 4. `fn('<selector>', '<secret>')` — a call with ≥2 string arguments.
  if (node.type === 'call_expression') {
    const argsNode = node.children?.find((c) => c.type === 'arguments');
    if (!argsNode) return null;
    const stringArgs = (argsNode.children ?? []).filter((c) => c.type === 'string');
    if (stringArgs.length < 2) return null;
    return { position: 'call', args: stringArgs.map((a) => stringValue(a, adapter, sourceCode)), ...loc };
  }

  return null;
}

/**
 * One file's credential-position strings as `SecretCandidate[]`.
 *
 * @param file - The parsed file whose credential-position strings are projected.
 * @returns The file's candidate secret strings with their positions.
 */
export function extractSecretCandidates(file: AstFile): SecretCandidate[] {
  const out: SecretCandidate[] = [];
  walkAST(file.ast.root, (node) => {
    const candidate = candidateFor(node, file.adapter, file.source, file.file);
    if (candidate) out.push(candidate);
  });
  return out;
}
