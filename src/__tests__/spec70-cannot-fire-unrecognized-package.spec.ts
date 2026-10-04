/**
 * Spec 70 R4 criterion #11 — an unrecognized package reached by resolution
 * reports `cannot-fire`, not a guessed verdict.
 *
 * R4 collapses "which packages are database clients" into one declarative data
 * file per ecosystem (`database-packages.json` beside each format adapter). A
 * package the file does not recognize, reached by resolution, is an honest
 * unknown — it might be an unlisted ORM — so it reports `unproven` (the
 * cannot-fire surface), never `not-handle` (silently clean). Adding an ORM is a
 * data edit that turns `cannot-fire` into a verdict; failing to add it never
 * produces a *wrong* verdict.
 *
 * The demonstration acceptance asks for is "remove an entry and observe
 * cannot-fire rather than a changed verdict": `knex` is in the TypeScript
 * manifest, so a seeded `knex` proves `handle`; without the seed (the entry
 * removed) classification falls through to `classifyImportSource`, which now
 * reports `unproven` rather than the old `not-handle`. Go mirrors it with a real
 * SQL package that is *not* in the Go manifest (`github.com/jmoiron/sqlx`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { buildBindingEnv, classifyRootIdentifier, type RootResolutionEnv } from '../analyzers/receiverRoot.js';
import {
  buildGoBindingEnv,
  buildGoImportMap,
  classifyGoRootIdentifier,
  type GoResolutionEnv,
} from '../languages/go/goResolution.js';
import type { ProvenanceEvidence } from '../analyzers/provenance.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function tsEnv(source: string, provenance: ReadonlyMap<string, ProvenanceEvidence> = new Map()): RootResolutionEnv {
  const path = '/fixture/c11.ts';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path)!;
  const ast = parseFile(path, source)!;
  const bindings = buildBindingEnv(ast, adapter, source);
  (tsEnv as unknown as { _ast?: unknown })._ast = ast;
  return { provenance, bindings, adapter, sourceCode: source };
}

function goEnv(source: string): GoResolutionEnv {
  const path = '/fixture/c11.go';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path)!;
  const ast = parseFile(path, source)!;
  const bindings = buildGoBindingEnv(ast, adapter, source);
  const imports = buildGoImportMap(ast, adapter);
  (goEnv as unknown as { _ast?: unknown })._ast = ast;
  return { provenance: new Map(), bindings, imports, adapter, sourceCode: source };
}

const KNEX_SEED: ProvenanceEvidence = {
  identifier: 'knex',
  reason: 'package',
  source: 'import { knex } from "knex"',
  chain: [],
};

describe('Spec 70 R4 criterion #11 — unrecognized package reports cannot-fire', () => {
  describe('TypeScript', () => {
    it('a package in the manifest proves handle via provenance seeding', () => {
      const env = tsEnv('import { knex } from "knex";\n', new Map([['knex', KNEX_SEED]]));
      expect(classifyRootIdentifier('knex', env)).toBe('handle');
    });

    it('removing that entry (no seed) reports unproven — not a changed not-handle verdict', () => {
      const env = tsEnv('import { knex } from "knex";\n');
      expect(classifyRootIdentifier('knex', env)).toBe('unproven');
    });

    it('a package never in the manifest (sequelize) reports unproven, never not-handle', () => {
      const env = tsEnv('import { Sequelize } from "sequelize";\n');
      expect(classifyRootIdentifier('Sequelize', env)).toBe('unproven');
    });
  });

  describe('Go', () => {
    it('database/sql (in the manifest) proves handle', () => {
      const env = goEnv('package main\n\nimport "database/sql"\n\nfunc getUser(db *sql.DB) {}\n');
      expect(classifyGoRootIdentifier('sql', env)).toBe('handle');
    });

    it('an unlisted SQL package (github.com/jmoiron/sqlx) reports unproven, never not-handle', () => {
      const env = goEnv('package main\n\nimport "github.com/jmoiron/sqlx"\n\nfunc getUser(db *sqlx.DB) {}\n');
      expect(classifyGoRootIdentifier('sqlx', env)).toBe('unproven');
    });

    it('a non-DB package (net/http) reached by resolution reports unproven, never not-handle', () => {
      const env = goEnv('package main\n\nimport "net/http"\n\nfunc handler(w http.ResponseWriter) {}\n');
      expect(classifyGoRootIdentifier('http', env)).toBe('unproven');
    });
  });
});
