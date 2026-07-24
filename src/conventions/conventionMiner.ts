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
import type { Convention, ConventionMiningConfig } from '../types.js';

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
): Array<{ source: string; localNames: string[]; form: 'default' | 'named' | 'namespace' | 'side-effect' | 'require' }> {
  const results: Array<{
    source: string;
    localNames: string[];
    form: 'default' | 'named' | 'namespace' | 'side-effect' | 'require';
  }> = [];

  const lines = content.split('\n');
  let multiLineBuf: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

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
      continue;
    }

    // import 'source' or import "source" (side-effect)
    const sideEffectMatch = line.match(/^import\s+['"]([^'"]+)['"]\s*;?\s*$/);
    if (sideEffectMatch) {
      results.push({ source: sideEffectMatch[1], localNames: [], form: 'side-effect' });
      continue;
    }

    // import * as Name from 'source' (namespace)
    const nsMatch = line.match(/^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (nsMatch) {
      results.push({ source: nsMatch[2], localNames: [nsMatch[1]], form: 'namespace' });
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
      results.push({ source: defaultMatch[2], localNames, form: 'default' });
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
      results.push({ source: namedMatch[2], localNames: names, form: 'named' });
      continue;
    }

    // const X = require('source') (require default)
    const reqDefMatch = line.match(
      /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
    );
    if (reqDefMatch) {
      results.push({ source: reqDefMatch[2], localNames: [reqDefMatch[1]], form: 'require' });
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
      results.push({ source: reqNamedMatch[2], localNames: names, form: 'named' });
      continue;
    }
  }

  return results;
}

/**
 * Parse the export form for a specific exported function from its source file.
 * Returns null if we can't determine the form.
 */
export function detectExportForm(
  filePath: string,
  functionName: string,
): 'default' | 'named' | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

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
 * Returns null if no error handling is present (function should not be counted
 * in the corpus for mode computation).
 */
export function detectErrorHandlingShape(body: string | undefined | null): string | null {
  if (!body) return null;

  if (/\btry\s*\{/.test(body)) return 'try-catch';
  if (/\.catch\s*\(/.test(body)) return 'promise-catch';
  if (/\bif\s*\(\s*err/.test(body)) return 'if-err';
  if (/\b\.success\b/.test(body)) return 'go-style';

  return null;
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

  // For each unique callee (potential antecedent), find all callers
  // antecedentName -> Set<callerId>
  const antecedentCallers = new Map<string, Set<number>>();
  for (const cr of callRows) {
    if (!antecedentCallers.has(cr.callee_name)) antecedentCallers.set(cr.callee_name, new Set());
    antecedentCallers.get(cr.callee_name)!.add(cr.caller_id);
  }

  // For each antecedent A, among A-callers, compute co-occurring calls X
  for (const [antecedent, callerIds] of antecedentCallers) {
    const total = callerIds.size;
    if (total < config.minCorpus) continue;

    // Count how many A-callers also call each other function
    const coOccurCounts = new Map<string, number>();
    for (const cid of callerIds) {
      const callSet = callSets.get(cid);
      if (!callSet) continue;
      for (const callee of callSet) {
        if (callee === antecedent) continue;
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

    const fullPath = projectRoot ? path.join(projectRoot, row.file_path) : row.file_path;
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
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
    const fullPath = projectRoot ? path.join(projectRoot, row.file_path) : row.file_path;
    const form = detectExportForm(fullPath, row.name);
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
 * Mine `naming` conventions.
 *
 * Per directory, compute the dominant casing convention for exported symbols.
 * Non-Latin identifiers are excluded (Spec 21 R5.4).
 */
function mineNaming(db: Database.Database, config: ConventionMiningConfig): Convention[] {
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

  // directory -> Map<case, count>
  const dirCases = new Map<string, Map<string, number>>();
  const dirExemplars = new Map<string, { file: string; line: number; casing: string }>();

  for (const row of rows) {
    const casing = detectCase(row.name);
    if (!casing) continue; // non-Latin or unclassifiable → skip

    const directory = path.dirname(row.file_path) || '.';
    if (!dirCases.has(directory)) dirCases.set(directory, new Map());
    const cases = dirCases.get(directory)!;
    cases.set(casing, (cases.get(casing) ?? 0) + 1);

    if (!dirExemplars.has(directory)) {
      dirExemplars.set(directory, {
        file: row.file_path,
        line: row.line_number,
        casing,
      });
    }
  }

  for (const [directory, cases] of dirCases) {
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
      const minorityCases = [...cases.entries()]
        .filter(([c]) => c !== dominantCase)
        .map(([c, n]) => `${c}:${n}`)
        .join(',');

      const exemplar = dirExemplars.get(directory);

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
        hash: computeHash([directory, dominantCase, maxCount, total]),
      });
    }
  }

  return conventions;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Compute a content hash of the miner inputs for change detection.
 * Callers can store this in the meta table to skip re-mining when unchanged.
 */
export function computeMinerInputHash(
  db: Database.Database,
  config: ConventionMiningConfig,
): string {
  const funcCount = (
    db.prepare('SELECT COUNT(*) as c FROM functions').get() as { c: number }
  ).c;
  const callCount = (
    db.prepare('SELECT COUNT(*) as c FROM function_calls').get() as { c: number }
  ).c;

  return computeHash([funcCount, callCount, config]);
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
): Convention[] {
  const conventions: Convention[] = [];

  // 1. Usage Pairs
  conventions.push(...mineUsagePairs(db, config));

  // 2. Import Form (reads files from disk)
  conventions.push(...mineImportForm(db, config, projectRoot));

  // 3. Error Handling
  conventions.push(...mineErrorHandling(db, config));

  // 4. Export Shape (reads files from disk)
  conventions.push(...mineExportShape(db, config, projectRoot));

  // 5. Naming
  conventions.push(...mineNaming(db, config));

  // Cap per domain
  return capPerDomain(conventions, config.maxConventionsPerDomain);
}
