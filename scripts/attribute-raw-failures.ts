/**
 * Attribute the static `.raw()` SQL literals that fail to parse under the default
 * sqlite grammar (Spec 70 criterion 11 / Spec 68 board item). For each static
 * `.raw()` first argument, parse the dequoted literal text with `parseSql` and
 * split into `parse` vs `fail`. For the failures, dump the full text plus the
 * node-sql-parser reason so each can be classified "complete statement the grammar
 * rejected" vs "SQL fragment (correctly unproven)".
 *
 * Usage:
 *   npx tsx scripts/attribute-raw-failures.ts /path/to/corpus [out.json]
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { resolveCorpusReceivers } from '../src/analyzers/receiverResolution.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { getCallExpressionCallee, extractMemberExpressionProperty } from '../src/analyzers/provenance.js';
import { parseSql, DEFAULT_SQL_DIALECT } from '../src/languages/sql/sqlAst.js';
import type { ASTNode, LanguageAdapter } from '../src/languages/types.js';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: attribute-raw-failures.ts <projectRoot> [out.json]');
  process.exit(2);
}
const outPath = process.argv[3];

function hasInterpolation(node: ASTNode, adapter: LanguageAdapter): boolean {
  return adapter.getChildren(node).some((c) => c.type === 'template_substitution');
}

/** Dequote a `string` / static `template_string` node's source text. */
function literalSqlText(node: ASTNode, sourceCode: string): string | null {
  const raw = sourceCode.slice(node.range[0], node.range[1]);
  if (node.type === 'string') {
    // Strip the outer quote pair (single or double).
    if (raw.length >= 2 && (raw[0] === "'" || raw[0] === '"') && raw[raw.length - 1] === raw[0]) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  if (node.type === 'template_string') {
    if (raw.length >= 2 && raw[0] === '`' && raw[raw.length - 1] === '`') {
      return raw.slice(1, -1);
    }
    return raw;
  }
  return null;
}

async function main() {
  initializeLanguages();
  await initParsers();

  const report = await resolveCorpusReceivers(projectRoot);
  const rawSites = report.unprovenQueryReceivers.filter((s) => s.method.toLowerCase() === 'raw');
  console.log(`unproven .raw sites: ${rawSites.length}`);

  const byFile = new Map<string, typeof rawSites>();
  for (const s of rawSites) {
    const list = byFile.get(s.file) ?? [];
    list.push(s);
    byFile.set(s.file, list);
  }

  const registry = LanguageRegistry.getInstance();
  const parsed: Array<{ rel: string; line: number; sql: string }> = [];
  const failed: Array<{ rel: string; line: number; sql: string; reason: string }> = [];
  let dynamic = 0;
  let unmatched = 0;

  for (const [file, sites] of byFile) {
    const adapter = registry.getAdapterForFile(file);
    if (!adapter) { unmatched += sites.length; continue; }
    let ast;
    let content = '';
    try {
      content = await readFile(file, 'utf8');
      ast = await adapter.parse(file, content);
    } catch {
      unmatched += sites.length;
      continue;
    }
    const linesWanted = new Set(sites.map((s) => s.line));
    const calls = adapter.findNodes(ast, { custom: (n) => n.type === 'call_expression' });
    for (const node of calls) {
      if (!linesWanted.has(node.location.start.line)) continue;
      const callee = getCallExpressionCallee(node, adapter);
      if (!callee || callee.type !== 'member_expression') continue;
      const method = extractMemberExpressionProperty(callee, adapter, content);
      if (!method || method.toLowerCase() !== 'raw') continue;

      const argsNode = adapter.getChildren(node).find((c) => c.type === 'arguments');
      if (!argsNode) continue;
      const arg = adapter.getChildren(argsNode).find((c) => c.type !== '(' && c.type !== ')' && c.type !== ',');
      if (!arg) continue;

      let sql: string | null = null;
      if (arg.type === 'string') {
        sql = literalSqlText(arg, content);
      } else if (arg.type === 'template_string') {
        if (hasInterpolation(arg, adapter)) { dynamic++; continue; }
        sql = literalSqlText(arg, content);
      } else {
        // concatenation / variable / interpolated etc — not a static literal.
        dynamic++;
        continue;
      }
      if (sql === null) { dynamic++; continue; }

      const rel = file.replace(projectRoot, '').replace(/^\//, '');
      const result = parseSql(sql, DEFAULT_SQL_DIALECT);
      if (result.ok) {
        parsed.push({ rel, line: node.location.start.line, sql });
      } else {
        failed.push({ rel, line: node.location.start.line, sql, reason: result.reason });
      }
    }
  }

  console.log(`\n=== static .raw() SQL literal parse split (${projectRoot}) ===`);
  console.log(`parse (handle): ${parsed.length}`);
  console.log(`fail (unproven): ${failed.length}`);
  console.log(`dynamic (skipped): ${dynamic}`);
  if (unmatched) console.log(`unmatched (adapter/parse fail): ${unmatched}`);

  console.log(`\n--- ${failed.length} failures (file:line | SQL | reason) ---`);
  for (const f of failed) {
    const oneLine = f.sql.replace(/\s+/g, ' ').trim();
    console.log(`${f.rel}:${f.line}\t${oneLine}\t<< ${f.reason}`);
  }

  if (outPath) {
    await writeFile(outPath, JSON.stringify({ parsed, failed, dynamic, unmatched }, null, 2));
    console.log(`\nwrote ${outPath}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
