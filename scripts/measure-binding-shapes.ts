/**
 * Measure the binding shape of unproven receiver roots, read-only.
 *
 * For each unproven query-receiver site, re-derive the *root* identifier's
 * binding in its file and classify the binding shape. This answers two
 * questions from the unproven histogram:
 *
 *   1. `db` at 846 — is it one pattern or many? (distribution of binding shapes)
 *   2. `page` / `$` — how many sites resolve to a *known non-DB package* import
 *      (a bare specifier that is not in the database-packages manifest), which a
 *      "non-DB package" manifest could close to `not-handle`?
 *
 * Usage:
 *   npx tsx scripts/measure-binding-shapes.ts /path/to/corpus
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { resolveCorpusReceivers } from '../src/analyzers/receiverResolution.js';
import { buildBindingEnv, type Binding, type ValueDescriptor } from '../src/analyzers/receiverRoot.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { readFile } from 'node:fs/promises';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: measure-binding-shapes.ts <projectRoot>');
  process.exit(2);
}

function tally<T>(items: Iterable<T>): Map<T, number> {
  const m = new Map<T, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}

function sorted<T>(m: Map<T, number>): Array<[T, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** A concise shape string for a value descriptor. */
function valueShape(v: ValueDescriptor | undefined): string {
  if (!v) return 'no-value';
  switch (v.kind) {
    case 'literal': return 'literal';
    case 'identifier': return `identifier:${v.name}`;
    case 'new': return `new:${v.ctorName ?? '?'}`;
    case 'call':
      return v.calleeKind === 'member'
        ? `call:member:${v.receiverRoot ?? '?'}`
        : `call:${v.calleeKind}:${v.calleeName ?? '?'}`;
    case 'member': return `member:${v.root ?? '?'}`;
    case 'as': return v.typeText != null ? `as:${v.typeText}` : 'as:?';
    case 'unwrap': return `unwrap:${valueShape(v.operand ?? undefined)}`;
    case 'function': return 'function';
    case 'other': return 'other';
  }
}

/** A concise shape string for a binding. */
function bindingShape(b: Binding | undefined): string {
  if (!b) return 'unbound';
  switch (b.kind) {
    case 'import': return `import:${b.source ?? '?'}`;
    case 'variable': return b.typeText ? `var:typed:${b.typeText}:${valueShape(b.value)}` : `var:${valueShape(b.value)}`;
    case 'field': return b.typeText ? `field:typed:${b.typeText}:${valueShape(b.value)}` : `field:${valueShape(b.value)}`;
    case 'parameter': return b.typeText ? `param:typed:${b.typeText}` : 'param:untyped';
    case 'function': return 'function';
    case 'class': return 'class';
  }
}

/** Is a binding an import from a bare (node_modules) specifier? */
function isBareImport(b: Binding | undefined): b is Binding & { kind: 'import'; source: string } {
  if (!b || b.kind !== 'import' || !b.source) return false;
  const s = b.source;
  return !s.startsWith('./') && !s.startsWith('../') && !s.startsWith('@/') && !s.startsWith('~/');
}

async function main() {
  initializeLanguages();
  await initParsers();

  const report = await resolveCorpusReceivers(projectRoot);
  const sites = report.unprovenQueryReceivers;
  console.log(`total unproven sites: ${sites.length}`);
  console.log(`files: ${new Set(sites.map((s) => s.file)).size}`);

  // Group sites by file, then re-derive each root's binding.
  const registry = LanguageRegistry.getInstance();
  const byFile = new Map<string, typeof sites>();
  for (const s of sites) {
    const list = byFile.get(s.file) ?? [];
    list.push(s);
    byFile.set(s.file, list);
  }

  // site → binding, cached per (file, root).
  const bindingCache = new Map<string, Map<string, Binding | undefined>>();

  for (const [file, fileSites] of byFile) {
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
    const bindings = buildBindingEnv(ast, adapter, content);
    const cache = new Map<string, Binding | undefined>();
    for (const s of fileSites) {
      if (!cache.has(s.root)) cache.set(s.root, bindings.get(s.root));
    }
    bindingCache.set(file, cache);
    ast.dispose?.();
  }

  const shapeOf = (s: (typeof sites)[number]) => bindingShape(bindingCache.get(s.file)?.get(s.root));

  // ── Item 1: `db` distribution ──────────────────────────────────────────────
  const dbSites = sites.filter((s) => s.root === 'db');
  console.log(`\n=== root 'db': ${dbSites.length} sites across ${new Set(dbSites.map((s) => s.file)).size} files ===`);
  const dbShapes = tally(dbSites.map(shapeOf));
  for (const [shape, c] of sorted(dbShapes)) console.log(`  ${c.toString().padStart(4)}  ${shape}`);

  // ── Item 2: known non-DB package imports ────────────────────────────────────
  const bareImportSites = sites.filter((s) => isBareImport(bindingCache.get(s.file)?.get(s.root)));
  console.log(`\n=== bare-specifier (node_modules) import roots: ${bareImportSites.length} sites ===`);
  const byPackage = tally(
    bareImportSites.map((s) => (bindingCache.get(s.file)?.get(s.root) as Binding & { source: string }).source),
  );
  for (const [pkg, c] of sorted(byPackage)) console.log(`  ${c.toString().padStart(4)}  ${pkg}`);

  // Breakdown of the two named roots.
  for (const root of ['page', '$']) {
    const rs = sites.filter((s) => s.root === root);
    console.log(`\n=== root '${root}': ${rs.length} sites ===`);
    const shapes = tally(rs.map(shapeOf));
    for (const [shape, c] of sorted(shapes)) console.log(`  ${c.toString().padStart(4)}  ${shape}`);
  }

  // ── Full classification of all unproven sites (coarse buckets) ─────────────
  const coarse = tally(
    sites.map((s) => {
      const b = bindingCache.get(s.file)?.get(s.root);
      if (!b) return 'unbound (ambient global)';
      if (b.kind === 'import') {
        const src = b.source ?? '?';
        if (isBareImport(b)) return 'import: bare package';
        return 'import: relative/alias';
      }
      return `${b.kind}`;
    }),
  );
  console.log(`\n=== coarse bucket over all ${sites.length} unproven sites ===`);
  for (const [bucket, c] of sorted(coarse)) console.log(`  ${c.toString().padStart(4)}  ${bucket}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
