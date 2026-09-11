// Spec 53 R3 — validate the "wrapping matrix" invariance against the real audit,
// before fast-check is wired in. For each already-oracle-validated construct, the
// firing answer (≥1 finding) must hold under every wrapping context. A drop to 0
// under a wrap is an invariance violation (a real finding), not an oracle error.
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeLanguages } from '../dist/languages/index.js';
import { initParsers } from '../dist/languages/tree-sitter/parser.js';
import { runAuditDispatch } from '../dist/auditRouter.js';

initializeLanguages();
await initParsers();

async function auditFiles(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-r3w-'));
  for (const [name, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), src);
  const r = await runAuditDispatch({ projectRoot: dir, writeToLedger: false });
  const all = Object.values(r.analyzerResults).flatMap((x) => x.violations ?? []);
  fs.rmSync(dir, { recursive: true, force: true });
  return all;
}
function count(rule, vs) { return vs.filter((v) => (v.rule ?? v.type) === rule).length; }

// Wraps produce syntactically valid code. Constructs are generated WITHOUT
// `export` (visibility is a separate axis from context-invariance), and
// `Promise.all([...])` is expression-only — inapplicable to declarations.
const wraps = {
  'top-level': (s) => s,
  'named function': (s) => `function wrapper() {\n${s}\n}`,
  'arrow const': (s) => `const wrapper = () => {\n${s}\n};`,
  'class method': (s) => `class C { m() {\n${s}\n} }`,
  'IIFE': (s) => `(() => {\n${s}\n})();`,
  'Promise.all': (s) => `async function wrapper() { await Promise.all([\n${s}\n]); }`,
  'try/catch': (s) => `function wrapper() { try {\n${s}\n} catch (e) {} }`,
  'if branch': (s) => `function wrapper(x) { if (x) {\n${s}\n} }`,
  'comment+reindent': (s) => s.split('\n').map((l) => '  // c\n  ' + l).join('\n'),
};
// `expression` constructs can sit in Promise.all([...]); `declaration` and
// `statement` constructs cannot (a declaration or `for` loop is not an array
// element). Block-level wraps (function/arrow/method/IIFE/try/if) apply to all.
const cases = [
  { rule: 'parameter-count', kind: 'declaration', body: 'function f(a,b,c,d,e) { return a+b+c+d+e; }' },
  { rule: 'solid/class-size', kind: 'declaration', body: 'class Big { ' + Array.from({length:16},(_,i)=>`m${i}(){return 1;}`).join(' ') + ' }' },
  { rule: 'loop-query', kind: 'statement', body: 'for (const id of ids) { db.query("SELECT * FROM t WHERE id = ?", [id]); }' },
];

for (const c of cases) {
  console.log(`\n=== ${c.rule} (expect ≥1 under every applicable wrap) ===`);
  for (const [wname, wfn] of Object.entries(wraps)) {
    if (c.kind !== 'expression' && wname === 'Promise.all') {
      console.log(`  ${wname.padEnd(18)} -> n/a (${c.kind})`);
      continue;
    }
    const src = wfn(c.body);
    const vs = await auditFiles({ 'f.ts': src });
    const n = count(c.rule, vs);
    console.log(`  ${wname.padEnd(18)} -> ${n}`);
  }
}
