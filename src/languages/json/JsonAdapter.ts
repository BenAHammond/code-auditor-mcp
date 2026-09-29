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
 *
 * @param source The JSON source text to parse.
 * @returns The root node and any parse errors.
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
 * Depth-first node/pattern matcher. Extracted from `JsonAdapter.matches` so the
 * adapter stays under the class-size method ceiling; `findNodes` passes a
 * `getName` callback (bound to `getNodeName`) rather than `this`.
 */
function matchesNodePattern(
  node: ASTNode,
  pattern: NodePattern,
  getName: (n: ASTNode) => string | null,
): boolean {
  if (pattern.type !== undefined) {
    const types = Array.isArray(pattern.type) ? pattern.type : [pattern.type];
    if (!types.includes(node.type)) return false;
  }
  if (pattern.name !== undefined) {
    const name = getName(node);
    if (typeof pattern.name === 'string') {
      if (name !== pattern.name) return false;
    } else if (pattern.name instanceof RegExp) {
      if (name === null || !pattern.name.test(name)) return false;
    }
  }
  if (pattern.hasChild !== undefined) {
    if (!(node.children ?? []).some((c) => matchesNodePattern(c, pattern.hasChild!, getName))) return false;
  }
  if (pattern.hasParent !== undefined) {
    if (!node.parent || !matchesNodePattern(node.parent, pattern.hasParent, getName)) return false;
  }
  if (pattern.custom !== undefined) {
    if (!pattern.custom(node)) return false;
  }
  return true;
}

/**
 * JSON adapter. Every program-construct method is a stub: JSON is data, not
 * code. The one real method is {@link parse}, which produces a positioned
 * value tree so the `schema-json` producer can read a schema object's fields
 * with their real line/column.
 */
export class JsonAdapter implements LanguageAdapter {
  readonly name = 'json';
  readonly fileExtensions = ['.json'];

  /**
   * Whether this adapter handles the given file path.
   * @param filePath The path to check.
   * @returns True when the path ends in `.json`.
   */
  supportsFile(filePath: string): boolean {
    return filePath.toLowerCase().endsWith('.json');
  }

  /**
   * Parse a JSON file's content into a positioned AST.
   * @param filePath The path of the file being parsed.
   * @param content The JSON source text.
   * @returns A positioned AST with language, path, and parse errors.
   */
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

  /**
   * Find every node matching a pattern via a depth-first traversal.
   * @param ast The AST to search.
   * @param pattern The node pattern to match against.
   * @returns The list of matching nodes.
   */
  findNodes(ast: AST, pattern: NodePattern): ASTNode[] {
    const results: ASTNode[] = [];
    const visit = (node: ASTNode) => {
      if (matchesNodePattern(node, pattern, (n) => this.getNodeName(n))) results.push(node);
      if (node.children) for (const child of node.children) visit(child);
    };
    visit(ast.root);
    return results;
  }

  /**
   * Return the parent of a node, or null when it has none.
   * @param node The node to inspect.
   * @returns The parent node, or null.
   */
  getParent(node: ASTNode): ASTNode | null {
    return node.parent ?? null;
  }

  /**
   * Return the children of a node.
   * @param node The node to inspect.
   * @returns The node's children, or an empty array.
   */
  getChildren(node: ASTNode): ASTNode[] {
    return node.children ?? [];
  }

  // -- Node information -----------------------------------------------------

  /**
   * Return the type of a node.
   * @param node The node to inspect.
   * @returns The node's type.
   */
  getNodeType(node: ASTNode): string {
    return node.type;
  }

  /**
   * Return the source text covered by a node's range.
   * @param node The node to read.
   * @param sourceCode The full source text the node came from.
   * @returns The source slice covered by the node.
   */
  getNodeText(node: ASTNode, sourceCode: string): string {
    return sourceCode.slice(node.range[0], node.range[1]);
  }

  /**
   * Return the object key a node's value was stored under, when any.
   * @param node The node to inspect.
   * @returns The associated key, or null.
   */
  getNodeName(node: ASTNode): string | null {
    return keyMap.get(node) ?? null;
  }

  // -- Extraction (JSON has no code constructs) -----------------------------

  /**
   * JSON has no functions, so this always returns an empty list.
   * @param _ast The (unused) AST.
   * @returns An empty list.
   */
  extractFunctions(_ast: AST): FunctionInfo[] { return []; }
  /**
   * JSON has no classes, so this always returns an empty list.
   * @param _ast The (unused) AST.
   * @returns An empty list.
   */
  extractClasses(_ast: AST): ClassInfo[] { return []; }
  /**
   * JSON has no imports, so this always returns an empty list.
   * @param _ast The (unused) AST.
   * @returns An empty list.
   */
  extractImports(_ast: AST): ImportInfo[] { return []; }
  /**
   * JSON has no exports, so this always returns an empty list.
   * @param _ast The (unused) AST.
   * @returns An empty list.
   */
  extractExports(_ast: AST): ExportInfo[] { return []; }
  /**
   * JSON has no interfaces, so this always returns an empty list.
   * @param _ast The (unused) AST.
   * @returns An empty list.
   */
  extractInterfaces(_ast: AST): InterfaceInfo[] { return []; }

  // -- Predicates (JSON has none of these) ----------------------------------

  /**
   * JSON has no classes, so this always returns false.
   * @param _node The (unused) node.
   * @returns Always false.
   */
  isClass(_node: ASTNode): boolean { return false; }
  /**
   * JSON has no functions, so this always returns false.
   * @param _node The (unused) node.
   * @returns Always false.
   */
  isFunction(_node: ASTNode): boolean { return false; }
  /**
   * JSON has no methods, so this always returns false.
   * @param _node The (unused) node.
   * @returns Always false.
   */
  isMethod(_node: ASTNode): boolean { return false; }
  /**
   * JSON has no loops, so this always returns false.
   * @param _node The (unused) node.
   * @returns Always false.
   */
  isLoop(_node: ASTNode): boolean { return false; }
  /**
   * JSON has no variable declarations, so this always returns false.
   * @param _node The (unused) node.
   * @returns Always false.
   */
  isVariableDeclaration(_node: ASTNode): boolean { return false; }

  // -- Advanced -------------------------------------------------------------

  /**
   * JSON nodes carry no documentation, so this always returns null.
   * @param _node The (unused) node.
   * @returns Always null.
   */
  getDocumentation(_node: ASTNode): string | null { return null; }
  /**
   * JSON nodes have no complexity, so this always returns zero.
   * @param _node The (unused) node.
   * @returns Always zero.
   */
  getComplexity(_node: ASTNode): number { return 0; }
}
