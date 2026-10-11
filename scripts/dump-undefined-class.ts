/**
 * Sample the `styles/undefined-class` findings on one corpus (read-only) — the
 * disposition half of Spec 68 §3.2's "migrated-surface effect, flagged for
 * follow-up review". Prints every finding with its file, line, symbol (the
 * class name), and the near-miss suggestion, so a human can judge whether the
 * markup producer is surfacing real undefined classes or admitting classes it
 * cannot prove (dynamic values, variant-prefixed utilities, etc.).
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   CODE_AUDITOR_DATA_DIR=/tmp/ca-dump-uc \
 *     npx tsx scripts/dump-undefined-class.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAudit } from '../src/auditRunner.js';
import type { Violation } from '../src/types.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: dump-undefined-class.ts <projectRoot>');
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

  const result = await runAudit({ projectRoot } as any);
  const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
    (r: any) => r.violations ?? [],
  );
  const uc = all.filter((v) => (v as any).rule === 'styles/undefined-class');

  console.log(`=== undefined-class findings: ${uc.length} ===\n`);
  for (const v of uc) {
    console.log(`${path.relative(projectRoot, v.file)}:${v.line ?? '?'}  [${v.severity}]`);
    console.log(`    ${v.message}`);
  }
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => cleanupScratch());
