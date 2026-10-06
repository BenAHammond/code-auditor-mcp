/**
 * Item 1 evidence — dump, per file, every root the phase path proves `handle` via
 * R3 (the `sql-argument` arm) together with the SQL literal that actually proved
 * it. Reproduces the production build-side fold (`classifyBuildProvenance` →
 * `applyR3FromSites`) with the *empty* cross-file seed (the `sql-argument` arm is
 * what R3 contributes; the seed arrives separately from the receiver-provenance
 * fixed point). The proving literal for a root is the first R3 site, in walk
 * order, whose `sqlArgument` parses under the named dialect — a not-yet-proven
 * root can only reach `handle` through that parse (declaration-resolution is
 * `unproven` for an unproven root), so this is exactly the literal that flipped
 * the root. A root proven through the declaration-resolution cascade instead
 * (its receiver is a variable assigned from an already-proven DB handle) is
 * reported as `<cascade>` with no literal. Read-only.
 *
 * Usage:
 *   npx tsx scripts/measure-provenanced-roots.ts /path/to/corpus [--limit N]
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { buildBindingEnv } from '../src/analyzers/receiverRoot.js';
import { extractR3Sites, extractTsWithinFileProvenance } from '../src/analyzers/provenance.js';
import { classifyBuildProvenance } from '../src/phase/receiverProvenance.js';
import { parseSql, DEFAULT_SQL_DIALECT } from '../src/languages/sql/sqlAst.js';
import { readFile } from 'node:fs/promises';
import type { Dialect } from '../src/mcp-tools/discoveryQueries.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-provenanced-roots.ts <projectRoot> [--limit N]');
  process.exit(2);
}
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

async function main() {
  initializeLanguages();
  await initParsers();
  const registry = LanguageRegistry.getInstance();
  const files = await discoverFiles(projectRoot, { extensions: ALL_EXTENSIONS });

  const relOf = (p: string) => p.replace(projectRoot, '').replace(/^\//, '');
  let emitted = 0;

  for (const file of files) {
    if (file.endsWith('.sql')) continue;
    const adapter = registry.getAdapterForFile(file);
    if (!adapter) continue;
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    let ast;
    try {
      ast = await adapter.parse(file, content);
    } catch {
      continue;
    }
    try {
      const extract = extractTsWithinFileProvenance(ast, adapter, content);
      const bindings = buildBindingEnv(ast, adapter, content);
      const r3Sites = extractR3Sites(ast, adapter, content);
      if (r3Sites.length === 0) continue;
      const dbProvenanced = classifyBuildProvenance(extract, new Map(), bindings, r3Sites, null as Dialect | null);

      for (const [root, ev] of dbProvenanced) {
        if (ev.reason !== 'sql-argument') continue;
        // The first R3 site (walk order) whose literal parses under the named
        // dialect is the site that proved the root.
        const proving = r3Sites.find(
          (s) => s.root === root && s.sqlArgument !== null && parseSql(s.sqlArgument, DEFAULT_SQL_DIALECT).ok,
        );
        if (proving) {
          const kind = parseSql(proving.sqlArgument!, DEFAULT_SQL_DIALECT).kind ?? '?';
          console.log(`${relOf(file)}\t${root}\t${kind}\t${JSON.stringify(proving.sqlArgument).slice(0, 90)}`);
        } else {
          console.log(`${relOf(file)}\t${root}\t<cascade>\t`);
        }
        if (++emitted >= limit) return;
      }
    } finally {
      ast.dispose?.();
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
