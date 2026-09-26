/**
 * JSON language adapter with a position-preserving parser.
 *
 * Spec 68 Amendment 1 — "json is a format". A `.json` file is parsed like any
 * other source file, so the `schema-json` rules can go through the same
 * per-file model as every other rule instead of reading `.json` files off disk
 * through a config callback (`config.schemaFilePatterns`).
 *
 * There is no tree-sitter JSON grammar in this repository (the WASM grammars
 * are css, go, javascript, scss, tsx, typescript), so this adapter uses a
 * hand-written recursive-descent JSON parser that records the byte range and
 * line/column of every value. That is the one property Amendment 1 makes
 * load-bearing: a finding must carry a real position, so the parser must not
 * lose it. The parse is deliberately NOT `JSON.parse` + re-walk — `JSON.parse`
 * discards positions, which is exactly what the old `jsonSchema.ts` `emit` did
 * when it hardcoded `line: 1, column: 1`.
 *
 * JSON has no functions, classes, imports, exports, loops, or variables, so
 * every extraction/predicate method returns empty/false — the same stub shape
 * as {@link TreeSitterCssAdapter}. The tree still satisfies the `AST` contract:
 * each node has a `type` (`object` / `array` / `string` / `number` /
 * `boolean` / `null`), a real `range`, a real `location`, and `children` for
 * object members and array elements. An object member's value node carries its
 * key through a side map (surfaced by `getNodeName`); its raw value is
 * recoverable by the consumer slicing `source[node.range]` and re-parsing, so
 * no value object (which §4's serializability would reject) is stored on the
 * node itself.
 */

import type {
  AST,
  ASTNode,
  ClassInfo,
  ExportInfo,
  FunctionInfo,
  ImportInfo,
  InterfaceInfo,
  LanguageAdapter,
  NodePattern,
  SourceLocation,
} from '../types.js';

// ---------------------------------------------------------------------------
// Side maps (keyed by ASTNode — never serialized, never cross a phase boundary)
// ---------------------------------------------------------------------------

/** The object key a member's value node was stored under, when any. */
const keyMap = new WeakMap<ASTNode, string>();

// ---------------------------------------------------------------------------
// Position-preserving JSON parser
// ---------------------------------------------------------------------------

/** Byte offsets of each line start (line 1 = offset 0). */
function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** 1-based line/column for a byte offset, via binary search over line starts. */
function locationFor(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}

class JsonParseError extends Error {
  readonly location: SourceLocation;
  constructor(message: string, location: SourceLocation) {
    super(message);
    this.location = location;
  }
}

class JsonValueParser {
  private readonly starts: number[];
  private pos = 0;

  constructor(private readonly source: string) {
    this.starts = buildLineStarts(source);
  }

  /** Parse the whole document into a positioned value tree. */
  parse(): ASTNode {
    const root = this.parseValue();
    this.skipWs();
    if (this.pos !== this.source.length) {
      throw this.err('Unexpected token after JSON value', this.pos);
    }
    return root;
  }

  // -- cursor primitives ------------------------------------------------------

  private skipWs(): void {
    while (this.pos < this.source.length && this.isWhitespace(this.source[this.pos])) this.pos++;
  }

  private isWhitespace(ch: string): boolean {
    return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
  }

  private peek(): string {
    return this.source[this.pos] ?? '';
  }

  private err(message: string, at?: number): JsonParseError {
    const offset = at ?? this.pos;
    const start = offset;
    const end = Math.min(offset + 1, this.source.length);
    return new JsonParseError(message, {
      start: locationFor(this.starts, start),
      end: locationFor(this.starts, end),
    });
  }

  private makeNode(type: string, start: number, end: number, children?: ASTNode[]): ASTNode {
    const node: ASTNode = {
      type,
      range: [start, end],
      location: {
        start: locationFor(this.starts, start),
        end: locationFor(this.starts, end),
      },
    };
    if (children && children.length > 0) node.children = children;
    return node;
  }

  // -- values ------------------------------------------------------------------

  private parseValue(): ASTNode {
    this.skipWs();
    const ch = this.peek();
    switch (ch) {
      case '{': return this.parseObject();
      case '[': return this.parseArray();
      case '"': return this.parseStringValue().node;
      case 't':
      case 'f':
      case 'n':
        return this.parseLiteral();
      default:
        return this.parseNumber();
    }
  }

  private parseObject(): ASTNode {
    const start = this.pos;
    this.pos++; // consume '{'
    const children: ASTNode[] = [];
    this.skipWs();
    if (this.peek() === '}') {
      this.pos++;
      return this.makeNode('object', start, this.pos, children);
    }
    for (;;) {
      this.skipWs();
      if (this.peek() !== '"') throw this.err('Expected object key string');
      const key = this.parseStringValue();
      this.skipWs();
      if (this.peek() !== ':') throw this.err("Expected ':' after object key");
      this.pos++; // consume ':'
      const value = this.parseValue();
      keyMap.set(value, key.text);
      children.push(value);
      this.skipWs();
      const sep = this.peek();
      if (sep === ',') { this.pos++; continue; }
      if (sep === '}') { this.pos++; break; }
      throw this.err("Expected ',' or '}' in object");
    }
    return this.makeNode('object', start, this.pos, children);
  }

  private parseArray(): ASTNode {
    const start = this.pos;
    this.pos++; // consume '['
    const children: ASTNode[] = [];
    this.skipWs();
    if (this.peek() === ']') {
      this.pos++;
      return this.makeNode('array', start, this.pos, children);
    }
    for (;;) {
      const value = this.parseValue();
      children.push(value);
      this.skipWs();
      const sep = this.peek();
      if (sep === ',') { this.pos++; continue; }
      if (sep === ']') { this.pos++; break; }
      throw this.err("Expected ',' or ']' in array");
    }
    return this.makeNode('array', start, this.pos, children);
  }

  private parseStringValue(): { node: ASTNode; text: string } {
    const start = this.pos;
    this.pos++; // consume '"'
    let text = '';
    for (;;) {
      if (this.pos >= this.source.length) throw this.err('Unterminated string', start);
      const ch = this.source[this.pos];
      if (ch === '"') {
        this.pos++;
        break;
      }
      if (ch === '\\') {
        const esc = this.source[this.pos + 1];
        switch (esc) {
          case '"': text += '"'; break;
          case '\\': text += '\\'; break;
          case '/': text += '/'; break;
          case 'b': text += '\b'; break;
          case 'f': text += '\f'; break;
          case 'n': text += '\n'; break;
          case 'r': text += '\r'; break;
          case 't': text += '\t'; break;
          case 'u': {
            const hex = this.source.slice(this.pos + 2, this.pos + 6);
            text += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            throw this.err(`Invalid escape '\\${esc}'`, this.pos);
        }
        this.pos += 2;
        continue;
      }
      text += ch;
      this.pos++;
    }
    return { node: this.makeNode('string', start, this.pos), text };
  }

  private parseLiteral(): ASTNode {
    const start = this.pos;
    for (const [word, type] of [
      ['true', 'boolean'],
      ['false', 'boolean'],
      ['null', 'null'],
    ] as const) {
      if (this.source.startsWith(word, this.pos)) {
        this.pos += word.length;
        return this.makeNode(type, start, this.pos);
      }
    }
    throw this.err('Unexpected token');
  }

  private parseNumber(): ASTNode {
    const start = this.pos;
    if (this.peek() === '-') this.pos++;
    while (this.pos < this.source.length && /[0-9]/.test(this.source[this.pos])) this.pos++;
    if (this.peek() === '.') {
      this.pos++;
      while (this.pos < this.source.length && /[0-9]/.test(this.source[this.pos])) this.pos++;
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.pos++;
      if (this.peek() === '+' || this.peek() === '-') this.pos++;
      while (this.pos < this.source.length && /[0-9]/.test(this.source[this.pos])) this.pos++;
    }
    if (this.pos === start || (this.pos === start + 1 && this.source[start] === '-')) {
      throw this.err('Invalid number', start);
    }
    return this.makeNode('number', start, this.pos);
  }
}

// ---------------------------------------------------------------------------
// Synchronous parse entry point (shared by the adapter and the sync bridge)
// ---------------------------------------------------------------------------

/**
 * Position-preserving parse of a JSON document. Returns the root node and any
 * parse errors. A document that fails to parse still yields a synthetic `error`
 * root covering the whole file, so a consumer can always continue. Exported so
 * `adapterBridge` (the legacy synchronous facade) can parse `.json` correctly
 * instead of falling through to the tree-sitter TypeScript grammar.
 */
export function parseJsonSource(source: string): { root: ASTNode; errors: AST['errors'] } {
  const parser = new JsonValueParser(source);
  try {
    return { root: parser.parse(), errors: [] };
  } catch (err) {
    if (err instanceof JsonParseError) {
      return {
        root: {
          type: 'error',
          range: [0, source.length],
          location: {
            start: { line: 1, column: 1 },
            end: { line: 1, column: source.length + 1 },
          },
        },
        errors: [{ message: err.message, location: err.location, severity: 'error' }],
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * JSON adapter. Every program-construct method is a stub: JSON is data, not
 * code. The one real method is {@link parse}, which produces a positioned
 * value tree so the `schema-json` producer can read a schema object's fields
 * with their real line/column.
 */
export class JsonAdapter implements LanguageAdapter {
  readonly name = 'json';
  readonly fileExtensions = ['.json'];

  supportsFile(filePath: string): boolean {
    return filePath.toLowerCase().endsWith('.json');
  }

  async parse(filePath: string, content: string): Promise<AST> {
    const { root, errors } = parseJsonSource(content);
    return {
      root,
      language: 'json',
      filePath,
      errors,
      dispose: () => {},
    };
  }

  // -- AST navigation -------------------------------------------------------

  findNodes(ast: AST, pattern: NodePattern): ASTNode[] {
    const results: ASTNode[] = [];
    const visit = (node: ASTNode) => {
      if (this.matches(node, pattern)) results.push(node);
      if (node.children) for (const child of node.children) visit(child);
    };
    visit(ast.root);
    return results;
  }

  getParent(node: ASTNode): ASTNode | null {
    return node.parent ?? null;
  }

  getChildren(node: ASTNode): ASTNode[] {
    return node.children ?? [];
  }

  // -- Node information -----------------------------------------------------

  getNodeType(node: ASTNode): string {
    return node.type;
  }

  getNodeText(node: ASTNode, sourceCode: string): string {
    return sourceCode.slice(node.range[0], node.range[1]);
  }

  getNodeName(node: ASTNode): string | null {
    return keyMap.get(node) ?? null;
  }

  // -- Extraction (JSON has no code constructs) -----------------------------

  extractFunctions(_ast: AST): FunctionInfo[] { return []; }
  extractClasses(_ast: AST): ClassInfo[] { return []; }
  extractImports(_ast: AST): ImportInfo[] { return []; }
  extractExports(_ast: AST): ExportInfo[] { return []; }
  extractInterfaces(_ast: AST): InterfaceInfo[] { return []; }

  // -- Predicates (JSON has none of these) ----------------------------------

  isClass(_node: ASTNode): boolean { return false; }
  isFunction(_node: ASTNode): boolean { return false; }
  isMethod(_node: ASTNode): boolean { return false; }
  isLoop(_node: ASTNode): boolean { return false; }
  isVariableDeclaration(_node: ASTNode): boolean { return false; }

  // -- Advanced -------------------------------------------------------------

  getDocumentation(_node: ASTNode): string | null { return null; }
  getComplexity(_node: ASTNode): number { return 0; }

  private matches(node: ASTNode, pattern: NodePattern): boolean {
    if (pattern.type !== undefined) {
      const types = Array.isArray(pattern.type) ? pattern.type : [pattern.type];
      if (!types.includes(node.type)) return false;
    }
    if (pattern.name !== undefined) {
      const name = this.getNodeName(node);
      if (typeof pattern.name === 'string') {
        if (name !== pattern.name) return false;
      } else if (pattern.name instanceof RegExp) {
        if (name === null || !pattern.name.test(name)) return false;
      }
    }
    if (pattern.hasChild !== undefined) {
      if (!(node.children ?? []).some((c) => this.matches(c, pattern.hasChild!))) return false;
    }
    if (pattern.hasParent !== undefined) {
      if (!node.parent || !this.matches(node.parent, pattern.hasParent)) return false;
    }
    if (pattern.custom !== undefined) {
      if (!pattern.custom(node)) return false;
    }
    return true;
  }
}
