/**
 * Split the *production* phase-model `db` unproven receivers by "does this file
 * also have a `db` site whose own literal SQL proves `handle`?". This tells us
 * whether the R3 sql-argument propagation (already wired into the phase path via
 * `classifyBuildProvenance` → `applyR3FromSites`) actually reaches every site it
 * should — or whether a residual stays unproven despite a sibling proving the
 * root. Read-only.
 *
 * Usage:
 *   npx tsx scripts/measure-phase-unproven-split.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runPhaseModel } from '../src/phase/phaseModel.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
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
  console.error('usage: measure-phase-unproven-split.ts <projectRoot>');
  process.exit(2);
}

const TS_STRING_LITERAL_TYPES = new Set(['string', 'template_string']);

function unquote(text: string): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'" || text[0] === '`')) return text.slice(1, -1);
  return text;
}

function extractSqlArgument(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const argsNode = adapter.getChildren(node).find((c) => c.type === 'arguments');
  if (!argsNode) return null;
  for (const arg of adapter.getChildren(argsNode)) {
    if (arg.type === '(' || arg.type === ')' || arg.type === ',') continue;
    if (!TS_STRING_LITERAL_TYPES.has(arg.type)) return null;
    // Interpolated templates (`\`…${x}…\``) are not static SQL — mirror production
    // `extractStaticSqlArgument`, which refuses them before `parseSql`.
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

  const files = await discoverFiles(projectRoot, { extensions: ALL_EXTENSIONS });
  const sqlDialect = detectDialect(projectRoot).dialect;
  const result = await runPhaseModel(files, new Map(), { projectRoot, workerCount: 1, sqlDialect });

  const dbUnproven = result.unprovenQueryReceivers.filter((u) => u.root === 'db');
  console.log(`phase 'db' unproven receivers: ${dbUnproven.length}`);

  const registry = LanguageRegistry.getInstance();

  // Per file: which roots have a handle-verdict site (direct sql-argument), and
  // the handle sites themselves.
  const handleRootsByFile = new Map<string, Set<string>>();
  const filesWithDb = new Set(dbUnproven.map((s) => s.file));
  for (const file of filesWithDb) {
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
      const provenance = new Map<string, never>(); // empty: we only want sql-argument proof here
      const bindings = buildBindingEnv(ast, adapter, content);
      const env: RootResolutionEnv = { provenance, bindings, adapter, sourceCode: content };
      const handleRoots = new Set<string>();
      const calls = adapter.findNodes(ast, { custom: (n: ASTNode) => n.type === 'call_expression' });
      for (const node of calls) {
        const callee = getCallExpressionCallee(node, adapter);
        if (!callee || (callee.type !== 'member_expression' && callee.type !== 'selector_expression')) continue;
        const method = extractMemberExpressionProperty(callee, adapter, content);
        if (!method || !DB_CALL_METHODS.has(method.toLowerCase())) continue;
        const receiver = getMemberExpressionReceiver(callee, adapter, content) ?? '(unknown)';
        const root = resolveReceiverRoot(callee, adapter, content);
        if (root === null) continue;
        const verdict = identifyHandle(
          { format: 'typescript', root, receiver, method, sqlArgument: extractSqlArgument(node, adapter, content), thisField: false },
          {
            imports: new Map(), typeAnnotations: new Map(), bindings: new Map(), withinFileProvenance: new Map(),
            sqlDialect, resolution: { dialect: 'ts', env },
          },
        );
        if (verdict.kind === 'handle') handleRoots.add(root);
      }
      handleRootsByFile.set(file, handleRoots);
    } finally {
      ast.dispose?.();
    }
  }

  const propagated = dbUnproven.filter((s) => handleRootsByFile.get(s.file)?.has('db'));
  const typeOnly = dbUnproven.filter((s) => !handleRootsByFile.get(s.file)?.has('db'));

  console.log(`\n=== split of ${dbUnproven.length} phase 'db' unproven receivers ===`);
  console.log(`  file has a literal-SQL 'db' handle site (should R3-propagate): ${propagated.length}`);
  console.log(`  no literal-SQL 'db' site in file (type-only / genuinely unresolvable): ${typeOnly.length}`);

  console.log(`\n--- method distribution, should-propagate (${propagated.length}) ---`);
  for (const [m, c] of sorted(tally(propagated.map((s) => s.method.toLowerCase()))).slice(0, 20)) console.log(`  ${m}: ${c}`);
  console.log(`\n--- method distribution, type-only (${typeOnly.length}) ---`);
  for (const [m, c] of sorted(tally(typeOnly.map((s) => s.method.toLowerCase()))).slice(0, 20)) console.log(`  ${m}: ${c}`);

  console.log('\n--- sample should-propagate (up to 10) ---');
  let shown = 0;
  const seen = new Set<string>();
  for (const s of propagated) {
    if (shown >= 10 || seen.has(s.file)) continue;
    seen.add(s.file);
    shown++;
    const rel = s.file.replace(projectRoot, '').replace(/^\//, '');
    console.log(`  ${rel}:${s.line}  ${s.receiver}.${s.method}()  :: ${s.reason.slice(0, 90)}`);
  }
  console.log('\n--- sample type-only (up to 8) ---');
  shown = 0;
  for (const s of typeOnly) {
    if (shown >= 8) break;
    shown++;
    const rel = s.file.replace(projectRoot, '').replace(/^\//, '');
    console.log(`  ${rel}:${s.line}  ${s.receiver}.${s.method}()  :: ${s.reason.slice(0, 90)}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
