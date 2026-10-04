/**
 * Measure the cross-domain rule counts across all six corpora, read-only.
 *
 * Spec 70 Item 4 (call-graph ← function-index, `usedImports` migration): the
 * three cross-domain rules that read the widened `call-graph` fact must be
 * count-unchanged on every corpus:
 *
 *   • `multi-table-write`      — 9 on recall-protocol, 0 (notApplicable) elsewhere.
 *   • `no-validator-reachable` — opt-in-gated → 0 on every corpus.
 *   • `uncovered-risk`         — opt-in-gated → 0 on every corpus.
 *
 * Writes nothing into any target project. Uses a throwaway data dir under /tmp.
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   CODE_AUDITOR_DATA_DIR=/tmp/ca-xdomain \
 *     npx tsx scripts/measure-cross-domain-counts.ts
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAudit } from '../src/auditRunner.js';
import type { Violation } from '../src/types.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const CORPORA = [
  '/Users/ben/playground/recall-protocol',
  '/Users/ben/playground/hhra-org',
  '/Users/ben/playground/endless-guessing',
  '/Users/ben/playground/blitz',
  '/Users/ben/playground/knex',
  '/Users/ben/playground/primer-css',
];

const WATCH = [
  'cross-domain/multi-table-write',
  'cross-domain/no-validator-reachable',
  'cross-domain/uncovered-risk',
];

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
  } catch {
    // best-effort
  }
}

async function main() {
  initializeLanguages();
  await initParsers();

  for (const projectRoot of CORPORA) {
    const name = path.basename(projectRoot);
    const result = await runAudit({ projectRoot } as any);

    const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
      (r: any) => r.violations ?? [],
    );
    const advisory = all.filter((v) => v.analyzer !== 'invariants');

    const counts = new Map<string, number>();
    for (const v of advisory) {
      if (v.analyzer !== 'cross-domain') continue;
      // The rule id already carries the `cross-domain/` prefix (e.g.
      // `cross-domain/multi-table-write`); `analyzer` is the namespace alone.
      const rule = (v as any).rule ?? (v as any).ruleId;
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }

    console.log(`\n=== ${name} (advisory ${advisory.length}) ===`);
    for (const w of WATCH) {
      console.log(`  ${w}: ${counts.get(w) ?? 0}`);
    }
  }
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => cleanupScratch());
