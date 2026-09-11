// Spec 53 R3 — validate the property oracles against the real audit BEFORE wiring
// up fast-check. Each construct below/at/above threshold is audited in isolation
// (dist/ build; never src/ during R1) and the observed rule counts are printed
// next to the oracle expectation. A mismatch here is a *wrong oracle*, not a bug.
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeLanguages } from '../dist/languages/index.js';
import { initParsers } from '../dist/languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../dist/auditRouter.js';

initializeLanguages();
await initParsers();

async function auditSource(source, basename) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-r3-'));
  const filePath = path.join(dir, basename);
  fs.writeFileSync(filePath, source);
  const result = await runAuditDispatch({ projectRoot: dir, writeToLedger: false });
  const all = Object.values(result.analyzerResults).flatMap((r) => r.violations ?? []);
  fs.rmSync(dir, { recursive: true, force: true });
  return all;
}
function count(rule, violations) {
  return violations.filter((v) => (v.rule ?? v.type) === rule).length;
}
async function probe(rule, label, source, basename) {
  const vs = await auditSource(source, basename);
  const n = count(rule, vs);
  console.log(`  ${label.padEnd(34)} -> ${rule} = ${n}`);
  return n;
}

console.log('parameter-count (threshold 4):');
await probe('parameter-count', '0 params', 'export function f() { return 1; }', 'f0.ts');
await probe('parameter-count', '4 params (at threshold)', 'export function f(a,b,c,d) { return 1; }', 'f4.ts');
await probe('parameter-count', '5 params (over)', 'export function f(a,b,c,d,e) { return 1; }', 'f5.ts');
await probe('parameter-count', '5 params arrow', 'export const f = (a,b,c,d,e) => 1;', 'f5a.ts');

console.log('solid/class-size (threshold 15):');
await probe('solid/class-size', '14 methods (under)', 'export class C { ' + Array.from({length:14},(_,i)=>`m${i}(){return 1;}`).join(' ') + ' }', 'c14.ts');
await probe('solid/class-size', '16 methods (over)', 'export class C { ' + Array.from({length:16},(_,i)=>`m${i}(){return 1;}`).join(' ') + ' }', 'c16.ts');

console.log('loop-query:');
await probe('loop-query', 'query in for-of', 'export function f(ids){ for (const id of ids) { db.query("SELECT * FROM t WHERE id = ?", [id]); } }', 'lq1.ts');
await probe('loop-query', 'query outside loop', 'export function f(ids){ const q = db.query("SELECT 1"); for (const id of ids) { cache.get(id); } }', 'lq2.ts');

console.log('styles/undefined-class:');
await probe('styles/undefined-class', 'used class undefined', 'export const css = `.card { display: flex; }`; export const html = `<div class="missing"></div>`;', 'u1.tsx');
await probe('styles/undefined-class', 'used class defined', 'export const css = `.card { display: flex; }`; export const html = `<div class="card"></div>`;', 'u2.tsx');

console.log('upsert-write -> cross-domain/written-never-read:');
await probe('cross-domain/written-never-read', 'INSERT ... ON CONFLICT DO UPDATE', 'export async function f(db){ await db.execute("INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1"); }', 'w1.ts');
await probe('cross-domain/written-never-read', 'bare INSERT', 'export async function f(db){ await db.execute("INSERT INTO t (id) VALUES (1)"); }', 'w2.ts');
