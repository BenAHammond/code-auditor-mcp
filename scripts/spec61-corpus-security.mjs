/**
 * Focused Spec 61 criterion-13 re-measure: run only the UniversalSecurityAnalyzer
 * over a corpus and count per-rule findings, so the sink-set delta is isolated
 * from the full (slow) audit. Only the `security` analyzer is affected by the
 * sink-set change, so this is sufficient for the criterion-13 guard.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { initializeLanguages, LanguageRegistry } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import { UniversalSecurityAnalyzer, DEFAULT_SECURITY_CONFIG } from '../src/analyzers/universal/UniversalSecurityAnalyzer.js';

const root = process.argv[2];
if (!root) { console.error('usage: spec61-corpus-security.mjs <corpusRoot>'); process.exit(2); }

const EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const EXCLUDE = /(node_modules|\/dist\/|\/build\/|__tests__|\.test\.|\.spec\.|\/test\/|\/tests\/|\/fixtures\/|\.fixture\.)/i;

async function walk(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE.test(e.name) && e.name !== 'src') continue;
      out.push(...(await walk(p)));
    } else if (EXT.has(path.extname(e.name)) && !EXCLUDE.test(p)) {
      out.push(p);
    }
  }
  return out;
}

initializeLanguages();
await initParsers();
const adapter = LanguageRegistry.getInstance().getAdapterForFile('x.ts');
const security = new UniversalSecurityAnalyzer();

const files = await walk(root);
const byRule = new Map();
const byFile = new Map();
for (const f of files) {
  let src;
  try { src = await fs.readFile(f, 'utf-8'); } catch { continue; }
  const ast = parseFile(f, src);
  if (!ast) continue;
  const vs = await security.analyzeAST(ast, adapter, DEFAULT_SECURITY_CONFIG, src);
  ast.dispose?.();
  for (const v of vs) {
    const r = v.rule ?? 'unknown';
    byRule.set(r, (byRule.get(r) ?? 0) + 1);
    if (r === 'unescaped-html-interpolation') {
      const arr = byFile.get(f) ?? [];
      arr.push(v.line);
      byFile.set(f, arr);
    }
  }
}

console.log(`\n=== ${root} ===`);
console.log(`files: ${files.length}`);
for (const [r, c] of [...byRule.entries()].sort()) console.log(`  ${r}: ${c}`);
if (byFile.size) {
  console.log('  unescaped-html-interpolation sites:');
  for (const [f, lines] of byFile.entries()) console.log(`    ${f}:${lines.join(',')}`);
}
