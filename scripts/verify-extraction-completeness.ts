/**
 * verify-extraction-completeness.ts — machine-check the `data-access-calls`
 * producer's residual receiver-name blind spot (Spec 68 Thing 2, #312).
 *
 * #312 replaced the receiver-name list (db/database/sql/stmt) with a *shape
 * test*: a query-builder chain is discovered by its verb-plus-companion grammar
 * (`.select().from(`, `.insert().values(`, `.update().set()/.where(`, `.delete()`
 * `+ .where(`) and the Prisma object form (`<recv>.<model>.<verb>({ where, data })`),
 * not by what the receiver is called. This gate pins the *residual* — the
 * builder-chain call sites that still are not admitted after the shape test.
 * That residual is a mix of true negatives (Map/Set/cookies/crypto/Stripe
 * receivers that share a verb) and a small real miss (a builder whose companion
 * verb lives in a prior statement, e.g. `const q = baseQuery.where(...)`).
 *
 * Pin it: the next unseen idiom, or an extractor regression that silently stops
 * admitting a real builder, moves a number here instead of a quiet report.
 *
 * The corpora are READ-ONLY reference. This gate never measures a live working
 * tree — it materializes a clean, pinned snapshot of each corpus
 * (`corpus-pins.ts#materializeCorpusSnapshot`), failing closed (exit 2) on an
 * absent or present-but-unpinned corpus, then measures the snapshot.
 *
 * The corpus set is derived from this gate's own baseline — the keys of
 * `bench/baselines/extraction-completeness.json`'s `corpora` object — not from a
 * hand-kept name list. A corpus is in this gate iff the baseline records a gap
 * for it; adding or removing a corpus is an edit to the baseline, never to a
 * parallel list that can drift out of sync.
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { parseFile, getNodeText } from '../src/languages/adapterBridge.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { extractDataAccessCalls } from '../src/analyzers/universal/UniversalDataAccessAnalyzer.js';
import { getCallExpressionCallee } from '../src/analyzers/provenance.js';
import { discoverFiles, TYPESCRIPT_EXTENSIONS, JAVASCRIPT_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import type { AST, ASTNode } from '../src/languages/types.js';
import type { LanguageAdapter } from '../src/languages/LanguageAdapter.js';
import { compareCompleteness } from './verify-extraction-completeness-core.mjs';
import { materializeCorpusSnapshot } from './corpus-pins.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = join(APP_ROOT, 'bench', 'baselines', 'extraction-completeness.json');

/**
 * Independent shape sweep: a call expression is a builder anchor when the
 * method ITSELF being invoked is one of the six verbs (`.select(`, `.from(` …).
 * Testing the trailing callee method — not "does the full text contain a verb" —
 * avoids flagging an outer call whose argument subtree happens to contain a
 * builder chain. This is the same sweep the #312 instrument used, so the pinned
 * numbers are directly reproducible.
 */
function isBuilderCallee(node: ASTNode, adapter: LanguageAdapter, source: string): boolean {
  const callee = getCallExpressionCallee(node, adapter);
  if (!callee) return false;
  const text = (getNodeText(callee, source) ?? '').trim();
  // JS array/buffer construction `Array.from(` / `Buffer.from(` is not a query
  // builder (mirrors JS_FROM_CALL scrubbing in the real extractor).
  if (/^(Array|Buffer|Uint8Array|String)\.from$/i.test(text)) return false;
  return /\.(from|select|insert|update|delete|where)$/i.test(text);
}

/** Collect builder-anchor call sites, deduplicated to unique (file, line). */
function collectBuilderSites(
  ast: AST,
  adapter: LanguageAdapter,
  source: string,
): Set<string> {
  const sites = new Set<string>();
  const stack: ASTNode[] = [ast.root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'call_expression' && isBuilderCallee(node, adapter, source)) {
      sites.add(`${ast.filePath}:${node.location.start.line}`);
    }
    for (const c of node.children ?? []) stack.push(c);
  }
  return sites;
}

/** Measure one corpus tree: { builderSites, gap } where gap = sites with no extracted call. */
async function measureCorpus(registry: LanguageRegistry, projectRoot: string) {
  const extensions = [...TYPESCRIPT_EXTENSIONS, ...JAVASCRIPT_EXTENSIONS];
  const files = await discoverFiles(projectRoot, { extensions });

  let builderSites = 0;
  const extractedLines = new Set<string>();
  const gaps = new Set<string>();

  for (const file of files) {
    const adapter = registry.getAdapterForFile(file);
    if (!adapter) continue;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const ast = parseFile(file, source);
    if (!ast) continue;
    try {
      for (const c of extractDataAccessCalls(ast, adapter, source)) extractedLines.add(`${file}:${c.line}`);
      const sites = collectBuilderSites(ast, adapter, source);
      builderSites += sites.size;
      for (const key of sites) if (!extractedLines.has(key)) gaps.add(key);
    } finally {
      ast.dispose?.();
    }
  }

  return { builderSites, gap: gaps.size };
}

async function main(): Promise<number> {
  const baseline: Record<string, number> = JSON.parse(await readFile(BASELINE_PATH, 'utf8')).corpora;
  initializeLanguages();
  await initParsers();
  const registry = LanguageRegistry.getInstance();

  // The corpus set is the baseline's own key set — the single source of truth.
  const corpusSet = Object.keys(baseline);

  const measured: Record<string, number> = {};
  for (const name of corpusSet) {
    // Fail closed: an absent or unpinned corpus exits 2 here, before measuring.
    const snap = await materializeCorpusSnapshot(name);
    try {
      const { builderSites, gap } = await measureCorpus(registry, snap.dir);
      measured[name] = gap;
      console.log(`${name}: ${builderSites} builder sites, ${gap} residual gap`);
    } finally {
      await snap.cleanup();
    }
  }

  const drift = compareCompleteness(measured, baseline);
  if (drift.length) {
    console.error('\nextraction-completeness baseline DRIFT:');
    for (const d of drift) console.error(`  ${d}`);
    return 1;
  }
  if (Object.keys(measured).length) {
    console.log('extraction-completeness baseline intact.');
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  });
