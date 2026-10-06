/**
 * Spec 70 R1 step 2 — measure node-sql-parser's failure rate on real corpora
 * AFTER the declared input normalization (`?n` → `?`, multi-statement split,
 * transaction-control recognition) is in place, so the residual failure rate is
 * the honest `cannot-fire` surface (ON CONFLICT, Postgres casts, PL/pgSQL bodies).
 *
 * Extraction is the same population the regex→AST conversion will be handed: a
 * string/template literal that is the FIRST argument of a query-shaped call
 * (callee is a member/selector expression — `db.query("…")`, `knex.raw('…')`,
 * a `sql` tagged template), plus every `.sql` migration file. A leading-SQL-keyword
 * filter drops non-SQL string args (a table name, a config key) so the rate is a
 * *dialect* failure rate, not "everything a DB method is handed".
 *
 * `.sql` failures are split into template (`{{…}}` — not SQL until rendered) vs
 * unparseable (a dialect gap), so `{{VERSION}}` migrations do not inflate the
 * dialect failure rate.
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   npx tsx scripts/measure-sql-parse-failure.ts /path/to/corpus:dialect […]
 *
 * Read-only: writes nothing into the target; parses into memory only.
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { findFiles } from '../src/utils/fileDiscovery.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import type { ASTNode, LanguageAdapter, AST } from '../src/languages/types.js';
import type { Dialect } from '../src/mcp-tools/discoveryQueries.js';
import { parseSql, parseSqlProgram } from '../src/languages/sql/sqlAst.js';
import { stripSqlQuotes } from '../src/analyzers/sqlLiteral.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/** String/template literal node types per format (mirrors receiverResolution.ts). */
const GO_STRING_LITERAL_TYPES = new Set(['interpreted_string_literal', 'raw_string_literal']);
const TS_STRING_LITERAL_TYPES = new Set(['string', 'template_string']);

/**
 * A leading-SQL-statement classifier. Unambiguous statement verbs match bare;
 * verbs that double as English ("create", "update", "drop", "alter", "insert",
 * "delete") require a following SQL clause/object keyword so prose like
 * "update the config file" is not mistaken for SQL.
 */
const SQL_HEURISTIC =
  /^(?:SELECT\s+\S|WITH\s+\S|EXPLAIN|PRAGMA|VACUUM|BEGIN|COMMIT|ROLLBACK|TRUNCATE|GRANT|REVOKE|ANALYZE|ATTACH|DETACH|REINDEX|VALUES\s*\(|MERGE)\b|^(?:INSERT\s+(?:INTO|OR\b)|REPLACE\s+(?:INTO|OR\b)|UPDATE\s+\S+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(?:TABLE|INDEX|UNIQUE|VIEW|TRIGGER|DATABASE|SCHEMA|TEMP|TEMPORARY)\b|ALTER\s+(?:TABLE|INDEX|VIEW)\b|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER|DATABASE|SCHEMA)\b)/i;

function looksLikeSql(text: string): boolean {
  return SQL_HEURISTIC.test(text.trim().replace(/^[\s;()]+/, ''));
}

/** The argument-list node type for a call, per format. */
function argListType(adapter: LanguageAdapter): string {
  return adapter.name === 'go' ? 'argument_list' : 'arguments';
}

function stringTypes(adapter: LanguageAdapter): ReadonlySet<string> {
  return adapter.name === 'go' ? GO_STRING_LITERAL_TYPES : TS_STRING_LITERAL_TYPES;
}

/**
 * The first string/template literal argument of a query-shaped call, unquoted —
 * the exact population `extractSqlArgument` surfaces to `identifyHandle`. Returns
 * null when the callee is not a member/selector expression or the first argument
 * is not a plain literal.
 */
function firstSqlArgument(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const children = adapter.getChildren(node);
  const callee = children.find((c) => c.type !== '(' && c.type !== ')' && c.type !== ',' && c.type !== 'arguments' && c.type !== 'argument_list');
  if (!callee) return null;
  if (callee.type !== 'member_expression' && callee.type !== 'selector_expression') return null;
  const argsNode = children.find((c) => c.type === argListType(adapter));
  if (!argsNode) return null;
  const types = stringTypes(adapter);
  for (const arg of adapter.getChildren(argsNode)) {
    if (arg.type === '(' || arg.type === ')' || arg.type === ',') continue;
    if (!types.has(arg.type)) return null;
    return stripSqlQuotes(adapter.getNodeText(arg, sourceCode), { raw: arg.type === 'raw_string_literal' });
  }
  return null;
}

interface Failure {
  text: string;
  reason: string;
  file: string;
}

async function measureCorpus(projectRoot: string, dialect: Dialect): Promise<void> {
  const files = await findFiles(projectRoot);
  const registry = LanguageRegistry.getInstance();

  let sqlFileCount = 0;
  let sqlFileFailCount = 0;
  let sqlFileTemplateCount = 0;
  let sqlStatementCount = 0;

  let candidateCount = 0;
  let okCount = 0;
  let failCount = 0;
  let skippedInterpolated = 0;

  const codeFailures: Failure[] = [];
  const sqlFileFailures: Failure[] = [];
  const pushFailure = (bucket: Failure[], file: string, text: string, reason: string) => {
    if (bucket.length < 25) bucket.push({ file, text, reason });
  };

  for (const f of files) {
    if (f.includes('node_modules') || f.includes('/dist/') || f.includes('/build/')) continue;
    const rel = path.relative(projectRoot, f);

    if (f.endsWith('.sql')) {
      let content: string;
      try {
        content = await fs.readFile(f, 'utf-8');
      } catch {
        continue;
      }
      sqlFileCount++;
      const program = parseSqlProgram(content, dialect);
      if (program.ok) {
        sqlStatementCount += program.statements.length;
      } else if (program.reason.startsWith('templated migration')) {
        sqlFileTemplateCount++;
      } else {
        sqlFileFailCount++;
        // First non-comment, non-empty line is the actual SQL, not the header.
        const firstSql = content
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !l.startsWith('--'));
        pushFailure(sqlFileFailures, rel, (firstSql ?? content).slice(0, 120).replace(/\s+/g, ' '), program.reason);
      }
      continue;
    }

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

    const calls = adapter.findNodes(ast, { custom: (n: ASTNode) => n.type === 'call_expression' });
    for (const call of calls) {
      const arg = firstSqlArgument(call, adapter, content);
      if (arg === null) continue;
      if (arg.includes('${')) {
        skippedInterpolated++;
        continue;
      }
      if (!looksLikeSql(arg)) continue;
      candidateCount++;
      const parsed = parseSql(arg, dialect);
      if (parsed.ok) {
        okCount++;
      } else {
        failCount++;
        pushFailure(codeFailures, rel, arg.slice(0, 120).replace(/\s+/g, ' '), parsed.reason);
      }
    }
    ast.dispose?.();
  }

  const rate = candidateCount === 0 ? 0 : (failCount / candidateCount) * 100;
  console.log(`\n=== ${path.basename(projectRoot)}  (dialect: ${dialect}) ===`);
  console.log(`  code SQL literals:      ${candidateCount} candidates → ${okCount} ok / ${failCount} fail (${rate.toFixed(1)}% fail)`);
  console.log(`  interpolated templates: ${skippedInterpolated} (skipped — not static SQL)`);
  console.log(`  .sql files:             ${sqlFileCount} files / ${sqlStatementCount} statements; ${sqlFileFailCount} unparseable, ${sqlFileTemplateCount} templated (not SQL)`);
  if (codeFailures.length > 0) {
    console.log(`  failing CODE literals (first ${Math.min(codeFailures.length, 25)}):`);
    for (const f of codeFailures) {
      console.log(`    - ${f.file}\n      ${JSON.stringify(f.text)}\n      ↳ ${f.reason.split('\n')[0]}`);
    }
  }
  if (sqlFileFailures.length > 0) {
    console.log(`  failing .sql files (first ${Math.min(sqlFileFailures.length, 25)}):`);
    for (const f of sqlFileFailures) {
      console.log(`    - ${f.file}\n      ${JSON.stringify(f.text)}\n      ↳ ${f.reason.split('\n')[0]}`);
    }
  }
}

async function main() {
  const specs = process.argv.slice(2);
  if (specs.length === 0) {
    console.error('usage: measure-sql-parse-failure.ts <projectRoot:dialect> […]');
    console.error('  dialect ∈ postgresql | mysql | sqlite');
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

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
