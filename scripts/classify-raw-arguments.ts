/**
 * Classify the first argument of every unproven `.raw()` call site in a corpus.
 *
 * Spec 70 criterion 11 — the `.raw` argument split. `measure-unproven-sites.ts`
 * reports the *count* (438 unproven, 328 `.raw`); this script answers the
 * follow-up: of the 328, how many pass a static literal (a `string`, or a
 * `template_string` with no `${…}` interpolation) that R3 (`sql-argument`) could
 * have parsed, versus how many pass a variable / concatenation / interpolated
 * template that R3 correctly abstains from.
 *
 * For the static-literal group it also prints each site's cannot-fire reason, so
 * the "why did this not resolve" question is answered site-by-site rather than
 * asserted.
 *
 * Usage:
 *   npx tsx scripts/classify-raw-arguments.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { resolveCorpusReceivers } from '../src/analyzers/receiverResolution.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { getCallExpressionCallee, extractMemberExpressionProperty } from '../src/analyzers/provenance.js';
import type { ASTNode, LanguageAdapter } from '../src/languages/types.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: classify-raw-arguments.ts <projectRoot>');
  process.exit(2);
}

/** Argument-kind bucket for a `.raw()` first argument. */
type Bucket =
  | 'string-literal'        // '…' or "…" — no interpolation possible
  | 'template-literal'      // `…` with no ${…} — static
  | 'interpolated-template' // `…${…}…` — dynamic
  | 'concatenation'         // a + b (binary_expression)
  | 'variable'              // identifier / member / subscript / call / other non-literal
  | 'other';

function hasInterpolation(node: ASTNode, adapter: LanguageAdapter): boolean {
  const children = adapter.getChildren(node);
  if (children.some((c) => c.type === 'template_substitution')) return true;
  return false;
}

/** Classify the first argument node of a call expression. */
function classifyFirstArg(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): Bucket {
  const argsNode = adapter.getChildren(node).find((c) => c.type === 'arguments');
  if (!argsNode) return 'other';
  for (const arg of adapter.getChildren(argsNode)) {
    if (arg.type === '(' || arg.type === ')' || arg.type === ',') continue;
    switch (arg.type) {
      case 'string':
        return 'string-literal';
      case 'template_string':
        return hasInterpolation(arg, adapter) ? 'interpolated-template' : 'template-literal';
      case 'binary_expression':
        return 'concatenation';
      case 'identifier':
      case 'member_expression':
      case 'subscript_expression':
      case 'call_expression':
      case 'new_expression':
      case 'parenthesized_expression':
      case 'arrow_function':
      case 'object':
      case 'ternary_expression':
      case 'await_expression':
        return 'variable';
      default:
        return 'other';
    }
  }
  return 'other';
}

async function main() {
  initializeLanguages();
  await initParsers();

  const report = await resolveCorpusReceivers(projectRoot);
  const rawSites = report.unprovenQueryReceivers.filter((s) => s.method.toLowerCase() === 'raw');
  console.log(`\n=== .raw ARGUMENT SPLIT: ${projectRoot} ===`);
  console.log(`unproven .raw sites: ${rawSites.length}`);

  // Group sites by file so each file is parsed once.
  const byFile = new Map<string, typeof rawSites>();
  for (const s of rawSites) {
    const list = byFile.get(s.file) ?? [];
    list.push(s);
    byFile.set(s.file, list);
  }

  const registry = LanguageRegistry.getInstance();
  const buckets = new Map<Bucket, Array<{ rel: string; line: number; reason: string }>>();
  const reasonTally = new Map<string, number>();
  let unmatched = 0;

  for (const [file, sites] of byFile) {
    const adapter = registry.getAdapterForFile(file);
    if (!adapter) { unmatched += sites.length; continue; }
    let ast;
    let content = '';
    try {
      content = await readFile(file, 'utf8');
      ast = await adapter.parse(file, content);
    } catch {
      unmatched += sites.length;
      continue;
    }
    const linesWanted = new Set(sites.map((s) => s.line));
    const calls = adapter.findNodes(ast, { custom: (n) => n.type === 'call_expression' });
    for (const node of calls) {
      if (!linesWanted.has(node.location.start.line)) continue;
      const callee = getCallExpressionCallee(node, adapter);
      if (!callee || callee.type !== 'member_expression') continue;
      const method = extractMemberExpressionProperty(callee, adapter, content);
      if (!method || method.toLowerCase() !== 'raw') continue;
      // Recover the matching site record for its reason.
      const site = sites.find((s) => s.line === node.location.start.line);
      const bucket = classifyFirstArg(node, adapter, content);
      const rel = file.replace(projectRoot, '').replace(/^\//, '');
      const reason = site?.reason ?? '(no reason)';
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push({ rel, line: node.location.start.line, reason });
      reasonTally.set(reason, (reasonTally.get(reason) ?? 0) + 1);
    }
  }

  const order: Bucket[] = [
    'string-literal',
    'template-literal',
    'interpolated-template',
    'concatenation',
    'variable',
    'other',
  ];
  const staticTotal = (buckets.get('string-literal')?.length ?? 0) + (buckets.get('template-literal')?.length ?? 0);

  console.log(`\n--- bucket split ---`);
  let matched = 0;
  for (const b of order) {
    const c = buckets.get(b)?.length ?? 0;
    matched += c;
    console.log(`${b.padEnd(22)} ${c}`);
  }
  console.log(`\nstatic literal (string-literal + template-literal, no interpolation): ${staticTotal}`);
  console.log(`dynamic (interpolated-template + concatenation + variable + other): ${matched - staticTotal}`);
  if (unmatched) console.log(`\nWARNING: ${unmatched} site(s) could not be re-matched to a parse (adapter missing / parse failed)`);

  console.log(`\n--- reason distribution (across all 328, normalized) ---`);
  for (const [r, c] of [...reasonTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${c}\t${r}`);
  }

  // The static-literal group: enumerate site-by-site with its reason (why not resolved).
  const staticList = [...(buckets.get('string-literal') ?? []), ...(buckets.get('template-literal') ?? [])];
  console.log(`\n--- static-literal sites (should resolve via R3 if dialect named + parses) — ${staticTotal} ---`);

  // Why each static literal did not resolve: the reason is a UNION of the two
  // evidence sources' causes. Split by whether the R3 `sql-argument` cause
  // ("SQL dialect undetermined") is present, versus the R4 declaration cause
  // (un-annotated binding / class field / no binding) firing alone.
  const withDialect = staticList.filter((s) => s.reason.includes('dialect undetermined'));
  const withoutDialect = staticList.filter((s) => !s.reason.includes('dialect undetermined'));
  console.log(`  static literals whose reason names "dialect undetermined":  ${withDialect.length}`);
  console.log(`  static literals whose reason does NOT name dialect:         ${withoutDialect.length}`);

  console.log(`\n  --- reasons WITHOUT "dialect undetermined" (R4 declaration cause only) ---`);
  const noDialectTally = new Map<string, number>();
  for (const s of withoutDialect) {
    // Normalize to the declaration-cause prefix (strip the trailing method clause).
    const key = s.reason.replace(/; `\.raw\(\)` is query-shaped.*$/, '');
    noDialectTally.set(key, (noDialectTally.get(key) ?? 0) + 1);
  }
  for (const [r, c] of [...noDialectTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}\t${r}`);
  }

  console.log(`\n  --- reasons WITH "dialect undetermined" (R3 + R4 both fired) ---`);
  const withDialectTally = new Map<string, number>();
  for (const s of withDialect) {
    const key = s.reason.replace(/; `\.raw\(\)` is query-shaped.*$/, '');
    withDialectTally.set(key, (withDialectTally.get(key) ?? 0) + 1);
  }
  for (const [r, c] of [...withDialectTally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}\t${r}`);
  }

  console.log(`\n  --- first 30 static sites with their reason ---`);
  for (const s of staticList.slice(0, 30)) {
    const bucket = s.reason.includes('dialect undetermined') ? 'dialect' : 'no-dialect';
    console.log(`  [${bucket}] ${s.rel}:${s.line} — ${s.reason}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
