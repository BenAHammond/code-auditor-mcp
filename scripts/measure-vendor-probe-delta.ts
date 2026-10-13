/**
 * Item B (reissued) — measure the per-corpus finding delta the vendor probe
 * introduces. For each project root named on the command line, run the
 * data-access slice twice: once with the tree's own resolved vendor surfaces
 * (the probe), once with the empty surface (no probe). Diff the finding
 * multiset and list every added and removed finding.
 *
 * The probe can only move a finding when the analyzed tree *uses* one of the
 * probe-only methods (`iterate`, `mergeInto`, `replaceInto`, `fullJoin`,
 * `*JoinLateral`). On the six pinned corpora none does, so the expected result
 * is `added=0 removed=0` for each — the honest "no drift" the reissued
 * directive's evidence requirement asks to *measure*, not assume.
 *
 * Read-only. Usage:
 *   npx tsx scripts/measure-vendor-probe-delta.ts <root> [root...]
 */
import { readFileSync } from 'node:fs';
import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { runDataAccessSlice, type InputFile } from '../src/phase/runner.js';
import { discoverFiles, ALL_EXTENSIONS } from '../src/utils/fileDiscovery.js';
import { buildResolutionEnvironment } from '../src/graph/resolutionEnvironment.js';
import { resolveVendorSurfaces, EMPTY_VENDOR_SURFACES } from '../src/analyzers/vendorSurfaces.js';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: measure-vendor-probe-delta.ts <root> [root...]');
  process.exit(2);
}

const DATA_ACCESS = new Set(['sql-injection-risk', 'unfiltered-query', 'complex-query', 'missing-org-filter']);

function key(f: { ruleId: string; file: string; line?: number; message: string }, root: string): string {
  const rel = f.file.replace(root, '').replace(/^\//, '');
  return `${f.ruleId}\t${rel}\t${f.line ?? ''}\t${f.message}`;
}

async function measure(root: string): Promise<void> {
  const paths = await discoverFiles(root, { extensions: ALL_EXTENSIONS });
  const files: InputFile[] = paths.map((p) => ({ path: p, content: readFileSync(p, 'utf8') }));
  const sqlDialect = buildResolutionEnvironment(root).sqlDialect;
  const resolved = resolveVendorSurfaces(root);

  const withProbe = (await runDataAccessSlice(files, undefined, sqlDialect, resolved))
    .filter((f) => DATA_ACCESS.has(f.ruleId));
  const withoutProbe = (await runDataAccessSlice(files, undefined, sqlDialect, EMPTY_VENDOR_SURFACES))
    .filter((f) => DATA_ACCESS.has(f.ruleId));

  const w = new Map(withProbe.map((f) => [key(f, root), f]));
  const wo = new Map(withoutProbe.map((f) => [key(f, root), f]));

  const added = [...w.keys()].filter((k) => !wo.has(k));
  const removed = [...wo.keys()].filter((k) => !w.has(k));

  console.log(`\n${root}`);
  console.log(`  data-access findings: with-probe=${withProbe.length}  without-probe=${withoutProbe.length}  added=${added.length}  removed=${removed.length}`);
  for (const a of added) console.log(`    + ${a}`);
  for (const r of removed) console.log(`    - ${r}`);
}

async function main() {
  initializeLanguages();
  await initParsers();
  for (const root of roots) {
    try {
      await measure(root);
    } catch (e) {
      console.log(`\n${root}\n  ERROR: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
