import { initializeLanguages } from './src/languages/index.js';
import { initParsers } from './src/languages/tree-sitter/parser.js';
import { resolveCorpusReceivers } from './src/analyzers/receiverResolution.js';

async function main() {
  initializeLanguages();
  await initParsers();
  const report = await resolveCorpusReceivers('/Users/ben/playground/recall-protocol');
  for (const s of report.unprovenQueryReceivers) {
    const rel = s.file.replace('/Users/ben/playground/recall-protocol/', '');
    console.log(`${rel}:${s.line}  [${s.method}]  ${JSON.stringify(s.receiver)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
