/**
 * Measure per-analyzer / per-rule advisory finding counts for one corpus, read-only.
 *
 * Spec 44 item 6 — re-pin the corpus baselines after the rule rework. This
 * script is the measurement half: it runs the full audit against one project
 * and prints per-analyzer totals plus a per-rule breakdown, so the post-rework
 * counts can be diffed against the pre-rework committed baselines and every
 * delta attributed to a named cause.
 *
 * Usage:
 *   cd /Users/ben/playground/code-auditor/app
 *   CODE_AUDITOR_DATA_DIR=/tmp/code-auditor-corpus \
 *     npx tsx scripts/measure-corpus-counts.ts /path/to/corpus
 *
 * Writes nothing into the target project. The index DB and ledger go to
 * CODE_AUDITOR_DATA_DIR (elsewhere), and no report file is emitted — only
 * stdout. The target is read as read-only reference.
 *
 * The scratch dir in CODE_AUDITOR_DATA_DIR is deleted on exit when it resolves
 * under a temp location (/tmp, /private/tmp, /var/tmp, os.tmpdir()) — repeated
 * measurement runs used to accumulate GBs of index/ledger scratch in
 * `/tmp/ca-corpus-*` and fill the disk (see spec-46 *Disk hygiene* note). A
 * non-temp data dir is a real project index and is never touched.
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
  console.error('usage: measure-corpus-counts.ts <projectRoot>');
  process.exit(2);
}

/**
 * Delete the measurement scratch dir after a run. Only ever deletes a directory
 * under a temp location — the `CODE_AUDITOR_DATA_DIR` the usage block points at.
 * A non-temp data dir is a real project index and is left untouched.
 */
function cleanupScratch(): void {
  const dir = process.env.CODE_AUDITOR_DATA_DIR?.trim();
  if (!dir) return; // unset → shared default (node_modules/.cache); never delete.
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
    // Best-effort: a lingering scratch dir is an annoyance, not a failure.
  }
}

async function main() {
  initializeLanguages();
  await initParsers();

  // Route through the same dispatcher the CLI uses: projects containing `.go`
  // files go to the Go subprocess (which emits the reimplemented liskov /
  // error-handling / goroutines categories), everything else to the TS pipeline.
  const result = await runAuditDispatch({ projectRoot } as any);

  const all: Violation[] = Object.values(result.analyzerResults as Record<string, any>).flatMap(
    (r: any) => r.violations ?? [],
  );
  const advisory = all.filter((v) => v.analyzer !== 'invariants');

  const byAnalyzer = new Map<string, number>();
  const byRule = new Map<string, number>();
  for (const v of advisory) {
    byAnalyzer.set(v.analyzer, (byAnalyzer.get(v.analyzer) ?? 0) + 1);
    // The Go subprocess labels findings with `category` (liskov-substitution,
    // import-organization, …) and leaves `rule` unset; the TS pipeline uses
    // `rule`. Key on whichever is present so both surfaces show up.
    const rule = `${v.analyzer}::${(v as any).rule || (v as any).category || 'unknown'}`;
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
  }

  const sortedAnalyzers = [...byAnalyzer.entries()].sort((a, b) => b[1] - a[1]);
  const sortedRules = [...byRule.entries()].sort((a, b) => b[1] - a[1]);

  console.log(`\n=== CORPUS: ${projectRoot} ===`);
  console.log(`advisory findings: ${advisory.length}`);
  console.log('\n--- per-analyzer ---');
  for (const [name, count] of sortedAnalyzers) console.log(`${name}: ${count}`);
  console.log('\n--- per-rule (analyzer::rule) ---');
  for (const [rule, count] of sortedRules) console.log(`${rule}: ${count}`);
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => cleanupScratch());
