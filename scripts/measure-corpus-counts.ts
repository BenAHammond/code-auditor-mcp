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
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../src/auditRouter.js';
import type { Violation } from '../src/types.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-corpus-counts.ts <projectRoot>');
  process.exit(2);
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

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
