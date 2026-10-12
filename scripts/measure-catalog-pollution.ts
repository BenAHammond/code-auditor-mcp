/**
 * Measure the `defined-classes` catalog pollution + `styles/undefined-class`
 * finding count for one corpus, read-only.
 *
 * Piece 2 of the keyframe-pollution fix: the old `\.([a-zA-Z0-9_-]+)` selector
 * scrape admitted digit-leading names (a class selector can never start with a
 * digit) from keyframe percentages and decimal attribute selectors. This script
 * is the measurement half — it runs the full audit and reports:
 *
 *   - defined-class catalog size (DISTINCT class_name in style_defined_classes)
 *   - pollution count (catalog names starting with a digit)
 *   - polluted sample names
 *   - `styles/undefined-class` finding count
 *
 * Run BEFORE (HEAD) and AFTER (fix) against the same pinned corpus and diff the
 * pollution count.
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   CODE_AUDITOR_DATA_DIR=/tmp/ca-catalog-pollution \
 *     npx tsx scripts/measure-catalog-pollution.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAudit } from '../src/auditRunner.js';
import { CodeIndexDB } from '../src/codeIndexDB.js';
import type { Violation } from '../src/types.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { assertCorpusPinned } from './corpus-pins.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-catalog-pollution.ts <projectRoot>');
  process.exit(2);
}

function cleanupScratch(): void {
  const dir = process.env.CODE_AUDITOR_DATA_DIR?.trim();
  if (!dir) return;
  const resolved = path.resolve(dir);
  const tempRoots = [path.resolve(os.tmpdir()), '/tmp', '/private/tmp', '/var/tmp'];
  const isScratch = tempRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  if (!isScratch) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch {}
}

async function main() {
  initializeLanguages();
  await initParsers();

  assertCorpusPinned(projectRoot);

  const result = await runAudit({ projectRoot } as any);

  // undefined-class findings
  const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
    (r: any) => r.violations ?? [],
  );
  const uc = all.filter((v) => (v as any).rule === 'styles/undefined-class');

  // defined-classes catalog (persisted table — the same source the legacy
  // detector + adapters write and read)
  const db = CodeIndexDB.getInstance(undefined, projectRoot);
  await db.initialize();
  const rows = db.db
    .prepare('SELECT DISTINCT class_name FROM style_defined_classes')
    .all() as Array<{ class_name: string }>;
  const names = rows.map((r) => r.class_name);
  const polluted = names.filter((n) => /^\d/.test(n));
  const pollutedUnique = [...new Set(polluted)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  console.log(`\n=== catalog pollution: ${projectRoot} ===`);
  console.log(`defined-class catalog (DISTINCT class_name): ${names.length}`);
  console.log(`polluted (digit-leading) distinct: ${pollutedUnique.length}`);
  console.log(`polluted names: ${JSON.stringify(pollutedUnique)}`);
  console.log(`undefined-class findings: ${uc.length}`);
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => cleanupScratch());
