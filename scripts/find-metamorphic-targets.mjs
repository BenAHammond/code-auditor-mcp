// Spec 53 R2 — find real corpus files (recall-protocol) that carry findings for
// the per-file rules a metamorphic transform could disturb. Runs against the
// PRE-BUILT dist/ (not src/, which Stryker mutates in place during R1).
// @ts-nocheck
import { initializeLanguages } from '../dist/languages/index.js';
import { initParsers } from '../dist/languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../dist/auditRouter.js';

const CORPUS = process.argv[2] || '/Users/ben/playground/recall-protocol';
const TARGET_RULES = [
  'loop-query',            // data-access
  'unfiltered-query',      // data-access
  'too-many-queries',      // schema-code
  'table-naming-convention', // schema-code
  'unknown-table',         // schema
  'written-never-read',    // cross-domain
  'read-never-written',    // cross-domain
];

initializeLanguages();
await initParsers();
const result = await runAuditDispatch({ projectRoot: CORPUS });
const all = Object.values(result.analyzerResults).flatMap(r => r.violations ?? []);
const advisory = all.filter(v => v.analyzer !== 'invariants');

// rule identity → file → count
const byRuleFile = new Map();
for (const v of advisory) {
  const rule = v.rule ?? v.type;
  if (!TARGET_RULES.includes(rule)) continue;
  if (!byRuleFile.has(rule)) byRuleFile.set(rule, new Map());
  const m = byRuleFile.get(rule);
  m.set(v.file, (m.get(v.file) ?? 0) + 1);
}

for (const rule of TARGET_RULES) {
  const m = byRuleFile.get(rule);
  if (!m) { console.log(`\n### ${rule}: 0 files`); continue; }
  const sorted = [...m.entries()].sort((a,b) => b[1]-a[1]);
  console.log(`\n### ${rule}: ${sorted.length} files, ${[...m.values()].reduce((a,b)=>a+b,0)} findings`);
  for (const [file, count] of sorted.slice(0, 12)) {
    console.log(`  ${count}\t${file.replace(CORPUS, '')}`);
  }
}
