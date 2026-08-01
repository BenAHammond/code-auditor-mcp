/**
 * Measure standalone (HEAD) UniversalSchemaAnalyzer violation counts against recall-protocol.
 *
 * Usage: cd /Users/ben/playground/code-auditor/app && npx tsx scripts/measure-schema-baseline.ts
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { UniversalSchemaAnalyzer } from '../src/analyzers/universal/UniversalSchemaAnalyzer.js';
import { findFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { CodeIndexDB } from '../src/codeIndexDB.js';

const RECALL_PROTOCOL = '/Users/ben/playground/recall-protocol';

async function main() {
  // Phase 1: language init
  console.error('Initializing languages...');
  initializeLanguages();
  await initParsers();
  console.error('Languages initialized.');

  // Phase 2: discover all project files
  console.error('Discovering files...');
  const allFiles = await findFiles(RECALL_PROTOCOL, { extensions: ALL_EXTENSIONS });
  console.error(`Discovered ${allFiles.length} files.`);

  // Phase 3: load schemas from CodeIndexDB (matching HEAD auditRunner behavior)
  let schemas: unknown[] = [];
  try {
    const db = CodeIndexDB.getInstance(undefined, RECALL_PROTOCOL);
    await db.initialize();
    const loadedSchemas = await db.getAllSchemas();
    schemas = loadedSchemas.map((loaded) => {
      const schema = loaded.schema as { name: string; databases: Array<{ tables: Array<{ name: string; columns?: unknown[] }> }> };
      return {
        name: schema.name,
        tables: schema.databases.flatMap((database) =>
          database.tables.map((table) => ({
            name: table.name,
            columns: table.columns || [],
          }))
        ),
      };
    });
    console.error(`Loaded ${schemas.length} schemas from CodeIndexDB.`);
  } catch (err) {
    console.error('No schemas from CodeIndexDB (continuing):', err instanceof Error ? err.message : String(err));
  }

  // Phase 4: run standalone schema analyzer (matching HEAD auditRunner config)
  console.error('Running standalone schema analyzer...');
  const analyzer = new UniversalSchemaAnalyzer();

  const config: Record<string, unknown> = {
    checkMissingReferences: true,
    checkNamingConventions: true,
    detectUnusedTables: false,
    validateQueryPatterns: true,
    maxQueriesPerFunction: 5,
    requiredSchemas: [],
    schemas,
    validateJsonSchemas: true,
    projectRoot: RECALL_PROTOCOL,
  };

  const startTime = Date.now();
  const result = await analyzer.analyze(allFiles, config);
  const elapsed = Date.now() - startTime;

  // Phase 5: group violations by rule
  const byRule = new Map<string, number>();
  for (const v of result.violations) {
    const rule = v.rule || 'unknown';
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }

  // Phase 6: print results
  const sorted = [...byRule.entries()].sort((a, b) => b[1] - a[1]);
  console.log('\n=== SCHEMA VIOLATIONS BY RULE (standalone HEAD) ===');
  let total = 0;
  for (const [rule, count] of sorted) {
    console.log(`  ${rule}: ${count}`);
    total += count;
  }
  console.log(`  TOTAL: ${total}`);
  if (result.errors && result.errors.length > 0) {
    console.log(`  Errors: ${result.errors.length}`);
    for (const e of result.errors.slice(0, 10)) {
      console.log(`    ${e.file}: ${e.error}`);
    }
    if (result.errors.length > 10) console.log(`    ... and ${result.errors.length - 10} more`);
  }
  console.log(`  Elapsed: ${elapsed}ms`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
