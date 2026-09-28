/**
 * TEMPORARY: authoritative dump of blocking findings in the §13.1 widened scope.
 * Writes JSON to the path given as argv[2] (default /tmp/ca-blocking.json).
 *
 * Scope = whole repo minus the built-in "scripts-and-tests" path profile, minus
 * bench/corpus + bench/recall-fixture, minus node_modules/dist/.git/.claude.
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAudit } from '../src/auditRunner.js';
import fs from 'node:fs';

// Spec 68 §13.1 — the widened gate audits the whole shipped product: everything
// under `src/` that is production source. The tool's own test corpus (tests,
// spec files, __tests__, fixtures), the declarative ruleRegistry data table, and
// the dev/measurement/bench tooling (scripts/, bench/) and the separate vscode
// package (editors/) are out of scope — they are not the shipped `src` product.
const IGNORED = /(^|\/)(node_modules|dist|\.git|\.claude)\//;
const TEST_DIRS = /(^|\/)(__tests__|fixtures|bench)\//;
const TEST_FILES = /\.(test|spec)\.[^.]+$|\.test-d\.ts$|\.tst\.ts$/;
const RULE_REGISTRY = /(^|\/)analyzers\/ruleRegistry\.ts$/;
const BLOCKING = new Set(['critical', 'severe', 'high']);

function inScope(file: string): boolean {
  const m = file.match(/\/app\/(.*)$/);
  const rel = m ? m[1] : file;
  if (!/^src\//.test(rel)) return false; // only shipped src/ product
  if (IGNORED.test(rel)) return false;
  if (TEST_DIRS.test(rel)) return false;
  if (TEST_FILES.test(rel)) return false;
  if (RULE_REGISTRY.test(rel)) return false;
  return true;
}

async function main() {
  initializeLanguages();
  await initParsers();
  const result = await runAudit({ projectRoot: '.' } as any);
  const all = Object.values(result.analyzerResults as Record<string, any>).flatMap(
    (r: any) => r.violations ?? [],
  );
  const blocking = all.filter((v: any) => BLOCKING.has(v.severity) && inScope(v.file ?? ''));

  const byRule = new Map<string, any[]>();
  for (const v of blocking) {
    const k = v.rule ?? 'unknown';
    (byRule.get(k) ?? byRule.set(k, []).get(k)!).push(v);
  }

  const out = [...byRule.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([rule, vs]) => ({
      rule,
      count: vs.length,
      findings: vs
        .sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0))
        .map((v) => ({
          file: (v.file ?? '').replace(/^.*?\/app\//, ''),
          line: v.line,
          column: v.column,
          symbol: v.symbol,
          severity: v.severity,
          message: v.message,
        })),
    }));

  const outPath = process.argv[2] ?? '/tmp/ca-blocking.json';
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log(`total blocking (widened scope): ${blocking.length}`);
  console.log(`by rule:`);
  for (const { rule, count } of out) console.log(`  ${String(count).padStart(5)}  ${rule}`);
  console.log(`\nwrote ${outPath}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
