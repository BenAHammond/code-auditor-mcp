/**
 * Item 2 probe — the declaration-resolution arm for a NON-literal D1 site
 * (`env.DB.prepare(sqlVar)` / `env.DB.batch(stmts)`), where R3 has no static
 * literal to prove `env`. Shows the exact binding for `env`, the `identifyHandle`
 * verdict with `sqlArgument: null`, and — by temporarily seeding the manifest —
 * whether adding `@cloudflare/workers-types` would change the disposition.
 * Uses production functions only. Read-only.
 *
 * Usage:
 *   npx tsx scripts/probe-d1-declaration.ts /tmp/d1nonlit
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import { buildBindingEnv, classifyRootIdentifier, type RootResolutionEnv } from '../src/analyzers/receiverRoot.js';
import { extractR3Sites, extractTsWithinFileProvenance } from '../src/analyzers/provenance.js';
import { identifyHandle } from '../src/analyzers/handleIdentification.js';
import { classifyBuildProvenance } from '../src/phase/receiverProvenance.js';
import { DB_PACKAGES } from '../src/analyzers/tsEcosystem.js';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: probe-d1-declaration.ts <projectRoot>');
  process.exit(2);
}

async function main() {
  initializeLanguages();
  await initParsers();
  const registry = LanguageRegistry.getInstance();

  const entries = await readdir(projectRoot);
  for (const name of entries.filter((n) => n.endsWith('.ts')).sort()) {
    const file = path.join(projectRoot, name);
    const content = await readFile(file, 'utf8');
    const adapter = registry.getAdapterForFile(file);
    if (!adapter) continue;
    const ast = parseFile(file, content)!;
    try {
      const extract = extractTsWithinFileProvenance(ast, adapter, content);
      const bindings = buildBindingEnv(ast, adapter, content);
      const r3Sites = extractR3Sites(ast, adapter, content);
      const dbProvenanced = classifyBuildProvenance(extract, new Map(), bindings, r3Sites, null);
      const env: RootResolutionEnv = { provenance: dbProvenanced, bindings, adapter, sourceCode: content };

      console.log(`\n=== ${name} ===`);
      console.log(`  manifest has @cloudflare/workers-types? ${DB_PACKAGES.has('@cloudflare/workers-types')}`);
      console.log(`  r3Sites: ${r3Sites.length} (literal SQL sites)`);
      console.log(`  dbProvenanced: [${[...dbProvenanced.keys()].join(', ') || '(empty)'}]`);
      const envBinding = bindings.get('env');
      console.log(`  binding for 'env': kind=${envBinding?.kind} typeText=${JSON.stringify(envBinding?.typeText ?? null)}`);

      // Non-literal site — the receiver is env.DB, root is env, no SQL arg.
      const site = { format: 'typescript' as const, root: 'env', receiver: 'env.DB', method: 'prepare', sqlArgument: null, thisField: false };
      const verdict = identifyHandle(site, {
        imports: new Map(), typeAnnotations: new Map(), bindings: new Map(), withinFileProvenance: new Map(),
        sqlDialect: null, resolution: { dialect: 'ts' as const, env },
      });
      console.log(`  identifyHandle(env.DB.prepare(sqlVar)) → kind=${verdict.kind} reason=${JSON.stringify((verdict as any).reason ?? '')}`);

      const rootDisposition = classifyRootIdentifier('env', env, 0, { thisField: false });
      console.log(`  classifyRootIdentifier('env') → ${rootDisposition}`);

      // Simulate: if @cloudflare/workers-types WERE in the manifest, would the
      // type-annotation path change? `classifyRootIdentifier('env')` consults the
      // binding's typeText ('Env'), which classifies the TYPE NAME, not the import
      // package — so the manifest is never read for a parameter-typed receiver.
      (DB_PACKAGES as Set<string>).add('@cloudflare/workers-types');
      const rootDisposition2 = classifyRootIdentifier('env', env, 0, { thisField: false });
      console.log(`  classifyRootIdentifier('env') AFTER adding manifest entry → ${rootDisposition2}  (unchanged? ${rootDisposition === rootDisposition2})`);
      (DB_PACKAGES as Set<string>).delete('@cloudflare/workers-types');
    } finally {
      ast.dispose?.();
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
