/**
 * Measure seed timing + finding counts for one corpus, read-only.
 *
 * Spec 50 item 3 — settle the JSON-empty-source question with three seeds per
 * side and medians, not a single run. Prints the three contested metrics
 * (`auditDuration`, `stageTiming.read-cpu`, `stageTiming.stage3-reducers`) plus
 * total findings and the per-analyzer breakdown, so both the timing verdict and
 * the corpus-baseline confirmation (acceptance 6) come from one run.
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   CODE_AUDITOR_DATA_DIR=/tmp/code-auditor-seed \
 *     npx tsx scripts/measure-seed-timing.ts /path/to/corpus
 *
 * Writes nothing into the target project (read-only reference). The index DB
 * and ledger go to CODE_AUDITOR_DATA_DIR; scratch is deleted on exit.
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../src/auditRouter.js';
import type { Violation } from '../src/types.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-seed-timing.ts <projectRoot>');
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
    console.error(`[measure] cleaned scratch dir ${resolved}`);
  } catch {
    // best-effort
  }
}

async function main() {
  initializeLanguages();
  await initParsers();

  const result = await runAuditDispatch({ projectRoot } as any);

  const meta = result.metadata as any;
  const stageTiming: Record<string, number> = meta?.stageTiming ?? {};

  const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
    (r: any) => r.violations ?? [],
  );
  const byAnalyzer = new Map<string, number>();
  for (const v of all) byAnalyzer.set(v.analyzer, (byAnalyzer.get(v.analyzer) ?? 0) + 1);

  const fields = [
    ['auditDuration', meta?.auditDuration ?? 0],
    ['read-cpu', stageTiming['read-cpu'] ?? 0],
    ['stage3-reducers', stageTiming['stage3-reducers'] ?? 0],
    ['parse-cpu', stageTiming['parse-cpu'] ?? 0],
    ['stream-parse-visit', stageTiming['stream-parse-visit'] ?? 0],
    ['stage4-derived', stageTiming['stage4-derived'] ?? 0],
    ['filesAnalyzed', meta?.filesAnalyzed ?? 0],
    ['totalFindings', all.length],
  ];

  console.log('\n=== SEED TIMING ===');
  for (const [k, v] of fields) console.log(`${k}: ${v}`);
  console.log('\n--- per-analyzer ---');
  for (const [name, count] of [...byAnalyzer.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${name}: ${count}`);
  }
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => cleanupScratch());
