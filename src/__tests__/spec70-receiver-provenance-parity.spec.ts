/**
 * Spec 70 Item 4 (2a) — the receiver-provenance fixed point, parity-pinned.
 *
 * The collapse of the double-parse replaces `resolveCorpusReceivers` (the second
 * full-corpus parse) with four additive file facts + the `receiver-provenance`
 * corpus producer. That producer re-derives `fileProvenance` / `fileExports` /
 * `unresolvedImports` from those facts with no AST. While both paths exist, the
 * guarantee is:
 *
 *   computeReceiverProvenance(within-file-provenance, import-specifiers,
 *     export-symbols, go-package-bindings)
 *   ≡ resolveReceiverProvenance(files)   // its fileProvenance + fileExports +
 *                                        // unresolvedImports halves
 *
 * — byte-identical, for every fixture. When the second parse is deleted, this is
 * the proof the corpus producer re-derives the old output. It is the corpus-level
 * sibling of `spec70-ts-within-file-parity.spec.ts`, which pins the *within-file*
 * half (`classify(extract(ast)) ≡ compute(ast)`); together the two pin the whole
 * fixed point, per-file and cross-file.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import type { ProvenanceEvidence } from '../analyzers/provenance.js';
import {
  resolveReceiverProvenance,
  type FileProvenance,
  type FileExports,
  type UnresolvedImport,
  type SourceFile,
} from '../analyzers/receiverResolution.js';
import { computeReceiverProvenance } from '../phase/receiverProvenance.js';
import { extractWithinFileProvenance } from '../phase/withinFileProvenance.js';
import { extractImportSpecifiers } from '../phase/importSpecifiers.js';
import { extractExportSymbols } from '../phase/exportSymbols.js';
import { extractGoPackageBindings } from '../phase/goPackageBindings.js';
import type { AstFile, Format } from '../phase/types.js';

/** Canonical evidence: explicit field order so absent `packageName` is stable. */
function canonEvidence(e: ProvenanceEvidence): unknown[] {
  return [e.identifier, e.reason, e.source, e.chain, e.packageName ?? null];
}

/** Canonical `FileProvenance` — sorted files, sorted names, sorted evidence. */
function canonFileProvenance(fp: FileProvenance): string {
  return JSON.stringify(
    [...fp.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([file, prov]) => [
        file,
        [...prov.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([name, ev]) => [name, canonEvidence(ev)]),
      ]),
  );
}

/** Canonical `FileExports` — sorted files, sorted name sets. */
function canonFileExports(fe: FileExports): string {
  return JSON.stringify(
    [...fe.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([file, names]) => [file, [...names].sort()]),
  );
}

/** Canonical `UnresolvedImport[]` — sorted by (importer, source, names). */
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

/** The format a fixture path declares. */
function formatFor(p: string): Format {
  if (p.endsWith('.go')) return 'go';
  return 'typescript';
}

let adapterFor: (p: string) => LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  const registry = LanguageRegistry.getInstance();
  adapterFor = (p) => {
    const a = registry.getAdapterForFile(p);
    if (!a) throw new Error(`no adapter resolves ${p}`);
    return a;
  };
}, 30_000);

/** The fixture corpus — cross-file imports, wrappers, default/namespace imports,
 *  an unresolved import, and a Go package with cross-file package-scope symbols. */
const FIXTURES: SourceFile[] = [
  {
    path: '/fixture/db.ts',
    content: `import { neon } from '@neondatabase/serverless';
export class Database {
  constructor() { this.sql = neon(process.env.DATABASE_URL); }
  query(t) { return this.sql(t); }
}
`,
  },
  {
    path: '/fixture/app.ts',
    content: `import { Database } from './db';
const db = new Database();
db.query('select 1');
`,
  },
  {
    path: '/fixture/default-export.ts',
    content: `import Database from 'better-sqlite3';
export default function makeDb() { return new Database(':memory:'); }
`,
  },
  {
    path: '/fixture/uses-default.ts',
    content: `import makeDb from './default-export';
const db = makeDb();
`,
  },
  {
    path: '/fixture/namespace.ts',
    content: `import * as db from './db';
db.Database;
`,
  },
  {
    path: '/fixture/unresolved.ts',
    content: `import { Connection } from './nonexistent';
const c = new Connection();
`,
  },
  {
    path: '/fixture/store/db.go',
    content: `package store

import "database/sql"

func NewDB() *sql.DB { return nil }
`,
  },
  {
    path: '/fixture/store/use.go',
    content: `package store

func Get() *sql.DB { return NewDB() }
`,
  },
];

describe('Spec 70 receiver-provenance fixed point — corpus producer ≡ resolveReceiverProvenance', () => {
  it('re-derives fileProvenance / fileExports / unresolvedImports byte-identically', async () => {
    const astFiles: AstFile[] = FIXTURES.map((f) => {
      const ast = parseFile(f.path, f.content)!;
      return {
        file: f.path,
        format: formatFor(f.path),
        source: f.content,
        ast,
        adapter: adapterFor(f.path),
      };
    });

    try {
      const { fileProvenance, fileExports, unresolvedImports } = computeReceiverProvenance(
        astFiles.flatMap((f) => extractWithinFileProvenance(f)),
        astFiles.flatMap((f) => extractImportSpecifiers(f)),
        astFiles.flatMap((f) => extractExportSymbols(f)),
        astFiles.flatMap((f) => extractGoPackageBindings(f)),
        undefined,
      );

      const legacy = await resolveReceiverProvenance(FIXTURES, undefined);

      expect(canonFileProvenance(fileProvenance)).toBe(canonFileProvenance(legacy.fileProvenance));
      expect(canonFileExports(fileExports)).toBe(canonFileExports(legacy.fileExports));
      expect(canonUnresolved(unresolvedImports)).toBe(canonUnresolved(legacy.unresolvedImports));
    } finally {
      for (const f of astFiles) f.ast.dispose?.();
    }
  });

  it('the fixed point actually propagates a cross-file wrapper (not trivially empty)', async () => {
    const astFiles: AstFile[] = FIXTURES.filter((f) => f.path === '/fixture/db.ts' || f.path === '/fixture/app.ts').map((f) => {
      const ast = parseFile(f.path, f.content)!;
      return { file: f.path, format: formatFor(f.path), source: f.content, ast, adapter: adapterFor(f.path) };
    });

    try {
      const { fileProvenance } = computeReceiverProvenance(
        astFiles.flatMap((f) => extractWithinFileProvenance(f)),
        astFiles.flatMap((f) => extractImportSpecifiers(f)),
        astFiles.flatMap((f) => extractExportSymbols(f)),
        astFiles.flatMap((f) => extractGoPackageBindings(f)),
        undefined,
      );
      // `Database` (wrapper, exported by db.ts) and `db` (new Database()) must both
      // be provenanced in app.ts only after the cross-file fixed point runs.
      const app = fileProvenance.get('/fixture/app.ts');
      expect(app?.has('Database'), 'app.ts should prove `Database` via the ./db import').toBe(true);
      expect(app?.has('db'), 'app.ts should prove `db` via propagation from `Database`').toBe(true);
    } finally {
      for (const f of astFiles) f.ast.dispose?.();
    }
  });
});
