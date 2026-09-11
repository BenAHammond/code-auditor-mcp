// Spec 53 R2 harness — audit each candidate corpus file in isolation, apply each
// metamorphic transform, re-audit, and report per-rule finding deltas in full.
// Runs against dist/ (never src/, which R1 Stryker mutates in place).
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeLanguages } from '../../dist/languages/index.js';
import { initParsers } from '../../dist/languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../../dist/auditRouter.js';
import { TRANSFORMS } from './transforms.mjs';

const CORPUS = '/Users/ben/playground/recall-protocol';
const CANDIDATES = [
  '/src/agents/hero-data-agent.ts',
  '/src/lib/stage0/ingest-foundational-kit.ts',
  '/src/lib/admin-asset-rehost-map.ts',
  '/scripts/run-knowledge-downstream.ts',
  '/src/pages/api/admin/generation/queue.ts',
  '/src/lib/reconciliation/fts-repair.ts',
  '/scripts/invalidate-article.ts',
];

initializeLanguages();
await initParsers();

let seq = 0;
async function auditSource(source, basename) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-r2-'));
  const filePath = path.join(dir, basename);
  fs.writeFileSync(filePath, source);
  const result = await runAuditDispatch({ projectRoot: dir, writeToLedger: false });
  const all = Object.values(result.analyzerResults).flatMap(r => r.violations ?? []);
  const advisory = all.filter(v => v.analyzer !== 'invariants');
  // per-rule: count + set of (rule,line,message) normalized
  const byRule = new Map();
  for (const v of advisory) {
    const rule = v.rule ?? v.type;
    if (!byRule.has(rule)) byRule.set(rule, []);
    byRule.get(rule).push({ line: v.line, msg: v.message });
  }
  // cleanup
  fs.rmSync(dir, { recursive: true, force: true });
  return byRule;
}

function summary(byRule) {
  const o = {};
  for (const [rule, arr] of [...byRule.entries()].sort()) o[rule] = arr.length;
  return o;
}

const report = [];
for (const rel of CANDIDATES) {
  const abs = path.join(CORPUS, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const basename = path.basename(rel);
  const base = await auditSource(src, basename);
  const baseSummary = summary(base);

  const row = { file: rel, baseline: baseSummary, transforms: {} };
  for (const t of TRANSFORMS) {
    let res;
    try { res = await t.apply(src); } catch (e) { row.transforms[t.name] = { error: String(e) }; continue; }
    if (!res) { row.transforms[t.name] = { applied: false }; continue; }
    const tSummary = summary(await auditSource(res.source, basename));
    const deltas = {};
    for (const rule of new Set([...Object.keys(baseSummary), ...Object.keys(tSummary)])) {
      const a = baseSummary[rule] ?? 0, b = tSummary[rule] ?? 0;
      if (a !== b) deltas[rule] = { before: a, after: b };
    }
    row.transforms[t.name] = { applied: true, detail: res.detail, deltas, after: tSummary };
  }
  report.push(row);
  // progress
  console.error(`[r2] done ${rel}`);
}

console.log(JSON.stringify(report, null, 2));
