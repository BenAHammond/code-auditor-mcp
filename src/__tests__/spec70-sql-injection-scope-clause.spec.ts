/**
 * Spec 70 §10 — `sql-injection-risk` must not fire on parameterized scope clauses.
 *
 * The nine historical false positives are the tool's own `IndexHandle.query(sql,
 * params)` calls, whose SQL templates interpolate *scope fragments* rather than
 * values: `${fp.clause}` (a `?`-placeholder IN/LIKE clause), `${inList(types)}`
 * (a quoted-literal list of internal usage-type names), `${likeClauses.join(' OR
 * ')}` (a `used_imports LIKE ?` placeholder list), and `${andFileScope(fileScope)}`
 * (the same placeholder clause, keyword-wrapped). Every value — repository file
 * paths, the project root, validator package names — travels exclusively through
 * the second argument (`params`), which SQLite binds, never interpolates.
 *
 * The clearing signal is the *parameterized-call contract*, not a name list: a
 * `.query(sql, params)` / `.execute(sql, params)` call with a bind-parameter
 * second argument is the same eager-execution shape the rule already clears for
 * D1's `.all()`/`.first()`/`.run()` (see `isD1ConvenienceCall`). A single-argument
 * `.query(\`…${input}\`)` — the raw injection shape — stays flagged, because it
 * carries no bind argument and the interpolation is therefore a value, not a
 * structural fragment.
 *
 * These tests run the real `UniversalDataAccessAnalyzer` via `analyzeAST` (the
 * same harness as `awaitProvenance.spec.ts` / `nearMissGuards.spec.ts`) and assert
 * the scope-fragment interpolations produce zero `sql-injection-risk` findings
 * while a raw single-argument interpolation still fires.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers, initializeLanguages, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tsAdapter: LanguageAdapter;
let analyzer: UniversalDataAccessAnalyzer;
let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalDataAccessAnalyzer();
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-spec70-scope-'));
}, 30_000);

async function injectionFindings(code: string, name: string): Promise<any[]> {
  const filePath = join(tmpDir, `${name}.ts`);
  await writeFile(filePath, code, 'utf-8');
  const sourceCode = await readFile(filePath, 'utf-8');
  const ast = parseFile(filePath, sourceCode)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  const violations = (await (analyzer as any).analyzeAST(
    ast, tsAdapter, DEFAULT_DATA_ACCESS_CONFIG, sourceCode,
  )) as any[];
  return violations.filter((v) => v.rule === 'sql-injection-risk');
}

describe('Spec 70 §10 — parameterized scope clauses are not sql-injection', () => {
  it('clears ${fp.clause} (a ?-placeholder IN clause) + ${inList(types)} against a bind-param second arg', async () => {
    const code = `interface IndexHandle { query(sql: string, params?: string[]): any; }
interface FileScope { apply(c: string): { clause: string; params: string[] }; }
export function check(indexHandle: IndexHandle, scope: FileScope, types: string[]) {
  const fp = scope.apply('file_path');
  const inList = (t: string[]) => t.map((x) => "'" + x + "'").join(', ');
  return indexHandle.query(
    \`SELECT DISTINCT table_name FROM schema_usage WHERE usage_type IN (\${inList(types)}) \${fp.clause}\`,
    fp.params,
  );
}
`;
    expect(await injectionFindings(code, 'fp-clause')).toHaveLength(0);
  });

  it('clears ${andFileScope(fileScope)} (a keyword-wrapped placeholder clause)', async () => {
    const code = `interface IndexHandle { query(sql: string, params?: string[]): any; }
export function count(indexHandle: IndexHandle, fileScope: { clause: string } | null) {
  const andFileScope = (fs: { clause: string } | null) => fs ? ' AND ' + fs.clause : '';
  return indexHandle.query(
    \`SELECT DISTINCT file_path FROM functions WHERE file_path IS NOT NULL\${andFileScope(fileScope)}\`,
    fileScope?.params,
  );
}
`;
    expect(await injectionFindings(code, 'and-file-scope')).toHaveLength(0);
  });

  it('clears ${likeClauses.join(\' OR \')} (a placeholder list bound out-of-band)', async () => {
    const code = `interface IndexHandle { query(sql: string, params?: string[]): any; }
const PACKAGES = ['validator-a', 'validator-b'];
export function check(indexHandle: IndexHandle) {
  const likeClauses = PACKAGES.map(() => 'used_imports LIKE ?');
  return indexHandle.query(
    \`SELECT id FROM functions WHERE (origin IS NULL OR origin != 'query-builder') AND (\${likeClauses.join(' OR ')})\`,
    PACKAGES.map((p) => '%' + p + '%'),
  );
}
`;
    expect(await injectionFindings(code, 'like-clauses')).toHaveLength(0);
  });

  it('still flags a raw single-argument interpolation (positive control)', async () => {
    const code = `import mysql from 'mysql2/promise';
const connection = await mysql.createConnection({ host: 'localhost' });
export function search(id: string) {
  return connection.execute(\`SELECT * FROM t WHERE id = '\${id}'\`);
}
`;
    expect((await injectionFindings(code, 'raw')).length).toBeGreaterThanOrEqual(1);
  });
});
