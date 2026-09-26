/**
 * probe-unknown-table.ts — dump unknown-table / stale-table-reference findings
 * from a self-audit of the app's own src/, so Disposition 1 can classify each of
 * the 202 criticals as genuinely-absent vs declared-in-code-unseen.
 *
 * Scratch probe, not a shipped gate. Run: tsx scripts/probe-unknown-table.ts
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../src/auditRouter.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(process.argv[2] ?? resolve(__dirname, '..', 'src'));

initializeLanguages();
await initParsers();

const result = await runAuditDispatch({ projectRoot, writeToLedger: false } as any);

const all = Object.values(result.analyzerResults).flatMap((ar: any) => ar.violations ?? []);
const hits = all.filter((v: any) => v.rule === 'unknown-table' || v.rule === 'stale-table-reference');

// Total + severity reconciliation against the prior 1164-finding measurement.
const sev = new Map<string, number>();
for (const v of all as any[]) sev.set(v.severity, (sev.get(v.severity) ?? 0) + 1);
console.log(`TOTAL findings: ${all.length}  severity=${JSON.stringify(Object.fromEntries(sev))}`);
const perAnalyzer = new Map<string, number>();
for (const v of all as any[]) perAnalyzer.set(v.analyzer, (perAnalyzer.get(v.analyzer) ?? 0) + 1);
console.log(`per-analyzer: ${JSON.stringify(Object.fromEntries([...perAnalyzer.entries()].sort((a, b) => b[1] - a[1])), null, 0)}`);
const perRule = new Map<string, number>();
for (const v of all as any[]) {
  const key = `${v.analyzer}/${v.rule}`;
  perRule.set(key, (perRule.get(key) ?? 0) + 1);
}
const dg = [...perRule.entries()].filter(([k]) => k.startsWith('dependency-graph/')).sort((a, b) => b[1] - a[1]);
console.log(`dependency-graph per-rule: ${JSON.stringify(Object.fromEntries(dg), null, 0)}`);
const coverage = (result.metadata?.coverage ?? []) as Array<{ ruleId: string; state: string }>;
const orgFilter = coverage.filter((c) => /org-filter|missing-org|unfiltered/.test(c.ruleId));
console.log(`org-filter coverage: ${JSON.stringify(orgFilter, null, 0)}`);
const orgViolations = all.filter((v: any) => /org-filter|missing-org|unfiltered/.test(v.rule));
console.log(`org-filter violations: ${orgViolations.length} ${JSON.stringify([...new Set(orgViolations.map((v: any) => v.rule))])}`);
for (const v of orgViolations as any[]) {
  console.log(`  ${v.rule} analyzer=${v.analyzer} sev=${v.severity} file=${v.file}`);
}
console.log('');

console.log(`unknown-table total: ${hits.filter((v: any) => v.rule === 'unknown-table').length}`);
console.log(`stale-table-reference total: ${hits.filter((v: any) => v.rule === 'stale-table-reference').length}`);
console.log('');

// Aggregate: table name → count, and the files it appears in.
const byTable = new Map<string, { count: number; files: Set<string> }>();
for (const h of hits as any[]) {
  const table = h.symbol ?? (h.message.match(/'([^']+)'/)?.[1] ?? '?');
  let e = byTable.get(table);
  if (!e) { e = { count: 0, files: new Set() }; byTable.set(table, e); }
  e.count++;
  e.files.add(h.file);
}

const rows = [...byTable.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [table, e] of rows) {
  console.log(`${String(e.count).padStart(3)}  ${table}`);
  for (const f of e.files) console.log(`        ${f}`);
}
