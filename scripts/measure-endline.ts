/**
 * AC5 measurement — prove `node.location.end.line` is the correct last line,
 * read-only. Parses files under src/languages, extracts every function-like
 * node, and compares `node.location.end.line` against the line number of the
 * node's end byte (`range[1]`) recomputed independently from the raw source.
 *
 * Usage (from app/):
 *   npx tsx scripts/measure-endline.ts
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import type { ASTNode } from '../src/languages/types.js';
import fs from 'node:fs';
import path from 'node:path';

const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'generator_function_declaration',
  'generator_function_expression',
  'method_definition',
  'arrow_function',
]);

const FILES = [
  'src/languages/adapterBridge.ts',
  'src/languages/tree-sitter/converter.ts',
  'src/languages/tree-sitter/parser.ts',
];

function lineNumberOfOffset(source: string, offset: number): number {
  // 1-based line number of the byte at `offset`.
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function functionName(node: ASTNode, source: string): string {
  // Best-effort name: the `name` child for declarations/methods, or the
  // variable declarator name for arrows assigned to a variable.
  const nameNode =
    node.children?.find((c) => c.type === 'name') ??
    node.children?.find((c) => c.type === 'property_identifier') ??
    null;
  if (nameNode && node.type !== 'arrow_function') {
    return source.slice(nameNode.range[0], nameNode.range[1]);
  }
  if (node.type === 'arrow_function' && node.parent) {
    const p = node.parent;
    if (p.type === 'variable_declarator') {
      const n = p.children?.find((c) => c.type === 'identifier');
      if (n) return source.slice(n.range[0], n.range[1]);
    }
    if (p.type === 'assignment_expression') {
      const n = p.children?.find((c) => c.type === 'identifier' || c.type === 'member_expression');
      if (n) return source.slice(n.range[0], n.range[1]);
    }
  }
  return '(anonymous)';
}

async function main() {
  initializeLanguages();
  await initParsers();
  const registry = LanguageRegistry.getInstance();

  const rows: Array<{
    file: string;
    name: string;
    start: number;
    locEnd: number;
    byteEnd: number;
    match: boolean;
  }> = [];

  for (const rel of FILES) {
    const filePath = path.resolve(rel);
    const adapter = registry.getAdapterForFile(filePath);
    if (!adapter) continue;
    const source = fs.readFileSync(filePath, 'utf8');
    const ast = await adapter.parse(filePath, source);
    if (!ast) continue;
    const fns = adapter.findNodes(ast, { custom: (n) => FUNCTION_NODE_TYPES.has(n.type) });
    for (const fn of fns) {
      const locEnd = fn.location.end.line;
      const byteEnd = lineNumberOfOffset(source, fn.range[1]);
      rows.push({
        file: path.basename(filePath),
        name: functionName(fn, source),
        start: fn.location.start.line,
        locEnd,
        byteEnd,
        match: locEnd === byteEnd,
      });
    }
    ast.dispose?.();
  }

  const matched = rows.filter((r) => r.match).length;
  console.log(`functions extracted: ${rows.length}`);
  console.log(`location.end.line == true last line: ${matched}`);
  console.log(`mismatches: ${rows.length - matched}`);
  console.log('');
  for (const r of rows.slice(0, 40)) {
    console.log(
      `${r.file}:${r.start}  ${r.name.padEnd(28)} start=${r.start} locEnd=${r.locEnd} byteEnd=${r.byteEnd} ${r.match ? 'OK' : 'MISMATCH'}`,
    );
  }
  if (rows.length > 40) console.log(`  … and ${rows.length - 40} more`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
