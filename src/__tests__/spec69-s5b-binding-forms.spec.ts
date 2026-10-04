/**
 * Spec 69 §10 S5b — pin each of the four DB-binding forms in isolation.
 *
 * S5c pins the *end-to-end* five-site must-fire through the combined
 * `private db: Database` + `this.db = new Database()` fixture. That pin would
 * still pass if one of the four forms silently stopped contributing and the
 * other carried the load. This spec pins the forms separately at the
 * `propagateProvenance` boundary so a regression in any single form fails its
 * own test:
 *
 *   form 1 — package import       `import { neon } from '@neondatabase/serverless'`
 *   form 2 — parameter annotation `constructor(db: Database)`            (negative: Spec 70 criterion 9)
 *   form 3 — class-field annotation `private db: Database`   (the queue-worker shape)  (negative: Spec 70 criterion 9)
 *   form 4 — member assignment    `this.db = new Database()` (Database provenanced)
 *
 * Spec 70 criterion 9 deletes the type name as a handle test: `db: Database` no
 * longer seeds provenance with reason `type` — a type annotation is not a proof
 * that the value is a DB handle, only the parsed SQL argument (R3) or a
 * provenanced constructor (form 4) is. Forms 2 and 3 therefore pin the *negative*
 * half: an annotation alone must NOT seed provenance.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { AST, LanguageAdapter } from '../languages/types.js';
import {
  propagateProvenance,
  extractDBProvenancedImports,
} from '../analyzers/provenance.js';
import type { ProvenanceEvidence } from '../analyzers/provenance.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function parse(source: string): { ast: AST; adapter: LanguageAdapter } {
  const path = '/fixture/s5b.ts';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path)!;
  const ast = parseFile(path, source)!;
  return { ast, adapter };
}

function propagate(
  source: string,
  seeds: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
): Map<string, ProvenanceEvidence> {
  const { ast, adapter } = parse(source);
  try {
    return propagateProvenance(ast, adapter, source, new Map(seeds));
  } finally {
    ast.dispose?.();
  }
}

const DB_SEED: ProvenanceEvidence = {
  identifier: 'Database',
  reason: 'module',
  source: 'import { Database } from ./db (in-repo declaration)',
  chain: [],
};

describe('Spec 69 §10 S5b — the four binding forms', () => {
  it('form 1 — a DB package import is a provenance seed', () => {
    const { ast, adapter } = parse(
      'import { neon } from "@neondatabase/serverless";',
    );
    try {
      const seeds = extractDBProvenancedImports(ast, adapter);
      expect(seeds.has('neon')).toBe(true);
      expect(seeds.get('neon')!.reason).toBe('package');
    } finally {
      ast.dispose?.();
    }
  });

  it('form 2 — a parameter type annotation no longer proves a DB handle (criterion 9)', () => {
    const prov = propagate(
      'class Repo { constructor(db: Database) {} run() { return db.query("SELECT 1"); } }',
    );
    // The assertion is the negative pin: the annotation alone is not a handle
    // proof, so `db` must stay out of the provenance map (not `reason: 'type'`).
    expect(prov.has('db')).toBe(false);
  });

  it('form 3 — a class-field type annotation no longer proves a DB handle (criterion 9)', () => {
    const prov = propagate(
      'class Worker { private db: Database; claim() { return this.db.query("SELECT 1"); } }',
    );
    expect(prov.has('db')).toBe(false);
  });

  it('form 4 — this.db = new Database() proves the field from a provenanced constructor', () => {
    const prov = propagate(
      'class Worker { constructor() { this.db = new Database(); } claim() { return this.db.query("SELECT 1"); } }',
      new Map([['Database', DB_SEED]]),
    );
    expect(prov.has('db')).toBe(true);
    expect(prov.get('db')!.reason).toBe('propagation');
    expect(prov.get('db')!.source).toContain('this.db');
  });

  it('negative pin — an unprovenanced member assignment does not prove the field', () => {
    const prov = propagate(
      'class Worker { constructor() { this.db = new Database(); } claim() { return this.db.query("SELECT 1"); } }',
    );
    expect(prov.has('db')).toBe(false);
  });
});
