/**
 * AC8 measurement — count cross-language callee + file-reference entries, read-only.
 *
 * Runs the SAME cross-language entity visitor the pipeline runs
 * (`createCrossLanguageEntityVisitor`), parses every TS/JS/Go file in the
 * corpus, and sums the callee entries and file-reference entries the walkers
 * (`clCollectCallees` / `clCollectFileReferences`) produce. This isolates the
 * cross-language walker output from the advisory-violation counts, so the
 * raw→ASTNode rewrite can be checked for an exact before/after match.
 *
 * Usage (from app/):
 *   CODE_AUDITOR_DATA_DIR=/tmp/x npx tsx scripts/measure-crosslang.ts <corpus>
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { createCrossLanguageEntityVisitor } from '../src/pipelineAdapters.js';
import fs from 'node:fs';
import path from 'node:path';

const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.go']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'coverage']);

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(full);
    }
  }
}

async function main() {
  const projectRoot = path.resolve(process.argv[2] ?? process.cwd());
  initializeLanguages();
  await initParsers();
  const registry = LanguageRegistry.getInstance();
  const visitor = createCrossLanguageEntityVisitor();

  const files: string[] = [];
  walk(projectRoot, files);

  let entities = 0;
  let calleeEntries = 0;
  let fileRefEntries = 0;

  for (const filePath of files) {
    const adapter = registry.getAdapterForFile(filePath);
    if (!adapter) continue;
    const sourceCode = fs.readFileSync(filePath, 'utf8');
    const ast = await adapter.parse(filePath, sourceCode);
    if (!ast) continue;
    const result = await visitor.visit(ast, adapter, { filePath } as any, sourceCode);
    const facts = result.facts as Record<string, any>;
    for (const data of Object.values(facts)) {
      for (const e of (data?.entities ?? []) as any[]) {
        entities++;
        calleeEntries += (e.metadata?.callees?.length ?? 0);
        fileRefEntries += (e.metadata?.fileReferences?.length ?? 0);
      }
    }
    ast.dispose?.();
  }

  console.log(`CORPUS: ${projectRoot}`);
  console.log(`files: ${files.length}`);
  console.log(`cross-language entities: ${entities}`);
  console.log(`callee entries: ${calleeEntries}`);
  console.log(`file-reference entries: ${fileRefEntries}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
