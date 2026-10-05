/**
 * Measure whether an unproven site's root is proven `handle` at a *different*
 * site in the same file — the Spec 70 Item 1 propagation hypothesis.
 *
 * `db.prepare(sql).bind(x).first()` is several call sites sharing one root
 * `db`. `db.prepare('SELECT …')` proves `db` a handle via its SQL argument;
 * `db.bind(x)` / `db.first()` carry no SQL, so their receiver root stays
 * `unproven` (a `D1Database`-typed param no longer proves handle — criterion 9).
 * If a proven verdict at one site is never carried to sibling sites sharing the
 * root, that alone explains the 744 `db` unproven sites, list-free.
 *
 * This script, per file, enumerates *every* query-shaped call site and folds
 * `identifyHandle` over it (the exact production decision), then splits the
 * unproven `db` sites by "does this file also have a `handle`-verdict site with
 * the same root `db`?". It is read-only.
 *
 * Usage:
 *   npx tsx scripts/measure-root-propagation.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { resolveCorpusReceivers } from '../src/analyzers/receiverResolution.js';
import { detectDialect } from '../src/languages/sql/dialectDetection.js';
import { identifyHandle } from '../src/analyzers/handleIdentification.js';
import { buildBindingEnv, resolveReceiverRoot, type RootResolutionEnv } from '../src/analyzers/receiverRoot.js';
import {
  getCallExpressionCallee,
  getMemberExpressionReceiver,
  extractMemberExpressionProperty,
} from '../src/analyzers/provenance.js';
import { DB_CALL_METHODS } from '../src/analyzers/tsEcosystem.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { readFile } from 'node:fs/promises';
import type { ASTNode, LanguageAdapter } from '../src/languages/types.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-root-propagation.ts <projectRoot>');
  process.exit(2);
}

const TS_STRING_LITERAL_TYPES = new Set(['string', 'template_string']);

function unquote(text: string): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'" || text[0] === '`')) {
    return text.slice(1, -1);
  }
  return text;
}

/** Exact replica of the (non-exported) `extractSqlArgument` in receiverResolution.ts. */
function extractSqlArgument(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const argListType = adapter.name === 'go' ? 'argument_list' : 'arguments';
  const stringTypes = adapter.name === 'go' ? new Set(['interpreted_string_literal', 'raw_string_literal']) : TS_STRING_LITERAL_TYPES;
  const argsNode = adapter.getChildren(node).find((c) => c.type === argListType);
  if (!argsNode) return null;
  for (const arg of adapter.getChildren(argsNode)) {
    if (arg.type === '(' || arg.type === ')' || arg.type === ',') continue;
    if (!stringTypes.has(arg.type)) return null;
    // Interpolated templates (`\`…${x}…\``) are not static SQL — mirror production
    // `extractStaticSqlArgument`, which refuses them before `parseSql` (which is
    // lenient enough to accept `${x}` as a token and would over-prove).
    if (arg.type === 'template_string') {
      const kids = adapter.getChildren(arg) ?? [];
      if (kids.some((c) => c.type === 'template_substitution')) return null;
    }
    return unquote(adapter.getNodeText(arg, sourceCode));
  }
  return null;
}

function tally<T>(items: Iterable<T>): Map<T, number> {
  const m = new Map<T, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}

function sorted<T>(m: Map<T, number>): Array<[T, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  initializeLanguages();
  await initParsers();

  // Spec 70 Item 1 — propagate a handle verdict proven at one site to sibling
  // sites sharing the root. `resolveCorpusReceivers` applies the R3 propagation
  // step when a dialect is named (mirroring the phase path's `applyR3FromSites`),
  // so pass the detected dialect here — a null dialect still works, but the
  // propagation is then gated off (a site can only be proven by a parse, and no
  // dialect was named).
  const detection = detectDialect(projectRoot);
  console.log(`dialect: ${detection.dialect ?? 'null'}${detection.reason ? ` (${detection.reason})` : ''}`);

  // Baseline: no dialect → propagation gated off (the pre-fix count). Reported
  // so a single run attributes the movement (before → after) per corpus.
  const baseline = await resolveCorpusReceivers(projectRoot, undefined, null);
  const baselineDb = baseline.unprovenQueryReceivers.filter((s) => s.root === 'db');
  console.log(`BASELINE (dialect=null, pre-fix) root 'db' unproven: ${baselineDb.length}`);

  const report = await resolveCorpusReceivers(projectRoot, undefined, detection.dialect);
  const sites = report.unprovenQueryReceivers;
  const dbSites = sites.filter((s) => s.root === 'db');
  console.log(`total unproven sites: ${sites.length}`);
  console.log(`root 'db' unproven sites: ${dbSites.length} across ${new Set(dbSites.map((s) => s.file)).size} files`);

  const registry = LanguageRegistry.getInstance();

  // Enumerate, per file, every query-shaped call site's verdict — the exact
  // production fold — and record which roots are proven `handle` in that file.
  const handleRootsByFile = new Map<string, Set<string>>();
  const handleSitesByFile = new Map<string, Array<{ method: string; receiver: string; line: number }>>();

  const files = new Set(dbSites.map((s) => s.file));
  for (const file of files) {
    const adapter = registry.getAdapterForFile(file);
    if (!adapter) continue;
    let content: string;
    try {
      content = await readFile(file, 'utf-8');
    } catch {
      continue;
    }
    let ast;
    try {
      ast = await adapter.parse(file, content);
    } catch {
      continue;
    }
    try {
      const provenance = report.fileProvenance.get(file) ?? new Map();
      const bindings = buildBindingEnv(ast, adapter, content);
      const env: RootResolutionEnv = { provenance, bindings, adapter, sourceCode: content };

      const handleRoots = new Set<string>();
      const handleSites: Array<{ method: string; receiver: string; line: number }> = [];

      const calls = adapter.findNodes(ast, { custom: (n: ASTNode) => n.type === 'call_expression' });
      for (const node of calls) {
        const callee = getCallExpressionCallee(node, adapter);
        if (!callee || (callee.type !== 'member_expression' && callee.type !== 'selector_expression')) continue;
        const method = extractMemberExpressionProperty(callee, adapter, content);
        if (!method) continue;
        const m = method.toLowerCase();
        if (!DB_CALL_METHODS.has(m)) continue;

        const receiver = getMemberExpressionReceiver(callee, adapter, content) ?? '(unknown)';
        const root = resolveReceiverRoot(callee, adapter, content);
        if (root === null) continue;

        const verdict = identifyHandle(
          { format: 'typescript', root, receiver, method, sqlArgument: extractSqlArgument(node, adapter, content), thisField: false },
          {
            imports: new Map(),
            typeAnnotations: new Map(),
            bindings: new Map(),
            withinFileProvenance: new Map(),
            sqlDialect: detection.dialect,
            resolution: { dialect: 'ts', env },
          },
        );

        if (verdict.kind === 'handle') {
          handleRoots.add(root);
          handleSites.push({ method, receiver, line: node.location.start.line });
        }
      }

      handleRootsByFile.set(file, handleRoots);
      handleSitesByFile.set(file, handleSites);
    } finally {
      ast.dispose?.();
    }
  }

  const propagated: typeof dbSites = [];
  const notPropagated: typeof dbSites = [];
  for (const s of dbSites) {
    const roots = handleRootsByFile.get(s.file);
    if (roots && roots.has('db')) propagated.push(s);
    else notPropagated.push(s);
  }

  console.log(`\n=== SPLIT of ${dbSites.length} root-'db' unproven sites ===`);
  console.log(`  same file has a handle-verdict 'db' site (propagatable): ${propagated.length}`);
  console.log(`  no handle-verdict 'db' site in file (type-only evidence):  ${notPropagated.length}`);

  console.log(`\n--- method distribution, propagatable (${propagated.length}) ---`);
  for (const [m, c] of sorted(tally(propagated.map((s) => s.method.toLowerCase()))).slice(0, 20)) console.log(`  ${m}: ${c}`);
  console.log(`\n--- method distribution, not-propagatable (${notPropagated.length}) ---`);
  for (const [m, c] of sorted(tally(notPropagated.map((s) => s.method.toLowerCase()))).slice(0, 20)) console.log(`  ${m}: ${c}`);

  // Sample: for propagatable sites, show the handle site that should carry the proof.
  console.log('\n--- sample propagatable (up to 12): handle site + an unproven sibling ---');
  let shown = 0;
  const seen = new Set<string>();
  for (const s of propagated) {
    if (shown >= 12) break;
    if (seen.has(s.file)) continue;
    seen.add(s.file);
    shown++;
    const rel = s.file.replace(projectRoot, '').replace(/^\//, '');
    const hs = handleSitesByFile.get(s.file) ?? [];
    const dbHandle = hs.filter((h) => h.receiver.startsWith('db.')).slice(0, 3);
    console.log(`  ${rel}`);
    console.log(`    handle sites: ${dbHandle.map((h) => `db.${h.method}()@${h.line}`).join(', ') || '(none named db.* — see below)'}`);
    if (dbHandle.length === 0) console.log(`    (all handle sites: ${hs.map((h) => `${h.receiver}.${h.method}()@${h.line}`).join(', ')})`);
    console.log(`    unproven sibling: ${s.receiver}.${s.method}() @${s.line}`);
  }

  // Sample of not-propagatable, to confirm "type annotation is the only evidence".
  console.log('\n--- sample not-propagatable (up to 8) ---');
  shown = 0;
  for (const s of notPropagated) {
    if (shown >= 8) break;
    shown++;
    const rel = s.file.replace(projectRoot, '').replace(/^\//, '');
    console.log(`  ${rel}:${s.line}  ${s.receiver}.${s.method}()  :: ${s.reason.slice(0, 100)}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
