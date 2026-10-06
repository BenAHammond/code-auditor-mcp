/**
 * Probe: what disposition does the production receiver resolution return for a
 * `this.env.DB` (Cloudflare D1) site vs a proven `db` handle? Uses the exact
 * production functions (`extractR3Sites`, `buildBindingEnv`,
 * `extractTsWithinFileProvenance`, `classifyBuildProvenance`, `identifyHandle`)
 * the `data-access-calls` consumer folds. Read-only.
 *
 * Usage:
 *   npx tsx scripts/probe-d1.ts /tmp/d1probe
 */
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import { buildBindingEnv, type RootResolutionEnv } from '../src/analyzers/receiverRoot.js';
import {
  extractR3Sites,
  extractTsWithinFileProvenance,
  type ProvenanceEvidence,
} from '../src/analyzers/provenance.js';
import { identifyHandle } from '../src/analyzers/handleIdentification.js';
import { classifyBuildProvenance } from '../src/phase/receiverProvenance.js';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Dialect } from '../src/mcp-tools/discoveryQueries.js';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: probe-d1.ts <projectRoot>');
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
      const dbProvenanced = classifyBuildProvenance(extract, new Map(), bindings, r3Sites, null as Dialect | null);
      const env: RootResolutionEnv = { provenance: dbProvenanced, bindings, adapter, sourceCode: content };

      console.log(`\n=== ${name} ===`);
      console.log(`  dbProvenanced: [${[...dbProvenanced.keys()].join(', ') || '(empty)'}]`);
      for (const site of r3Sites) {
        const verdict = identifyHandle(
          { format: 'typescript', root: site.root, receiver: site.receiver, method: site.method, sqlArgument: site.sqlArgument, thisField: site.thisField },
          {
            imports: new Map(), typeAnnotations: new Map(), bindings: new Map(), withinFileProvenance: new Map(),
            sqlDialect: null, resolution: { dialect: 'ts', env },
          },
        );
        console.log(`  site root=${site.root} receiver=${site.receiver} method=${site.method} thisField=${site.thisField} sql=${JSON.stringify(site.sqlArgument).slice(0, 40)} → verdict.kind=${verdict.kind} via=${(verdict as any).via ?? '?'} reason=${(verdict as any).reason ?? ''}`);
      }
      if (r3Sites.length === 0) console.log('  (no R3 sites — no static SQL member call)');
    } finally {
      ast.dispose?.();
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
