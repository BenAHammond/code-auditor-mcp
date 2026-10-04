/**
 * Spec 70 Item 3 step 5 — six-corpus receiver-provenance parity.
 *
 * The collapse of the double-parse replaces `resolveCorpusReceivers` (the second
 * full-corpus parse) with four additive file facts + the `receiver-provenance`
 * corpus producer. The fixture-level parity spec (`spec70-receiver-provenance-parity.spec.ts`)
 * pins, for representative fixtures:
 *
 *   computeReceiverProvenance(within-file-provenance, import-specifiers,
 *     export-symbols, go-package-bindings)
 *   ≡ resolveReceiverProvenance(files)   // fileProvenance + fileExports +
 *                                        // unresolvedImports
 *
 * This script scales that assertion to the six real validation corpora, so the
 * byte-identical guarantee is proven on real code, not only on fixtures.
 *
 * The one known map-shape difference is normalized before comparison: the kept
 * path (`resolveReceiverProvenance`) records an *empty* entry for a file with no
 * DB signal, while the phase path (`computeReceiverProvenance`) omits that file
 * entirely (`extractWithinFileProvenance` returns `[]` when `extract.kind` is
 * `none`). The consumers read both identically (`fileProvenance.get(file)?.has`
 * is false for both an empty map and a missing entry), so the two shapes are
 * reconciled to "no provenanced names" before the byte comparison.
 *
 * Read-only: it reads the corpus files and writes nothing into the target. It
 * does not touch the index or ledger (no `runAudit`), so no data dir is needed.
 *
 * Usage (from app/):
 *   npx tsx scripts/measure-receiver-provenance-parity.ts /path/to/corpus
 */

import { initializeLanguages } from '../src/languages/index.js';
import { initParsers } from '../src/languages/tree-sitter/parser.js';
import { LanguageRegistry } from '../src/languages/LanguageRegistry.js';
import { parseFile } from '../src/languages/adapterBridge.js';
import { findFiles } from '../src/utils/fileDiscovery.js';
import {
  resolveReceiverProvenance,
  type FileProvenance,
  type FileExports,
  type UnresolvedImport,
} from '../src/analyzers/receiverResolution.js';
import type { ProvenanceEvidence } from '../src/analyzers/provenance.js';
import { computeReceiverProvenance } from '../src/phase/receiverProvenance.js';
import { extractWithinFileProvenance } from '../src/phase/withinFileProvenance.js';
import { extractImportSpecifiers } from '../src/phase/importSpecifiers.js';
import { extractExportSymbols } from '../src/phase/exportSymbols.js';
import { extractGoPackageBindings } from '../src/phase/goPackageBindings.js';
import type { AstFile, Format } from '../src/phase/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('usage: npx tsx scripts/measure-receiver-provenance-parity.ts <corpus-root>');
  process.exit(2);
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.go'];

function formatFor(p: string): Format {
  return p.endsWith('.go') ? 'go' : 'typescript';
}

/** Canonical evidence — explicit field order so absent `packageName` is stable. */
function canonEvidence(e: ProvenanceEvidence): unknown[] {
  return [e.identifier, e.reason, e.source, e.chain, e.packageName ?? null];
}

/** Canonical per-name provenance map → sorted string. */
function canonProvMap(prov: ReadonlyMap<string, ProvenanceEvidence>): string {
  return JSON.stringify(
    [...prov.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, e]) => [n, canonEvidence(e)]),
  );
}

/** Canonical file-provenance map, empty ≡ missing (a file absent from one map is
 *  reconciled to the empty provenance map). */
function canonFileProvenance(fp: FileProvenance): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, prov] of fp) out.set(file, canonProvMap(prov));
  return out;
}

/** Canonical file-exports map, empty ≡ missing. */
function canonFileExports(fe: FileExports): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, names] of fe) out.set(file, JSON.stringify([...names].sort()));
  return out;
}

/** Canonical unresolved-import list → sorted string. */
function canonUnresolved(ur: readonly UnresolvedImport[]): string {
  return JSON.stringify(
    ur
      .map((u) => [u.importer, u.source, u.names] as const)
      .sort((a, b) => {
        const ka = JSON.stringify(a);
        const kb = JSON.stringify(b);
        return ka < kb ? -1 : 1;
      }),
  );
}

async function main() {
  initializeLanguages();
  await initParsers();
  const registry = LanguageRegistry.getInstance();

  const discovered = await findFiles(projectRoot, { extensions: EXTENSIONS });

  // Read + parse once for the phase path; the kept path re-parses internally.
  const sourceFiles: { path: string; content: string }[] = [];
  const withinFacts: ReturnType<typeof extractWithinFileProvenance> = [];
  const importFacts: ReturnType<typeof extractImportSpecifiers> = [];
  const exportFacts: ReturnType<typeof extractExportSymbols> = [];
  const goFacts: ReturnType<typeof extractGoPackageBindings> = [];

  let parsed = 0;
  let skipped = 0;
  for (const f of discovered) {
    if (f.includes('node_modules') || f.includes('/dist/') || f.includes('/build/') || f.includes('/.next/')) {
      skipped++;
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(f, 'utf-8');
    } catch {
      skipped++;
      continue;
    }
    sourceFiles.push({ path: f, content });

    const adapter = registry.getAdapterForFile(f);
    if (!adapter) {
      skipped++;
      continue;
    }
    const ast = parseFile(f, content);
    if (!ast) {
      skipped++;
      continue;
    }
    const astFile: AstFile = { file: f, format: formatFor(f), source: content, ast, adapter };
    withinFacts.push(...extractWithinFileProvenance(astFile));
    importFacts.push(...extractImportSpecifiers(astFile));
    exportFacts.push(...extractExportSymbols(astFile));
    goFacts.push(...extractGoPackageBindings(astFile));
    ast.dispose?.();
    parsed++;
  }

  const phase = computeReceiverProvenance(withinFacts, importFacts, exportFacts, goFacts, projectRoot);
  const kept = await resolveReceiverProvenance(sourceFiles, projectRoot);

  // ── Compare (empty ≡ missing for the two maps; the list is exact) ──────────
  const phaseProv = canonFileProvenance(phase.fileProvenance);
  const keptProv = canonFileProvenance(kept.fileProvenance);
  const provKeys = new Set([...phaseProv.keys(), ...keptProv.keys()]);
  const provMismatches: Array<{ file: string; phase: string; kept: string }> = [];
  for (const f of provKeys) {
    const a = phaseProv.get(f) ?? '[]';
    const b = keptProv.get(f) ?? '[]';
    if (a !== b) provMismatches.push({ file: f, phase: a, kept: b });
  }

  const phaseExports = canonFileExports(phase.fileExports);
  const keptExports = canonFileExports(kept.fileExports);
  const exportKeys = new Set([...phaseExports.keys(), ...keptExports.keys()]);
  const exportMismatches: Array<{ file: string; phase: string; kept: string }> = [];
  for (const f of exportKeys) {
    const a = phaseExports.get(f) ?? '[]';
    const b = keptExports.get(f) ?? '[]';
    if (a !== b) exportMismatches.push({ file: f, phase: a, kept: b });
  }

  const unresolvedMismatch = canonUnresolved(phase.unresolvedImports) !== canonUnresolved(kept.unresolvedImports);

  const dbSignalFiles = [...phaseProv.values()].filter((v) => v !== '[]').length;

  console.log(`=== corpus: ${path.basename(path.resolve(projectRoot))} ===`);
  console.log(`discovered: ${discovered.length}, skipped: ${skipped}, parsed (phase): ${parsed}`);
  console.log(`files with DB signal: ${dbSignalFiles}`);
  console.log(
    `fileProvenance: ${provMismatches.length === 0 ? 'PARITY ✓' : `MISMATCH ×${provMismatches.length}`}`,
  );
  console.log(
    `fileExports:     ${exportMismatches.length === 0 ? 'PARITY ✓' : `MISMATCH ×${exportMismatches.length}`}`,
  );
  console.log(
    `unresolvedImports: ${unresolvedMismatch ? 'MISMATCH ×' : 'PARITY ✓'} (phase ${phase.unresolvedImports.length}, kept ${kept.unresolvedImports.length})`,
  );

  if (provMismatches.length > 0) {
    console.log('\n--- fileProvenance mismatches (first 10) ---');
    for (const m of provMismatches.slice(0, 10)) {
      console.log(`\n${m.file}\n  phase: ${m.phase}\n  kept:  ${m.kept}`);
    }
  }
  if (exportMismatches.length > 0) {
    console.log('\n--- fileExports mismatches (first 10) ---');
    for (const m of exportMismatches.slice(0, 10)) {
      console.log(`\n${m.file}\n  phase: ${m.phase}\n  kept:  ${m.kept}`);
    }
  }

  const ok = provMismatches.length === 0 && exportMismatches.length === 0 && !unresolvedMismatch;
  console.log(ok ? '\nPARITY: byte-identical ✓' : '\nPARITY: MISMATCH');
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
