/**
 * Shared SQL-literal dequoting: turn the raw source text of a string/template
 * literal node into the literal's *value* — the SQL text a parser expects —
 * not the raw source slice.
 *
 * The raw source still carries the host language's escape sequences (`\'` for
 * an embedded single quote, `\\` for a literal backslash, `\n` for a newline).
 * Feeding that raw slice to the SQL parser corrupts the statement: the parser
 * reads `\'` where the author meant `'` and mis-parses the string. `stripSqlQuotes`
 * therefore both strips the surrounding delimiters *and* un-escapes the inner
 * body to its runtime value.
 *
 * This was once a two-line `slice(1, -1)` duplicated verbatim in `provenance.ts`
 * and `UniversalDataAccessAnalyzer.ts`; it lives here once so the two cannot
 * drift. The `raw` flag preserves the one place the two languages disagree on
 * backticks: a Go `raw_string_literal` is literal (no escapes), while a TS
 * `template_string` is escape-bearing.
 */

import type { ASTNode, LanguageAdapter } from '../languages/types.js';
import type { GoResolutionEnv } from '../languages/go/goResolution.js';
import { SQL_TAG_NAMES } from './universal/schema/config.js';

/**
 * Strip the surrounding quote delimiters of a string/template literal and
 * un-escape the inner escape sequences to the literal's runtime value.
 *
 * @param text - the raw source text of the literal node, delimiters included.
 * @param opts.raw - true when the literal is a Go `raw_string_literal`
 *   (backtick, no escape sequences); the body is then returned verbatim.
 * @returns the unquoted literal body, un-escaped to its runtime value
 */
export function stripSqlQuotes(text: string, opts?: { raw?: boolean }): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'" || text[0] === '`')) {
    const body = text.slice(1, -1);
    return opts?.raw ? body : unescapeLiteralBody(body);
  }
  return text;
}

/**
 * Un-escape the body of an *interpreted* string/template literal — the inner
 * text between the delimiters — to its runtime value. Covers the escapes JS/TS
 * and Go share for SQL-relevant content: the quote/backtick/backslash escapes,
 * the C-style control escapes, and the hex/unicode escapes. An unrecognized
 * escape (`\d`) is preserved verbatim rather than dropped: dropping the
 * backslash would silently rewrite a literal backslash the author meant.
 */
function unescapeLiteralBody(body: string): string {
  if (body.indexOf('\\') === -1) return body;
  let out = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    if (ch !== '\\' || i + 1 >= n) {
      out += ch;
      i += 1;
      continue;
    }
    const next = body[i + 1];
    switch (next) {
      case 'n': out += '\n'; i += 2; break;
      case 't': out += '\t'; i += 2; break;
      case 'r': out += '\r'; i += 2; break;
      case 'b': out += '\b'; i += 2; break;
      case 'f': out += '\f'; i += 2; break;
      case 'v': out += '\v'; i += 2; break;
      case '0': out += '\0'; i += 2; break;
      case 'a': out += '\x07'; i += 2; break; // \a (bell) — Go only, harmless in JS
      case '\\': out += '\\'; i += 2; break;
      case "'": out += "'"; i += 2; break;
      case '"': out += '"'; i += 2; break;
      case '`': out += '`'; i += 2; break;
      case '\n': i += 2; break; // line continuation — drop `\` + newline
      case '\r': // `\` + `\r` (or `\r\n`) line continuation
        i += 2;
        if (i < n && body[i] === '\n') i += 1;
        break;
      case 'x': {
        const hex = body.slice(i + 2, i + 4);
        if (i + 4 <= n && /^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          out += '\\x';
          i += 2;
        }
        break;
      }
      case 'u': {
        if (body[i + 2] === '{') {
          const close = body.indexOf('}', i + 2);
          const hex = close === -1 ? '' : body.slice(i + 3, close);
          if (close !== -1 && /^[0-9a-fA-F]{1,6}$/.test(hex)) {
            const cp = parseInt(hex, 16);
            if (cp <= 0x10ffff) {
              out += String.fromCodePoint(cp);
              i = close + 1;
              break;
            }
          }
          out += '\\u';
          i += 2;
        } else {
          const hex = body.slice(i + 2, i + 6);
          if (i + 6 <= n && /^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
          } else {
            out += '\\u';
            i += 2;
          }
        }
        break;
      }
      default:
        out += '\\' + next;
        i += 2;
        break;
    }
  }
  return out;
}

// ── Static SQL extraction ─────────────────────────────────────────────────────
//
// `extractStaticSql` is the single production extraction point for a call's
// static SQL text (Spec 70 R2): a call's string/template argument, a tagged
// template's body, or a variable assignment's RHS literal. It was moved out of
// `UniversalDataAccessAnalyzer.ts` into this neutral SQL-literal module so the
// data-access analyzer's *class* could be deleted without orphaning the live
// candidate extractors (`extractDataAccessCallCandidates` /
// `extractLoopQueryRawCandidates`) that call it. `provenance.ts` keeps its own
// R3-specific literal-argument slice (`extractStaticSqlArgument`) — that one is
// not this function and does not move.

/** True when a node type is a literal that can carry static SQL text — TS/JS
 *  `string` / `template_string` and Go's `interpreted_string_literal` /
 *  `raw_string_literal`. */
function isSqlStringLiteralType(type: string): boolean {
  return type === 'string' ||
    type === 'template_string' ||
    type === 'interpreted_string_literal' ||
    type === 'raw_string_literal';
}

/** Unquote a string/template literal node's text; null when the template is
 *  dynamic (carries a `${…}` substitution). Go `raw_string_literal`s are literal
 *  (no escapes) and pass `raw: true` so their backticks are not un-escaped. */
function staticLiteralText(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  const nodeType = adapter.getNodeType(node);
  if (nodeType === 'template_string') {
    const children = adapter.getChildren(node) ?? [];
    if (children.some((c) => adapter.getNodeType(c) === 'template_substitution')) return null;
  }
  const raw = adapter.getNodeText(node, sourceCode) ?? '';
  return stripSqlQuotes(raw, { raw: nodeType === 'raw_string_literal' });
}

/** True when a node is a template literal (TS `template_string`). */
export function isTemplateLiteral(node: ASTNode, _adapter: LanguageAdapter): boolean {
  return node.type === 'template_string';
}

/** The variable-assignment node types whose RHS can carry a static SQL literal. */
const VARIABLE_ASSIGNMENT_SQL_TYPES = new Set([
  // TS/JS
  'variable_declaration',
  'lexical_declaration',
  'variable_declarator',
  'assignment_expression',
  // Go
  'short_var_declaration',
  'var_declaration',
  'var_spec',
  'assignment_statement',
]);

/**
 * The static string/template literal a variable-assignment node initialises
 * with, or null. Only a *direct* initializer qualifies: `const q = "SELECT"` is
 * static, `const q = "SELECT" + x` is dynamic (its literal is nested inside a
 * binary expression) and yields null. The declaration containers
 * (`lexical_declaration`, `var_declaration`) descend to their declarator/spec
 * first; Go wraps the RHS in an `expression_list`.
 */
function variableInitializerLiteral(
  node: ASTNode,
  adapter: LanguageAdapter,
): ASTNode | null {
  const type = adapter.getNodeType(node);
  if (type === 'lexical_declaration' || type === 'variable_declaration') {
    for (const c of adapter.getChildren(node) ?? []) {
      if (adapter.getNodeType(c) === 'variable_declarator') {
        const lit = variableInitializerLiteral(c, adapter);
        if (lit) return lit;
      }
    }
    return null;
  }
  if (type === 'var_declaration') {
    for (const c of adapter.getChildren(node) ?? []) {
      if (adapter.getNodeType(c) === 'var_spec') {
        const lit = variableInitializerLiteral(c, adapter);
        if (lit) return lit;
      }
    }
    return null;
  }
  for (const c of adapter.getChildren(node) ?? []) {
    const t = adapter.getNodeType(c);
    if (isSqlStringLiteralType(t)) return c;
    if (t === 'expression_list') {
      for (const e of adapter.getChildren(c) ?? []) {
        if (isSqlStringLiteralType(adapter.getNodeType(e))) return e;
      }
    }
  }
  return null;
}

/** The callee of a call expression, limited to the identifier / member /
 *  selector shapes a tagged-template tag can take. Inlined here (the shared
 *  `getCallExpressionCallee` lives in `provenance.ts`, which imports this module
 *  for `stripSqlQuotes` — importing it back would close an import cycle). */
function taggedTemplateCallee(node: ASTNode, adapter: LanguageAdapter): ASTNode | null {
  for (const child of adapter.getChildren(node)) {
    if (child.type === 'arguments') break;
    if (
      child.type === 'identifier' ||
      child.type === 'member_expression' ||
      child.type === 'selector_expression'
    ) {
      return child;
    }
  }
  return null;
}

/** True when a call is a SQL tagged template (`sql\`…\`` / `this.sql\`…\``) under
 *  the given tag names.
 *
 * @param node - the candidate call node to classify
 * @param adapter - the language adapter used to read children and text
 * @param sourceCode - the file source text for reading tag names
 * @param tagNames - the recognized SQL tag names to match against
 * @returns true when the call is a SQL tagged template under one of `tagNames`
 */
export function isTaggedTemplateSqlCall(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  tagNames: readonly string[],
): boolean {
  if (node.type !== 'call_expression') return false;

  // A tagged-template call carries the template string as a direct child (there
  // is no `arguments` node), but accept both shapes for robustness.
  const children = adapter.getChildren(node);
  const hasTemplate =
    children.some((c) => isTemplateLiteral(c, adapter)) ||
    children.some(
      (c) => adapter.getNodeType(c) === 'arguments' &&
        adapter.getChildren(c).some((a) => isTemplateLiteral(a, adapter)),
    );
  if (!hasTemplate) return false;

  const callee = taggedTemplateCallee(node, adapter);
  if (!callee) return false;
  const calleeType = adapter.getNodeType(callee);

  // Bare tag: `sql\`…\`` / `db\`…\``.
  if (calleeType === 'identifier') {
    return tagNames.includes(adapter.getNodeText(callee, sourceCode));
  }

  // Member tag on `this`: `this.sql\`…\`` — a wrapper re-exposing the tag.
  if (calleeType === 'member_expression') {
    const parts = adapter.getChildren(callee);
    const prop = parts.find((c) => adapter.getNodeType(c) === 'property_identifier');
    if (!prop || !tagNames.includes(adapter.getNodeText(prop, sourceCode))) return false;
    const receiver = parts.find((c) => adapter.getNodeType(c) !== 'property_identifier');
    return !!receiver && adapter.getNodeText(receiver, sourceCode) === 'this';
  }

  return false;
}

/**
 * The static SQL argument of a candidate node, or null when it carries none.
 *
 * Spec 70 R2 — the single extraction point for the SQL-content facts: a call's
 * string/template argument (unquoted), a tagged template's body, or a variable
 * assignment's RHS literal. A template carrying a `${…}` substitution is
 * dynamic and yields null (its shape is interpolated, not a parseable literal);
 * that is `cannot-fire`, not a negative verdict.
 *
 * @param node - the candidate node carrying the SQL argument
 * @param adapter - the language adapter used to read children and text
 * @param sourceCode - the file source text for reading node text
 * @returns the static SQL text, or null when the node carries none (dynamic/interpolated)
 */
export function extractStaticSql(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  const type = adapter.getNodeType(node);

  // Tagged template (sql`…`) or a template literal found as a call argument.
  // Go's string literals are `interpreted_string_literal` / `raw_string_literal`.
  if (isSqlStringLiteralType(type)) {
    return staticLiteralText(node, adapter, sourceCode);
  }
  // Variable assignment: the static RHS literal, if one. The declaration
  // containers (`lexical_declaration`, `var_declaration`) descend to their
  // declarator/spec; the declarator/spec/assignment then yields its direct
  // string/template literal (a literal nested inside a binary expression is
  // dynamic and yields null).
  if (VARIABLE_ASSIGNMENT_SQL_TYPES.has(type)) {
    const value = variableInitializerLiteral(node, adapter);
    return value ? staticLiteralText(value, adapter, sourceCode) : null;
  }
  // Call/new expression: the first static string/template argument.
  if (type === 'call_expression' || type === 'new_expression') {
    const argListType = adapter.name === 'go' ? 'argument_list' : 'arguments';
    const children = adapter.getChildren(node);
    const args = children.find((c) => adapter.getNodeType(c) === argListType);
    // A tagged template (`sql\`…\`` / `this.sql\`…\``) carries its template as a
    // DIRECT child — there is no `arguments` node. Extract that body (or null when
    // the template is interpolated, i.e. dynamic).
    if (!args) {
      const template = children.find((c) => isTemplateLiteral(c, adapter));
      return template ? staticLiteralText(template, adapter, sourceCode) : null;
    }
    for (const arg of adapter.getChildren(args)) {
      const t = adapter.getNodeType(arg);
      if (t === '(' || t === ')' || t === ',') continue;
      if (isSqlStringLiteralType(t)) return staticLiteralText(arg, adapter, sourceCode);
      // A tagged-template first argument (`db.execute(sql\`…\`)`) — recurse into
      // its body. Only a SQL tag (recognized by name) qualifies; a non-SQL tag is
      // `cannot-fire`.
      if (t === 'call_expression' && isTaggedTemplateSqlCall(arg, adapter, sourceCode, SQL_TAG_NAMES)) {
        return extractStaticSql(arg, adapter, sourceCode);
      }
      // ctx-first methods (Go `Query(ctx, sql)`, pgx `Query(ctx, "SELECT…")`)
      // carry a leading `context.Context`/options argument. Skip past it to the
      // first static string: a non-literal argument is not itself `cannot-fire`,
      // it may sit *ahead* of the SQL argument (Spec 70 R2, pgx/sqlc precision).
      continue;
    }
    return null;
  }
  return null;
}

/** The static SQL argument of a Go call, resolving a sqlc-generated package-level
 *  const identifier (`q.db.QueryContext(ctx, getAllUsers)` where `getAllUsers` is
 *  `const getAllUsers = `-- name: GetAllUsers :many\nSELECT …``) to its literal.
 *  The literal path is {@link extractStaticSql} (already ctx-first); this adds the
 *  one Go-only step — an identifier argument resolved through the file's `const`
 *  bindings — so sqlc's SQL reaches the parser instead of surfacing `cannot-fire`.
 *  Returns null when the call carries no static SQL (a ctx/options-only argument
 *  list, or an identifier that is not a const literal).
 *
 * @param node - the Go call node carrying the SQL argument
 * @param adapter - the language adapter used to read children and text
 * @param sourceCode - the file source text for reading node text
 * @param goEnv - the Go resolution environment holding the file's const bindings
 * @returns the static SQL text (const literal resolved), or null when none
 */
export function extractGoStaticSql(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  goEnv: GoResolutionEnv | undefined,
): string | null {
  const literal = extractStaticSql(node, adapter, sourceCode);
  if (literal !== null) return literal;
  if (!goEnv || adapter.name !== 'go') return null;
  const children = adapter.getChildren(node);
  const args = children.find((c) => adapter.getNodeType(c) === 'argument_list');
  if (!args) return null;
  for (const arg of adapter.getChildren(args)) {
    const t = adapter.getNodeType(arg);
    if (t === '(' || t === ')' || t === ',') continue;
    if (t !== 'identifier') continue; // ctx/options/other — skip
    const name = adapter.getNodeText(arg, sourceCode);
    if (!name) continue;
    const binding = goEnv.bindings.get(name);
    if (binding?.kind !== 'const' || !binding.value) continue;
    const v = binding.value;
    if (v.type === 'interpreted_string_literal' || v.type === 'raw_string_literal') {
      return stripSqlQuotes(v.text, { raw: v.type === 'raw_string_literal' });
    }
  }
  return null;
}
