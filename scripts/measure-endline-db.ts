/**
 * AC5 measurement — populate `functions.end_line` via the audit pipeline
 * (indexFunctions: true), then print name/start_line/end_line so the stored
 * value can be diffed against the true last line from the source file.
 *
 * Usage (from app/):
 *   CODE_AUDITOR_DATA_DIR=/tmp/ca61-ac5-db npx tsx scripts/measure-endline-db.ts
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../src/auditRouter.js';
import { CodeIndexDB } from '../src/codeIndexDB.js';
import path from 'node:path';

const projectRoot = path.resolve('src/languages');

async function main() {
  initializeLanguages();
  await initParsers();
  const result = await runAuditDispatch({ projectRoot, indexFunctions: true } as any);

  const db = CodeIndexDB.getInstance(undefined, projectRoot);
  await db.initialize();
  const rows = db.db
    .prepare(
      `SELECT name, file_path, line_number, start_line, end_line, entity_type
         FROM functions
        WHERE end_line IS NOT NULL
        ORDER BY file_path, start_line`,
    )
    .all() as Array<{
    name: string;
    file_path: string;
    line_number: number;
    start_line: number;
    end_line: number;
    entity_type: string;
  }>;

  console.log(`functions with end_line in table: ${rows.length}`);
  console.log('');
  console.log('name | file | start_line | end_line | entity_type');
  for (const r of rows) {
    const file = path.basename(r.file_path);
    console.log(`${r.name} | ${file} | ${r.start_line} | ${r.end_line} | ${r.entity_type}`);
  }

  const analyzerCount = Object.keys((result as any).analyzerResults ?? {}).length;
  console.log(`\n(analyzerResults populated: ${analyzerCount})`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
