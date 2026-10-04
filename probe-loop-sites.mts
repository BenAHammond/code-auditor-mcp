/**
 * Dump every loop-query finding (file:line + source snippet) for a corpus, so
 * suppressed-vs-firing sites can be enumerated individually. Read-only.
 */
import { initializeLanguages } from './src/languages/index.js';
import { initParsers } from './src/languages/tree-sitter/parser.js';
import { runAudit } from './src/auditRunner.js';
import { readFile } from 'node:fs/promises';

const root = process.argv[2];
if (!root) { console.error('usage: probe-loop-sites.mts <projectRoot>'); process.exit(2); }

async function main() {
  initializeLanguages();
  await initParsers();
  const result = await runAudit({ projectRoot: root } as any);
  const all = Object.values(result.analyzerResults as any).flatMap((r: any) => r.violations ?? []);
  const lq = all.filter((v: any) => v.rule === 'loop-query').sort((a: any, b: any) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1);
  for (const v of lq) {
    const rel = v.file.replace(root.replace(/\/$/, '') + '/', '');
    let snippet = '';
    try {
      const src = (await readFile(v.file, 'utf8')).split('\n');
      const l = Math.max(0, v.line - 2);
      snippet = (src[l] ?? '').trim();
    } catch { /* file not readable */ }
    console.log(`${rel}:${v.line}  | ${snippet}`);
  }
  console.error(`\n[total loop-query] ${lq.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
