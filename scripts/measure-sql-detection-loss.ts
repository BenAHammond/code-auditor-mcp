/**
 * Spec 70 R1 step 2a — the go/no-go number the parse-failure rate does not give.
 *
 * A parse failure only matters if the failing site currently produces a finding:
 * a literal the regex path reads and flags, that the AST path will instead
 * `cannot-fire`. This script joins the unparseable code-literal sites against the
 * *current* audit's findings on (file, line-span) and reports, per corpus and per
 * rule, how many findings live on sites node-sql-parser refuses.
 *
 * The join key is the call expression's line span: the audit's `DatabaseCall.line`
 * is the SQL-bearing string/template node's start line, which lies inside the call
 * expression, so a finding anchored to that call falls within [callStart, callEnd].
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   CODE_AUDITOR_DATA_DIR=/tmp/code-auditor-loss \
 *     npx tsx scripts/measure-sql-detection-loss.ts /path/to/corpus:dialect […]
 *
 * Read-only: writes nothing into the target; parses into memory only. The index
 * scratch under CODE_AUDITOR_DATA_DIR is deleted on exit (temp paths only).
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { findFiles } from '../src/utils/fileDiscovery.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import type { ASTNode, LanguageAdapter, AST } from '../src/languages/types.js';
import type { Dialect } from '../src/mcp-tools/discoveryQueries.js';
import { parseSql } from '../src/languages/sql/sqlAst.js';
import { runAudit } from '../src/auditRunner.js';
import type { Violation } from '../src/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const GO_STRING_LITERAL_TYPES = new Set(['interpreted_string_literal', 'raw_string_literal']);
const TS_STRING_LITERAL_TYPES = new Set(['string', 'template_string']);

const SQL_HEURISTIC =
  /^(?:SELECT\s+\S|WITH\s+\S|EXPLAIN|PRAGMA|VACUUM|BEGIN|COMMIT|ROLLBACK|TRUNCATE|GRANT|REVOKE|ANALYZE|ATTACH|DETACH|REINDEX|VALUES\s*\(|MERGE)\b|^(?:INSERT\s+(?:INTO|OR\b)|REPLACE\s+(?:INTO|OR\b)|UPDATE\s+\S+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|INDEX|UNIQUE|VIEW|TRIGGER|DATABASE|SCHEMA|TEMP|TEMPORARY)\b|ALTER\s+(?:TABLE|INDEX|VIEW)\b|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER|DATABASE|SCHEMA)\b)/i;

function looksLikeSql(text: string): boolean {
  return SQL_HEURISTIC.test(text.trim().replace(/^[\s;()]+/, ''));
}

function unquote(text: string): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'" || text[0] === '`')) {
    return text.slice(1, -1);
  }
  return text;
}

function argListType(adapter: LanguageAdapter): string {
  return adapter.name === 'go' ? 'argument_list' : 'arguments';
}

function stringTypes(adapter: LanguageAdapter): ReadonlySet<string> {
  return adapter.name === 'go' ? GO_STRING_LITERAL_TYPES : TS_STRING_LITERAL_TYPES;
}

interface Site {
  file: string;
  callStart: number;
  callEnd: number;
  text: string;
  reason: string;
}

/** The first string/template arg of a query-shaped call, plus its line span. */
function firstSqlArg(call: ASTNode, adapter: LanguageAdapter, sourceCode: string): { text: string; arg: ASTNode } | null {
  const children = adapter.getChildren(call);
  const callee = children.find((c) => c.type !== '(' && c.type !== ')' && c.type !== ',' && c.type !== 'arguments' && c.type !== 'argument_list');
  if (!callee) return null;
  if (callee.type !== 'member_expression' && callee.type !== 'selector_expression') return null;
  const argsNode = children.find((c) => c.type === argListType(adapter));
  if (!argsNode) return null;
  const types = stringTypes(adapter);
  for (const arg of adapter.getChildren(argsNode)) {
    if (arg.type === '(' || arg.type === ')' || arg.type === ',') continue;
    if (!types.has(arg.type)) return null;
    return { text: unquote(adapter.getNodeText(arg, sourceCode)), arg };
  }
  return null;
}

async function measureCorpus(projectRoot: string, dialect: Dialect): Promise<void> {
  const files = await findFiles(projectRoot);
  const registry = LanguageRegistry.getInstance();
  const sites: Site[] = [];
  let candidateCount = 0;

  for (const f of files) {
    if (f.includes('node_modules') || f.includes('/dist/') || f.includes('/build/')) continue;
    if (f.endsWith('.sql')) continue;
    const adapter = registry.getAdapterForFile(f);
    if (!adapter) continue;
    let content: string;
    try {
      content = await fs.readFile(f, 'utf-8');
    } catch {
      continue;
    }
    let ast: AST | null = null;
    try {
      ast = await adapter.parse(f, content);
    } catch {
      ast = null;
    }
    if (!ast) continue;
    const rel = path.relative(projectRoot, f);
    const calls = adapter.findNodes(ast, { custom: (n: ASTNode) => n.type === 'call_expression' });
    for (const call of calls) {
      const r = firstSqlArg(call, adapter, content);
      if (r === null) continue;
      if (r.text.includes('${')) continue;
      if (!looksLikeSql(r.text)) continue;
      candidateCount++;
      const parsed = parseSql(r.text, dialect);
      if (parsed.ok) continue;
      sites.push({
        file: rel,
        callStart: call.location.start.line,
        callEnd: call.location.end.line,
        text: r.text.slice(0, 120).replace(/\s+/g, ' '),
        reason: parsed.reason.split('\n')[0],
      });
    }
    ast.dispose?.();
  }

  const result = await runAudit({ projectRoot } as any);
  const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
    (r: any) => r.violations ?? [],
  );

  const byRule = new Map<string, number>();
  const hitSites: Site[] = [];
  for (const site of sites) {
    const matched: string[] = [];
    for (const v of all) {
      const vRel = v.file.startsWith(projectRoot)
        ? path.relative(projectRoot, v.file)
        : v.file;
      if (vRel !== site.file) continue;
      if (v.line === undefined) continue;
      if (v.line < site.callStart || v.line > site.callEnd) continue;
      const rule = `${v.analyzer ?? '?'}::${v.rule}`;
      matched.push(rule);
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    }
    if (matched.length > 0) hitSites.push(site);
  }

  console.log(`\n=== ${path.basename(projectRoot)}  (dialect: ${dialect}) ===`);
  console.log(`  unparseable code-literal sites: ${sites.length} (of ${candidateCount} candidates)`);
  console.log(`  sites currently producing >=1 finding: ${hitSites.length}`);
  if (byRule.size > 0) {
    console.log(`  findings on unparseable sites, by rule:`);
    for (const [rule, n] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${n.toString().padStart(4)}  ${rule}`);
    }
  }
  if (hitSites.length > 0) {
    console.log(`  sites with a finding (first ${Math.min(hitSites.length, 30)}):`);
    for (const s of hitSites.slice(0, 30)) {
      console.log(`    - ${s.file}:${s.callStart + 1}  ${JSON.stringify(s.text)}`);
    }
  }
}

function cleanupScratch(): void {
  const dir = process.env.CODE_AUDITOR_DATA_DIR?.trim();
  if (!dir) return;
  const resolved = path.resolve(dir);
  const tempRoots = [path.resolve(os.tmpdir()), '/tmp', '/private/tmp', '/var/tmp'];
  const isScratch = tempRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!isScratch) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    console.error(`[measure] cleaned scratch dir ${resolved}`);
  } catch {
    // best-effort
  }
}

async function main() {
  const specs = process.argv.slice(2);
  if (specs.length === 0) {
    console.error('usage: measure-sql-detection-loss.ts <projectRoot:dialect> […]');
    process.exit(2);
  }
  initializeLanguages();
  await initParsers();
  for (const spec of specs) {
    const idx = spec.lastIndexOf(':');
    const projectRoot = spec.slice(0, idx);
    const dialect = spec.slice(idx + 1) as Dialect;
    await measureCorpus(path.resolve(projectRoot), dialect);
  }
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => cleanupScratch());
