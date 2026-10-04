import { initializeLanguages } from './src/languages/index.js';
import { initParsers } from './src/languages/tree-sitter/parser.js';
import { resolveCorpusReceivers } from './src/analyzers/receiverResolution.js';

const corpora = [
  '/Users/ben/playground/recall-protocol',
  '/Users/ben/playground/hhra-org',
  '/Users/ben/playground/knex',
  '/Users/ben/playground/primer-css',
  '/Users/ben/playground/blitz',
  '/Users/ben/playground/endless-guessing',
];

async function main() {
  initializeLanguages();
  await initParsers();
  for (const root of corpora) {
    try {
      const report = await resolveCorpusReceivers(root);
      const sites = report.unprovenQueryReceivers;
      const byMethod: Record<string, number> = {};
      for (const s of sites) byMethod[s.method.toLowerCase()] = (byMethod[s.method.toLowerCase()] ?? 0) + 1;
      const dist = Object.entries(byMethod).sort((a,b)=>b[1]-a[1]).map(([m,c])=>`${m}:${c}`).join(' ');
      console.log(`${root.replace('/Users/ben/playground/','')}: total=${sites.length}  [${dist}]`);
    } catch (e) {
      console.log(`${root.replace('/Users/ben/playground/','')}: ERROR ${(e as Error).message}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
