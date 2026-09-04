/**
 * Measure baseline fingerprint collapse against recall-protocol and re-pin.
 *
 * The baseline ratchet keys each finding on [analyzer, rule, file, symbol].
 * When an analyzer emits no distinguishing symbol, every finding for a
 * (rule, file) pair collapses onto ONE fingerprint — the ratchet then cannot
 * tell 1 undefined class from 40 (fix one, the entry persists; add ten,
 * nothing new appears). This script surfaces that collapse and, once it is
 * resolved, re-pins the baseline at the new granularity.
 *
 * Usage: cd /Users/ben/playground/code-auditor/app && npx tsx scripts/measure-baseline-collapse.ts
 *
 * Writes only `.codeauditor.baseline.json` into recall-protocol (authorized
 * re-pin). No other repo files are touched.
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { createAuditRunner } from '../src/auditRunner.js';
import {
  createBaselineFromFindings,
  saveBaseline,
  loadBaseline,
  diffBaselines,
} from '../src/baseline.js';
import { extractSymbol } from '../src/symbols.js';
import { PACKAGE_VERSION } from '../src/constants.js';
import type { Violation } from '../src/types.js';

const RECALL_PROTOCOL = '/Users/ben/playground/recall-protocol';

/** Findings that share a fingerprint with at least one other finding in the same (rule, file) group. */
interface CollapseReport {
  analyzer: string;
  rule: string;
  collapsedGroups: number;
  collapsedFindings: number;
  totalGroups: number;
  totalFindings: number;
}

async function main() {
  console.error('Initializing languages + parsers...');
  initializeLanguages();
  await initParsers();
  console.error('Initialized.');

  console.error('Running full audit against recall-protocol (this is the slow part)...');
  const runner = createAuditRunner({ projectRoot: RECALL_PROTOCOL });
  const result = await runner.run();

  const all: Violation[] = Object.values(result.analyzerResults).flatMap(
    (r: any) => r.violations ?? [],
  );
  const advisory = all.filter((v) => v.analyzer !== 'invariants');

  // Group advisory findings by (analyzer, rule, file) and count distinct symbols.
  const key = (v: Violation) => `${v.analyzer}|${v.rule}|${v.file}`;
  const groups = new Map<string, Violation[]>();
  for (const v of advisory) {
    const k = key(v);
    const arr = groups.get(k) ?? [];
    arr.push(v);
    groups.set(k, arr);
  }

  const reports: CollapseReport[] = [];
  for (const [k, findings] of groups) {
    const symbols = new Set(findings.map((v) => extractSymbol(v)));
    if (symbols.size < findings.length) {
      const [analyzer, rule] = k.split('|');
      reports.push({
        analyzer,
        rule,
        collapsedGroups: 1,
        collapsedFindings: findings.length - symbols.size,
        totalGroups: 1,
        totalFindings: findings.length,
      });
    }
  }

  // Aggregate by analyzer.
  const byAnalyzer = new Map<string, CollapseReport>();
  for (const r of reports) {
    const agg = byAnalyzer.get(r.analyzer) ?? {
      analyzer: r.analyzer,
      rule: r.rule,
      collapsedGroups: 0,
      collapsedFindings: 0,
      totalGroups: 0,
      totalFindings: 0,
    };
    agg.collapsedGroups += r.collapsedGroups;
    agg.collapsedFindings += r.collapsedFindings;
    byAnalyzer.set(r.analyzer, agg);
  }

  const totalFindings = advisory.length;
  const totalDistinct = new Set(advisory.map((v) => `${v.analyzer}|${v.rule}|${v.file}|${extractSymbol(v)}`)).size;
  const totalCollapsed = reports.reduce((s, r) => s + r.collapsedFindings, 0);

  console.log('\n=== BASELINE COLLAPSE REPORT (advisory findings) ===');
  console.log(`Total advisory findings:  ${totalFindings}`);
  console.log(`Distinct (rule,file,symbol) tuples: ${totalDistinct}`);
  console.log(`Collapsed findings (share a symbol within a rule+file): ${totalCollapsed}`);
  console.log(`Collapsed groups: ${reports.length}`);

  console.log('\n--- Collapse by analyzer ---');
  const sorted = [...byAnalyzer.entries()].sort((a, b) => b[1].collapsedFindings - a[1].collapsedFindings);
  for (const [name, agg] of sorted) {
    console.log(`  ${name}: ${agg.collapsedFindings} collapsed findings across ${agg.collapsedGroups} groups`);
  }

  // Detailed look at styles + solid (the two this change targets).
  for (const focus of ['styles', 'solid']) {
    console.log(`\n--- ${focus} detailed ---`);
    const focusGroups = [...groups.entries()].filter(([k]) => k.startsWith(`${focus}|`));
    const collapsed = focusGroups.filter(([, findings]) => {
      const symbols = new Set(findings.map((v) => extractSymbol(v)));
      return symbols.size < findings.length;
    });
    if (collapsed.length === 0) {
      console.log(`  no collapsed groups`);
    } else {
      const byRule = new Map<string, { groups: number; findings: number }>();
      for (const [k, findings] of collapsed) {
        const rule = k.split('|')[1];
        const symbols = new Set(findings.map((v) => extractSymbol(v)));
        const agg = byRule.get(rule) ?? { groups: 0, findings: 0 };
        agg.groups += 1;
        agg.findings += findings.length - symbols.size;
        byRule.set(rule, agg);
      }
      for (const [rule, agg] of [...byRule.entries()].sort((a, b) => b[1].findings - a[1].findings)) {
        console.log(`  ${rule}: ${agg.findings} collapsed findings across ${agg.groups} groups`);
      }
      // Show the actual colliding symbols.
      const colliding = new Map<string, number>();
      for (const [, findings] of collapsed) {
        const counts = new Map<string, number>();
        for (const v of findings) {
          const s = extractSymbol(v);
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        for (const [s, n] of counts) if (n > 1) colliding.set(s, Math.max(colliding.get(s) ?? 0, n));
      }
      const top = [...colliding.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
      for (const [sym, n] of top) {
        console.log(`    collides×${n}: ${JSON.stringify(sym)}`);
      }
    }
  }

  // Re-pin the baseline at the new granularity.
  console.error('\nRe-pinning baseline...');
  const analyzerCounts: Record<string, number> = {};
  for (const v of advisory) {
    const a = v.analyzer || 'unknown';
    analyzerCounts[a] = (analyzerCounts[a] || 0) + 1;
  }
  const newBaseline = createBaselineFromFindings(advisory, {
    toolVersion: PACKAGE_VERSION,
    totalFindings: advisory.length,
    analyzerCounts,
    corpusStats: {
      files: result.metadata.filesAnalyzed,
      functions: result.metadata.collectedFunctions?.length ?? 0,
    },
  });
  const existing = loadBaseline(RECALL_PROTOCOL);
  const diff = existing ? diffBaselines(existing, newBaseline) : null;
  saveBaseline(RECALL_PROTOCOL, newBaseline);

  console.log('\n=== BASELINE RE-PIN ===');
  console.log(`absorbed: ${diff?.absorbed ?? newBaseline.entries.length}`);
  console.log(`fixed: ${diff?.fixed ?? 0}`);
  console.log(`total known entries: ${newBaseline.entries.length}`);
  console.log(`invariants excluded: ${all.filter((v) => v.analyzer === 'invariants').length}`);
  console.log(`files analyzed: ${result.metadata.filesAnalyzed}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
