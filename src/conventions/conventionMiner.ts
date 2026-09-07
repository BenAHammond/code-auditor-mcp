/**
 * Spec 12 — Convention Mining
 *
 * Mines five domains of unwritten codebase conventions from the SQLite function
 * index. All mining runs on the existing `functions` and `function_calls` tables;
 * no new parsing infrastructure required.
 *
 * Domains:
 *   1. usage-pair    — calls that always co-occur (from function_calls table)
 *   2. import-form   — dominant import style per (source, directory)
 *   3. error-handling — dominant error-handling shape per directory
 *   4. export-shape  — dominant export style per directory
 *   5. naming        — dominant exported-symbol casing per directory
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import type { Node as TreeSitterNode } from 'web-tree-sitter';
import type { Convention, ConventionMiningConfig } from '../types.js';
import type { ExportInfo } from '../languages/types.js';
import { getParser, isInitialized } from '../languages/tree-sitter/parser.js';

// ─── Built-in / stdlib exclusion ──────────────────────────────────────────────

/**
 * Common built-in and standard-library method names excluded from usage-pair
 * mining (Spec 22 R5.2). Co-occurrence of universal methods is arithmetic, not
 * convention. The list is deliberately focused on JavaScript/TypeScript globals
 * that appear in every codebase; it does not attempt to be exhaustive.
 *
 * Antecedents must additionally be project-defined (resolvable in the function
 * index) — see mineUsagePairs.
 */
const BUILT_IN_CALLEES = new Set([
  // Array
  'map', 'filter', 'reduce', 'reduceRight', 'forEach', 'find', 'findIndex',
  'some', 'every', 'flat', 'flatMap', 'slice', 'splice', 'concat', 'push',
  'pop', 'shift', 'unshift', 'sort', 'reverse', 'includes', 'indexOf',
  'lastIndexOf', 'join', 'fill', 'copyWithin', 'keys', 'values', 'entries',
  'at', 'from', 'isArray', 'of',
  // String
  'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase',
  'charAt', 'charCodeAt', 'codePointAt', 'startsWith', 'endsWith',
  'split', 'substring', 'substr', 'replace', 'replaceAll',
  'match', 'matchAll', 'search', 'padStart', 'padEnd', 'repeat',
  'localeCompare',
  // Object / utility
  'hasOwnProperty', 'toString', 'valueOf', 'toLocaleString',
  'assign', 'freeze', 'seal', 'create',
  'getPrototypeOf', 'setPrototypeOf',
  'getOwnPropertyDescriptor', 'getOwnPropertyNames', 'getOwnPropertySymbols',
  'defineProperty', 'defineProperties',
  // Math
  'abs', 'ceil', 'floor', 'round', 'max', 'min', 'sqrt', 'pow', 'random',
  'sign', 'trunc', 'log', 'log2', 'log10', 'exp', 'sin', 'cos', 'tan',
  // JSON
  'parse', 'stringify',
  // Promise
  'then', 'catch', 'finally', 'all', 'allSettled', 'race', 'any',
  'resolve', 'reject',
  // Console
  'log', 'error', 'warn', 'info', 'debug', 'trace', 'dir', 'table',
  'group', 'groupEnd', 'assert', 'clear', 'count', 'countReset',
  'time', 'timeEnd', 'timeLog',
  // Timers / globals
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
  // Number / Boolean / RegExp
  'toFixed', 'toPrecision', 'toExponential',
  'exec', 'test',
  // Map / Set
  'has', 'get', 'set', 'delete', 'add', 'clear', 'size',
  // Error
  'captureStackTrace',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Escape regex special characters in a string. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Detect whether a string contains non-Latin-script characters (Spec 21 R5.4). */
export function hasNonLatinChars(name: string): boolean {
  // Latin script covers Basic Latin (U+0000–U+007F), Latin-1 Supplement
  // (U+0080–U+00FF), and Latin Extended-A/B (U+0100–U+024F). Allow digits,
  // underscores, and dollar signs as well.
  for (const ch of name) {
    const cp = ch.codePointAt(0)!;
    // Digits, underscore, dollar sign
    if (ch >= '0' && ch <= '9') continue;
    if (ch === '_' || ch === '$') continue;
    // Latin ranges
    if (cp >= 0x0041 && cp <= 0x005A) continue; // A–Z
    if (cp >= 0x0061 && cp <= 0x007A) continue; // a–z
    if (cp >= 0x00C0 && cp <= 0x024F) continue; // Latin-1 Supplement + Extended
    // Any character outside Latin ranges → non-Latin
    return true;
  }
  return false;
}

/** Classify a symbol name into a casing convention. Returns null for
 *  non-Latin, unclassifiable, or ambiguous names. */
export function detectCase(name: string): string | null {
  if (!name || name.length === 0) return null;
  if (hasNonLatinChars(name)) return null;

  // UPPER_SNAKE: all-uppercase with underscores (e.g. MAX_BUFFER_SIZE, DEBUG)
  if (/^[A-Z][A-Z0-9]*(_[A-Z][A-Z0-9]*)*$/.test(name)) return 'UPPER_SNAKE';

  // PascalCase: starts uppercase, no underscores or dashes (e.g. UserService)
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return 'PascalCase';

  // camelCase: starts lowercase, no underscores or dashes (e.g. useState)
  if (/^[a-z][a-zA-Z0-9]*$/.test(name)) return 'camelCase';

  // snake_case: all-lowercase with underscores (e.g. handle_click)
  if (/^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)*$/.test(name)) return 'snake_case';

  // kebab-case: all-lowercase with dashes (e.g. user-service)
  if (/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/.test(name)) return 'kebab-case';

  return null;
}

/**
 * Parse import statements from raw file content.
 *
 * Handles: import default, import named, import namespace, import side-effect,
 * require default, require destructured.
 * Multi-line imports supported via {}-accumulation.
 */
export function parseFileImports(
  content: string,
): Array<{ source: string; localNames: string[]; form: 'default' | 'named' | 'namespace' | 'side-effect' | 'require'; line: number }> {
  const results: Array<{
    source: string;
    localNames: string[];
    form: 'default' | 'named' | 'namespace' | 'side-effect' | 'require';
    line: number;
  }> = [];

  const lines = content.split('\n');
  let multiLineBuf: string | null = null;
  let multiLineStart: number = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    const lineNum = i + 1;

    // Skip comments and empty lines
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;

    // Handle multi-line imports
    if (multiLineBuf !== null) {
      multiLineBuf += ' ' + line;
      if (line.includes('}') || line.includes("'") || line.includes('"')) {
        line = multiLineBuf;
        multiLineBuf = null;
      } else {
        continue;
      }
    }

    // Detect multi-line import start: "import {" with no closing "}" and no "from" yet
    if (line.startsWith('import') && line.includes('{') && !line.includes('}') && !line.includes('from')) {
      multiLineBuf = line;
      multiLineStart = lineNum;
      continue;
    }

    const effectiveLine = multiLineStart > 0 ? multiLineStart : lineNum;
    multiLineStart = 0; // reset after use

    // import 'source' or import "source" (side-effect)
    const sideEffectMatch = line.match(/^import\s+['"]([^'"]+)['"]\s*;?\s*$/);
    if (sideEffectMatch) {
      results.push({ source: sideEffectMatch[1], localNames: [], form: 'side-effect', line: effectiveLine });
      continue;
    }

    // import * as Name from 'source' (namespace)
    const nsMatch = line.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (nsMatch) {
      results.push({ source: nsMatch[2], localNames: [nsMatch[1]], form: 'namespace', line: effectiveLine });
      continue;
    }

    // import DefaultName from 'source' (default)
    // import DefaultName, { ... } from 'source' (default + named) — classify as default
    const defaultMatch = line.match(
      /^import\s+(\w+)\s*,?\s*(?:\{[^}]*\})?\s*from\s+['"]([^'"]+)['"]/,
    );
    if (defaultMatch) {
      const namedPart = line.match(/\{([^}]+)\}/);
      const namedNames = namedPart
        ? namedPart[1]
            .split(',')
            .map((n) => n.trim().replace(/\s+as\s+\w+\s*$/, '').trim())
            .filter(Boolean)
        : [];
      const localNames = [defaultMatch[1]];
      // Strip "as" aliases (keep local name = what comes after "as", else the imported name)
      if (namedPart) {
        const resolved = namedPart[1].split(',').map((n) => {
          const trimmed = n.trim();
          const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
          return asMatch ? asMatch[2] : trimmed;
        }).filter(Boolean);
        localNames.push(...resolved);
      }
      results.push({ source: defaultMatch[2], localNames, form: 'default', line: effectiveLine });
      continue;
    }

    // import { X, Y } from 'source' (named only)
    const namedMatch = line.match(/^import\s+\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]/);
    if (namedMatch) {
      const names = namedMatch[1]
        .split(',')
        .map((n) => {
          const trimmed = n.trim();
          const asMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
          return asMatch ? asMatch[2] : trimmed;
        })
        .filter(Boolean);
      results.push({ source: namedMatch[2], localNames: names, form: 'named', line: effectiveLine });
      continue;
    }

    // const X = require('source') (require default)
    const reqDefMatch = line.match(
      /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
    );
    if (reqDefMatch) {
      results.push({ source: reqDefMatch[2], localNames: [reqDefMatch[1]], form: 'require', line: effectiveLine });
      continue;
    }

    // const { X, Y } = require('source') (require named)
    const reqNamedMatch = line.match(
      /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
    );
    if (reqNamedMatch) {
      const names = reqNamedMatch[1]
        .split(',')
        .map((n) => {
          const trimmed = n.trim();
          // Handle renaming: { foo: bar } → local name is 'bar'
          const colonMatch = trimmed.match(/^(\w+)\s*:\s*(\w+)$/);
          return colonMatch ? colonMatch[2] : trimmed;
        })
        .filter(Boolean);
      results.push({ source: reqNamedMatch[2], localNames: names, form: 'named', line: effectiveLine });
      continue;
    }
  }

  return results;
}

/**
 * Parse the export form for a specific exported function from AST-extracted
 * export data. Returns null if the function isn't found in the export list.
 */
export function detectExportForm(
  functionName: string,
  exports: ExportInfo[],
): 'default' | 'named' | null {
  const match = exports.find(e => e.name === functionName);
  if (!match) return null;
  return match.isDefault ? 'default' : 'named';
}

/**
 * Parse the export form from raw source text (regex-based fallback for mining
 * paths that don't have AST data available yet).
 */
function _detectExportFormFromSource(
  filePath: string,
  functionName: string,
  sourceCode: string,
): 'default' | 'named' | null {
  const content = sourceCode;

  const escaped = escapeRegex(functionName);

  // export default function Name / export default class Name / export default Name
  const defaultPatterns = [
    new RegExp(`export\\s+default\\s+(?:function|class|const|let|var)?\\s*${escaped}\\b`),
    new RegExp(`export\\s*\\{\\s*${escaped}\\s+as\\s+default\\s*\\}`),
    new RegExp(`export\\s+default\\s+\\{[^}]*\\b${escaped}\\b`), // export default { Name } (re-export)
  ];
  for (const pat of defaultPatterns) {
    if (pat.test(content)) return 'default';
  }

  // export function Name / export class Name / export const Name / export let Name / export var Name
  const namedDirect = new RegExp(`export\\s+(?:function|class|const|let|var)\\s+${escaped}\\b`);
  if (namedDirect.test(content)) return 'named';

  // export { Name } or export { Name as Alias }
  const namedList = new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`);
  if (namedList.test(content)) return 'named';

  return null;
}

/**
 * Detect the error-handling shape used in a function body.
 *
 * Returns null when the body has no error handling (function excluded from the
 * corpus for mode computation), or when it exhibits *more than one* distinct
 * shape — a multi-shape body cleanly exemplifies no single convention and must
 * not bias the dominant-shape histogram either way.
 *
 * Detection is structural (tree-sitter AST), not a first-match regex over raw
 * text:
 *   - `try-catch`     — a `catch_clause` (a real try/catch, not `try`/`finally`)
 *   - `promise-catch` — a `.catch(...)` call
 *   - `if-err`        — an `if` whose condition is a bare error-presence check
 *                       (`if (err)`, `if (!err)`, `if (err != null)`), not type
 *                       narrowing (`err instanceof Error`) or member access
 *
 * A string/comment containing `try {` or `if (err)` no longer registers, and a
 * body that mixes two shapes is no longer collapsed to whichever the regex
 * happened to see first.
 */
export function detectErrorHandlingShape(body: string | undefined | null): string | null {
  if (!body) return null;

  // AST-level detection requires the tree-sitter runtime. In a pure-DB context
  // where it is not yet initialised we cannot honestly classify the body, so
  // return null rather than fall back to a text proxy.
  if (!isInitialized()) return null;

  let root: TreeSitterNode;
  try {
    const parser = getParser('typescript');
    const tree = parser.parse(`async function __ca() ${body}`);
    if (!tree) return null;
    root = tree.rootNode;
  } catch {
    return null;
  }
  if (!root) return null;

  const shapes = new Set<string>();

  const walk = (node: TreeSitterNode): void => {
    switch (node.type) {
      case 'catch_clause':
        shapes.add('try-catch');
        break;
      case 'call_expression': {
        const callee = node.childForFieldName?.('function') ?? null;
        if (callee?.type === 'member_expression' && memberPropertyName(callee) === 'catch') {
          shapes.add('promise-catch');
        }
        break;
      }
      case 'if_statement': {
        if (conditionReferencesError(node)) shapes.add('if-err');
        break;
      }
    }
    for (const child of node.namedChildren) walk(child);
  };

  walk(root);

  if (shapes.size !== 1) return null; // no error handling, or ambiguous (multi-shape)
  return shapes.values().next().value ?? null;
}

/** The `property` field of a `member_expression` (`a.catch` → `catch`). */
function memberPropertyName(node: TreeSitterNode): string | null {
  const prop = node.childForFieldName?.('property') ?? null;
  return prop?.text ?? null;
}

/** Whether an `if_statement`'s condition is a bare error-presence check.
 *
 *  Recognises `if (err)`, `if (!err)`, and nil comparisons `if (err != null)` /
 *  `if (err === undefined)`. Type narrowing (`err instanceof Error`), member
 *  access (`err.message`), and near-miss identifiers (`errorMessage`) are NOT
 *  presence checks and must not register as `if-err`.
 */
function conditionReferencesError(ifNode: TreeSitterNode): boolean {
  const cond = ifNode.childForFieldName?.('condition') ?? null;
  if (!cond) return false;
  return isErrorPresenceCheck(cond);
}

/** `err` or `error`, the only identifiers we treat as an error value. */
function isErrorIdentifier(n: TreeSitterNode | null): boolean {
  return n?.type === 'identifier' && (n.text === 'err' || n.text === 'error');
}

/** A `null` literal or `undefined` identifier — the "nothing" side of a check. */
function isNilNode(n: TreeSitterNode | null): boolean {
  if (!n) return false;
  return n.type === 'null' || (n.type === 'identifier' && n.text === 'undefined');
}

/** Strip `parenthesized_expression` down to the expression it wraps. */
function unwrapParens(n: TreeSitterNode): TreeSitterNode {
  while (n.type === 'parenthesized_expression') {
    const inner = n.namedChildren[0];
    if (!inner) break;
    n = inner;
  }
  return n;
}

/** Whether the (already-unwrapped) condition node is an error-presence check. */
function isErrorPresenceCheck(n: TreeSitterNode): boolean {
  n = unwrapParens(n);

  // `if (err)` / `if (error)`
  if (isErrorIdentifier(n)) return true;

  // `if (!err)` / `if (!error)`
  if (n.type === 'unary_expression') {
    const op = n.childForFieldName?.('operator') ?? null;
    if (op?.text !== '!') return false;
    const arg = n.childForFieldName?.('argument') ?? null;
    return arg ? isErrorPresenceCheck(arg) : false;
  }

  // `if (err != null)` / `if (err === undefined)` — a nil comparison. Excludes
  // `err instanceof Error` (type narrowing) and `err.code === 'X'` (member access).
  if (n.type === 'binary_expression') {
    const op = n.childForFieldName?.('operator') ?? null;
    const opText = op?.text;
    if (opText !== '==' && opText !== '!=' && opText !== '===' && opText !== '!==') {
      return false;
    }
    const left = n.childForFieldName?.('left') ?? null;
    const right = n.childForFieldName?.('right') ?? null;
    return (isErrorIdentifier(left) && isNilNode(right)) ||
           (isErrorIdentifier(right) && isNilNode(left));
  }

  return false;
}

/** Compute MD5 hash for change detection. */
function computeHash(inputs: unknown[]): string {
  return crypto.createHash('md5').update(JSON.stringify(inputs)).digest('hex');
}

/** Cap the number of conventions per domain. */
function capPerDomain(conventions: Convention[], max: number): Convention[] {
  const byDomain = new Map<string, Convention[]>();
  for (const c of conventions) {
    const list = byDomain.get(c.domain) ?? [];
    list.push(c);
    byDomain.set(c.domain, list);
  }
  const result: Convention[] = [];
  for (const [, list] of byDomain) {
    result.push(...list.slice(0, max));
  }
  return result;
}

// ─── Domain Miners ───────────────────────────────────────────────────────────

/**
 * Mine `usage-pair` conventions.
 *
 * For each function F with call-set {A, B, C}, each call A is a potential
 * antecedent. For each antecedent A, find all functions that call A. Among
 * those, compute which other calls X co-occur with confidence ≥ pairConfidence
 * and support ≥ minCorpus.
 */
function mineUsagePairs(db: Database.Database, config: ConventionMiningConfig): Convention[] {
  const conventions: Convention[] = [];

  // Build per-function call sets
  const rows = db
    .prepare(
      `SELECT f.id, f.name as func_name, f.file_path, f.line_number,
              f.metadata_json
       FROM functions f`,
    )
    .all() as Array<{
    id: number;
    func_name: string;
    file_path: string;
    line_number: number;
    metadata_json: string | null;
  }>;

  // callerId -> Set<calleeName>
  const callSets = new Map<number, Set<string>>();
  const callRows = db
    .prepare(`SELECT caller_id, callee_name FROM function_calls`)
    .all() as Array<{ caller_id: number; callee_name: string }>;

  for (const cr of callRows) {
    if (!callSets.has(cr.caller_id)) callSets.set(cr.caller_id, new Set());
    callSets.get(cr.caller_id)!.add(cr.callee_name);
  }

  // Build a set of project-defined function names (antecedents must be
  // resolvable in the function index — Spec 22 R5.2).
  const projectSymbols = new Set<string>();
  for (const r of rows) {
    projectSymbols.add(r.func_name);
  }

  // For each unique callee (potential antecedent), find all callers
  // antecedentName -> Set<callerId>
  const antecedentCallers = new Map<string, Set<number>>();
  for (const cr of callRows) {
    if (!antecedentCallers.has(cr.callee_name)) antecedentCallers.set(cr.callee_name, new Set());
    antecedentCallers.get(cr.callee_name)!.add(cr.caller_id);
  }

  // For each antecedent A, among A-callers, compute co-occurring calls X.
  // Skip built-in/stdlib and non-project antecedents (Spec 22 R5.2).
  for (const [antecedent, callerIds] of antecedentCallers) {
    // Antecedent must be project-defined and not a built-in
    if (BUILT_IN_CALLEES.has(antecedent) || !projectSymbols.has(antecedent)) continue;

    const total = callerIds.size;
    if (total < config.minCorpus) continue;

    // Count how many A-callers also call each other function.
    // Skip built-in consequents — co-occurrence of universal methods is
    // arithmetic, not convention (Spec 22 R5.2).
    const coOccurCounts = new Map<string, number>();
    for (const cid of callerIds) {
      const callSet = callSets.get(cid);
      if (!callSet) continue;
      for (const callee of callSet) {
        if (callee === antecedent) continue;
        if (BUILT_IN_CALLEES.has(callee)) continue;
        coOccurCounts.set(callee, (coOccurCounts.get(callee) ?? 0) + 1);
      }
    }

    for (const [consequent, support] of coOccurCounts) {
      const confidence = support / total;
      if (confidence >= config.pairConfidence && support >= config.minCorpus) {
        // Find an exemplar: a function that calls both A and X
        let exemplarFile: string | null = null;
        let exemplarLine: number | null = null;
        for (const cid of callerIds) {
          const cs = callSets.get(cid);
          if (cs && cs.has(consequent)) {
            const funcRow = rows.find((r) => r.id === cid);
            if (funcRow) {
              exemplarFile = funcRow.file_path;
              exemplarLine = funcRow.line_number;
              break;
            }
          }
        }

        conventions.push({
          domain: 'usage-pair',
          rule_id: 'conventions/usage-pair',
          antecedent,
          consequent,
          pattern: null,
          directory: null,
          file_path: null,
          line: null,
          support,
          total_cases: total,
          confidence: Math.round(confidence * 10000) / 10000,
          exemplar_file: exemplarFile,
          exemplar_line: exemplarLine,
          hash: computeHash([antecedent, consequent, support, total]),
        });
      }
    }
  }

  return conventions;
}

/**
 * Mine `import-form` conventions.
 *
 * Per (source, directory) pair, compute the dominant import form. Reads source
 * files from disk to parse import statements, since import form data is not
 * persisted in the functions table.
 */
function mineImportForm(
  db: Database.Database,
  config: ConventionMiningConfig,
  projectRoot?: string,
  getSource?: (filePath: string) => string | undefined,
): Convention[] {
  const conventions: Convention[] = [];

  // Get unique (file_path, directory) pairs
  const rows = db
    .prepare(
      `SELECT DISTINCT file_path,
              substr(file_path, 1, length(file_path) - length(replace(file_path, '/', '')) - 1) as dir_part
       FROM functions
       WHERE file_path IS NOT NULL`,
    )
    .all() as Array<{ file_path: string; dir_part?: string }>;

  // Deduplicate files
  const seen = new Set<string>();
  // (source, directory) -> Map<form, count>
  const formCounts = new Map<string, Map<string, number>>();
  // (source, directory) -> exemplar
  const exemplars = new Map<string, { file: string; line: number; form: string }>();

  for (const row of rows) {
    if (seen.has(row.file_path)) continue;
    seen.add(row.file_path);

    const fullPath =
      projectRoot && !path.isAbsolute(row.file_path)
        ? path.join(projectRoot, row.file_path)
        : row.file_path;
    let content: string;
    const provided = getSource?.(row.file_path) ?? getSource?.(fullPath);
    if (provided !== undefined) {
      content = provided;
    } else {
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }
    }

    const directory = row.dir_part ? path.dirname(row.file_path) : '.';
    const imports = parseFileImports(content);

    for (const imp of imports) {
      const source = imp.source;
      const form = imp.form;

      const key = `${source}::${directory}`;
      if (!formCounts.has(key)) formCounts.set(key, new Map());
      const fc = formCounts.get(key)!;
      fc.set(form, (fc.get(form) ?? 0) + 1);

      // Track exemplar (first one wins)
      if (!exemplars.has(key)) {
        exemplars.set(key, { file: row.file_path, line: 0, form });
      }
    }
  }

  // For each (source, directory) pair, find dominant form
  for (const [key, fc] of formCounts) {
    const [source, directory] = key.split('::');
    const total = [...fc.values()].reduce((s, c) => s + c, 0);
    if (total < config.minCorpus) continue;

    // Find the mode (most common form)
    let maxCount = 0;
    let dominantForm = '';
    for (const [form, count] of fc) {
      if (count > maxCount) {
        maxCount = count;
        dominantForm = form;
      }
    }

    const modeShare = maxCount / total;
    if (modeShare >= config.modeShare && maxCount >= config.minCorpus) {
      // List the minority forms (for reference)
      const minorityForms = [...fc.entries()]
        .filter(([f]) => f !== dominantForm)
        .map(([f, c]) => `${f}:${c}`)
        .join(',');

      const exemplar = exemplars.get(key);

      conventions.push({
        domain: 'import-form',
        rule_id: 'conventions/import-form',
        antecedent: source,
        consequent: dominantForm,
        pattern: minorityForms || null,
        directory,
        file_path: null,
        line: null,
        support: maxCount,
        total_cases: total,
        confidence: Math.round(modeShare * 10000) / 10000,
        exemplar_file: exemplar?.file ?? null,
        exemplar_line: exemplar?.line ?? null,
        hash: computeHash([source, directory, dominantForm, maxCount, total]),
      });
    }
  }

  return conventions;
}

/**
 * Mine `error-handling` conventions.
 *
 * Per directory, compute the dominant error-handling shape among functions
 * that *have* error handling. Functions without any error handling are
 * excluded from the corpus and never flagged as deviants.
 */
function mineErrorHandling(
  db: Database.Database,
  config: ConventionMiningConfig,
): Convention[] {
  const conventions: Convention[] = [];

  const rows = db
    .prepare(
      `SELECT id, name, file_path, line_number, metadata_json
       FROM functions
       WHERE metadata_json IS NOT NULL`,
    )
    .all() as Array<{
    id: number;
    name: string;
    file_path: string;
    line_number: number;
    metadata_json: string;
  }>;

  // directory -> Map<shape, count>
  const dirShapes = new Map<string, Map<string, number>>();
  // directory -> exemplar info
  const dirExemplars = new Map<string, { file: string; line: number; shape: string }>();

  for (const row of rows) {
    let metadata: any;
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      continue;
    }

    const body: string | undefined = metadata.body;
    const shape = detectErrorHandlingShape(body);
    if (!shape) continue; // no error handling → skip

    const directory = path.dirname(row.file_path) || '.';
    if (!dirShapes.has(directory)) dirShapes.set(directory, new Map());
    const shapes = dirShapes.get(directory)!;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);

    if (!dirExemplars.has(directory)) {
      dirExemplars.set(directory, {
        file: row.file_path,
        line: row.line_number,
        shape,
      });
    }
  }

  for (const [directory, shapes] of dirShapes) {
    const total = [...shapes.values()].reduce((s, c) => s + c, 0);
    if (total < config.minCorpus) continue;

    let maxCount = 0;
    let dominantShape = '';
    for (const [shape, count] of shapes) {
      if (count > maxCount) {
        maxCount = count;
        dominantShape = shape;
      }
    }

    const modeShare = maxCount / total;
    if (modeShare >= config.modeShare && maxCount >= config.minCorpus) {
      const minorityShapes = [...shapes.entries()]
        .filter(([s]) => s !== dominantShape)
        .map(([s, c]) => `${s}:${c}`)
        .join(',');

      const exemplar = dirExemplars.get(directory);

      conventions.push({
        domain: 'error-handling',
        rule_id: 'conventions/error-handling',
        antecedent: null,
        consequent: null,
        pattern: dominantShape,
        directory,
        file_path: null,
        line: null,
        support: maxCount,
        total_cases: total,
        confidence: Math.round(modeShare * 10000) / 10000,
        exemplar_file: exemplar?.file ?? null,
        exemplar_line: exemplar?.line ?? null,
        hash: computeHash([directory, dominantShape, maxCount, total]),
      });
    }
  }

  return conventions;
}

/**
 * Mine `export-shape` conventions.
 *
 * Per directory, compute the dominant export style (default vs named) among
 * exported functions. Reads source files from disk to determine the export
 * form, since it is not stored in the functions table metadata.
 */
function mineExportShape(
  db: Database.Database,
  config: ConventionMiningConfig,
  projectRoot?: string,
  getSource?: (filePath: string) => string | undefined,
  getExports?: (filePath: string) => ExportInfo[] | undefined,
): Convention[] {
  const conventions: Convention[] = [];

  const rows = db
    .prepare(
      `SELECT id, name, file_path, line_number
       FROM functions
       WHERE is_exported = 1`,
    )
    .all() as Array<{
    id: number;
    name: string;
    file_path: string;
    line_number: number;
  }>;

  // directory -> Map<form, count>
  const dirForms = new Map<string, Map<string, number>>();
  const dirExemplars = new Map<string, { file: string; line: number; form: string }>();

  for (const row of rows) {
    // B2: Use AST-extracted exports when available (pipeline audit path),
    // fall back to source-code regex parsing for mining runs that lack AST data.
    const fileExports = getExports?.(row.file_path);
    let form: 'default' | 'named' | null;
    if (fileExports) {
      form = detectExportForm(row.name, fileExports);
    } else {
      const fullPath =
        projectRoot && !path.isAbsolute(row.file_path)
          ? path.join(projectRoot, row.file_path)
          : row.file_path;
      let content: string;
      const provided = getSource?.(row.file_path) ?? getSource?.(fullPath);
      if (provided !== undefined) {
        content = provided;
      } else {
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch {
          continue;
        }
      }
      form = _detectExportFormFromSource(fullPath, row.name, content);
    }
    if (!form) continue;

    const directory = path.dirname(row.file_path) || '.';
    if (!dirForms.has(directory)) dirForms.set(directory, new Map());
    const forms = dirForms.get(directory)!;
    forms.set(form, (forms.get(form) ?? 0) + 1);

    if (!dirExemplars.has(directory)) {
      dirExemplars.set(directory, {
        file: row.file_path,
        line: row.line_number,
        form,
      });
    }
  }

  for (const [directory, forms] of dirForms) {
    const total = [...forms.values()].reduce((s, c) => s + c, 0);
    if (total < config.minCorpus) continue;

    let maxCount = 0;
    let dominantForm = '';
    for (const [form, count] of forms) {
      if (count > maxCount) {
        maxCount = count;
        dominantForm = form;
      }
    }

    const modeShare = maxCount / total;
    if (modeShare >= config.modeShare && maxCount >= config.minCorpus) {
      const minorityForms = [...forms.entries()]
        .filter(([f]) => f !== dominantForm)
        .map(([f, c]) => `${f}:${c}`)
        .join(',');

      const exemplar = dirExemplars.get(directory);

      conventions.push({
        domain: 'export-shape',
        rule_id: 'conventions/export-shape',
        antecedent: null,
        consequent: null,
        pattern: dominantForm,
        directory,
        file_path: null,
        line: null,
        support: maxCount,
        total_cases: total,
        confidence: Math.round(modeShare * 10000) / 10000,
        exemplar_file: exemplar?.file ?? null,
        exemplar_line: exemplar?.line ?? null,
        hash: computeHash([directory, dominantForm, maxCount, total]),
      });
    }
  }

  return conventions;
}

/**
 * Classify a function into its export kind for naming-convention partitioning.
 *
 *   - react-component: entity_type = 'component' (JSX-returning / PascalCase React entities)
 *   - hook:            name starts with "use" followed by uppercase (e.g. useState, useAuth)
 *   - function:        everything else
 *
 * Constants (top-level literal-initialized) are not stored in the functions table
 * and therefore produce no population — permitted per Spec 22 R5.1.
 */
function classifyExportKind(row: {
  name: string;
  entity_type: string;
  component_type: string | null;
}): 'react-component' | 'hook' | 'function' {
  if (row.entity_type === 'component' || row.component_type !== null) {
    return 'react-component';
  }
  // Hook: starts with "use" followed by uppercase letter
  if (/^use[A-Z]/.test(row.name)) {
    return 'hook';
  }
  return 'function';
}

/**
 * Mine `naming` conventions.
 *
 * Per (directory, export_kind), compute the dominant casing convention for
 * exported symbols. Non-Latin identifiers are excluded (Spec 21 R5.4).
 *
 * Spec 22 R5.1: populations are partitioned by export kind before computing
 * a mode. A directory's convention is computed per kind; kinds with sub-
 * minCorpus populations produce nothing.
 */
function mineNaming(db: Database.Database, config: ConventionMiningConfig): Convention[] {
  const conventions: Convention[] = [];

  const rows = db
    .prepare(
      `SELECT id, name, file_path, line_number, entity_type, component_type
       FROM functions
       WHERE is_exported = 1`,
    )
    .all() as Array<{
    id: number;
    name: string;
    file_path: string;
    line_number: number;
    entity_type: string;
    component_type: string | null;
  }>;

  // directory -> export_kind -> Map<case, count>
  type KindCasingMap = Map<string, Map<string, number>>;
  const dirKindCases = new Map<string, KindCasingMap>();
  // directory -> export_kind -> exemplar
  type KindExemplarMap = Map<string, { file: string; line: number; casing: string }>;
  const dirKindExemplars = new Map<string, KindExemplarMap>();

  for (const row of rows) {
    const casing = detectCase(row.name);
    if (!casing) continue; // non-Latin or unclassifiable → skip

    const kind = classifyExportKind(row);
    const directory = path.dirname(row.file_path) || '.';

    if (!dirKindCases.has(directory)) dirKindCases.set(directory, new Map());
    const kindCases = dirKindCases.get(directory)!;
    if (!kindCases.has(kind)) kindCases.set(kind, new Map());
    const cases = kindCases.get(kind)!;
    cases.set(casing, (cases.get(casing) ?? 0) + 1);

    if (!dirKindExemplars.has(directory)) dirKindExemplars.set(directory, new Map());
    const kindExemplars = dirKindExemplars.get(directory)!;
    if (!kindExemplars.has(kind)) {
      kindExemplars.set(kind, {
        file: row.file_path,
        line: row.line_number,
        casing,
      });
    }
  }

  for (const [directory, kindCases] of dirKindCases) {
    const kindExemplars = dirKindExemplars.get(directory)!;

    for (const [kind, cases] of kindCases) {
      const total = [...cases.values()].reduce((s, c) => s + c, 0);
      if (total < config.minCorpus) continue;

      let maxCount = 0;
      let dominantCase = '';
      for (const [casing, count] of cases) {
        if (count > maxCount) {
          maxCount = count;
          dominantCase = casing;
        }
      }

      const modeShare = maxCount / total;
      if (modeShare >= config.modeShare && maxCount >= config.minCorpus) {
        const exemplar = kindExemplars.get(kind);

        conventions.push({
          domain: 'naming',
          rule_id: 'conventions/naming',
          antecedent: null,
          consequent: null,
          pattern: dominantCase,
          directory,
          file_path: null,
          line: null,
          support: maxCount,
          total_cases: total,
          confidence: Math.round(modeShare * 10000) / 10000,
          exemplar_file: exemplar?.file ?? null,
          exemplar_line: exemplar?.line ?? null,
          export_kind: kind,
          hash: computeHash([directory, kind, dominantCase, maxCount, total]),
        });
      }
    }
  }

  return conventions;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute a content hash of the miner inputs for change detection.
 * Callers can store this in the meta table to skip re-mining when unchanged.
 */
/**
 * Increment this when the miner algorithm changes (new domains, new logic,
 * threshold changes not captured by ConventionMiningConfig). The version is
 * folded into the skip-hash so that miner upgrades force re-mining rather
 * than silently reusing stale results from the old algorithm.
 */
export const MINER_VERSION = 2;

/**
 * Compute a content hash of the miner inputs for change detection.
 * Callers can store this in the meta table to skip re-mining when unchanged.
 * Includes MINER_VERSION so that algorithm changes force a re-mine.
 */
export function computeMinerInputHash(
  db: Database.Database,
  config: ConventionMiningConfig,
): string {
  // Hash actual content — not just counts — so two corpora with identical
  // counts but different functions produce different hashes and are mined.
  const rows = db.prepare(
    'SELECT name, content_hash, COALESCE(body, \'\') as body, COALESCE(signature, \'\') as signature FROM functions ORDER BY name, content_hash'
  ).all() as Array<{ name: string; content_hash: string; body: string; signature: string }>;
  const callRows = db.prepare(
    'SELECT fc.callee_name FROM function_calls fc ORDER BY fc.callee_name'
  ).all() as Array<{ callee_name: string }>;

  return computeHash([
    MINER_VERSION,
    rows.map(r => [r.name, r.content_hash, r.signature.length, r.body.length]),
    callRows.map(r => r.callee_name),
    config,
  ]);
}

/**
 * Mine all five convention domains from the SQLite index.
 *
 * @param db           The better-sqlite3 database instance.
 * @param config       Threshold configuration for the miner.
 * @param projectRoot  Optional project root — required for import-form and
 *                     export-shape mining to resolve file paths.
 * @returns Array of mined conventions (uncapped — caller should upsert).
 */
export function mineConventions(
  db: Database.Database,
  config: ConventionMiningConfig,
  projectRoot?: string,
  getSource?: (filePath: string) => string | undefined,
  getExports?: (filePath: string) => ExportInfo[] | undefined,
): Convention[] {
  const conventions: Convention[] = [];

  // 1. Usage Pairs
  conventions.push(...mineUsagePairs(db, config));

  // 2. Import Form (reads files from disk unless getSource provided)
  conventions.push(...mineImportForm(db, config, projectRoot, getSource));

  // 3. Error Handling
  conventions.push(...mineErrorHandling(db, config));

  // 4. Export Shape (reads files from disk unless getSource provided;
  //    B2: getExports enables AST-based export-form detection via function-index facts)
  conventions.push(...mineExportShape(db, config, projectRoot, getSource, getExports));

  // 5. Naming
  conventions.push(...mineNaming(db, config));

  // Cap per domain
  return capPerDomain(conventions, config.maxConventionsPerDomain);
}
