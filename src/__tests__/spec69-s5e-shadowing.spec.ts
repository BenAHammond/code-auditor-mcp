/**
 * Spec 69 §10 S5e — the receiver disposition is name-independent.
 *
 * The defect S5e closes: `cannot-fire` (and, before it, the deleted
 * `DB_RECEIVER_NAMES` list and its `isKnownNonDbReceiver` mirror) keyed on
 * *identifier text*. A single method name can never identify a query, and a
 * single identifier name can never identify a DB handle — `from`, `set`,
 * `first`, `count` … are all ordinary verbs, and `db` can be a logging helper.
 *
 * This spec pins the two shadowing directions with names chosen *because* they
 * are the ones a name list would most confidently misclassify:
 *
 *   • local `path` shadows the `node:path` module as a *DB handle* — the name
 *     must NOT be quieted (a "known global" list would report it `clean`); it
 *     must resolve to `handle` through its actual binding.
 *   • local `db` is a *logging helper* — the name must NOT be fired on (the
 *     old `DB_RECEIVER_NAMES` list would extract it as a DB receiver); it must
 *     resolve to `not-handle` through its actual object-literal binding.
 *
 * Both are asserted at the classifier boundary (`classifyRootIdentifier`) and at
 * the enumerator boundary (`collectUnprovenQueryReceivers`), so a name-list
 * regression fails a test instead of a corpus.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { AST, LanguageAdapter } from '../languages/types.js';
import type { ProvenanceEvidence } from '../analyzers/provenance.js';
import {
  buildBindingEnv,
  classifyRootIdentifier,
} from '../analyzers/receiverRoot.js';
import type { RootResolutionEnv } from '../analyzers/receiverRoot.js';
import { collectUnprovenQueryReceivers } from '../analyzers/receiverResolution.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function parse(source: string): { ast: AST; adapter: LanguageAdapter; source: string } {
  const path = '/fixture/s5e-shadowing.ts';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path)!;
  const ast = parseFile(path, source)!;
  return { ast, adapter, source };
}

const DB_SEED: ProvenanceEvidence = {
  identifier: 'Database',
  reason: 'module',
  source: 'import { Database } from ./db (in-repo declaration)',
  chain: [],
};

/** Classify a bare root name under a file's own bindings plus an optional seed. */
function classify(
  source: string,
  name: string,
  provenance: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
): string {
  const { ast, adapter, source: sourceCode } = parse(source);
  try {
    const bindings = buildBindingEnv(ast, adapter, sourceCode);
    const env: RootResolutionEnv = { provenance, bindings, adapter, sourceCode };
    return classifyRootIdentifier(name, env);
  } finally {
    ast.dispose?.();
  }
}

function unproven(
  source: string,
  provenance: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
) {
  const { ast, adapter, source: sourceCode } = parse(source);
  try {
    return collectUnprovenQueryReceivers(
      { filePath: '/fixture/s5e-shadowing.ts', sourceCode, ast, adapter },
      provenance,
    );
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 69 §10 S5e — shadowing (name independence)', () => {
  describe('local `path` shadows the module', () => {
    it('a local `path` bound to a DB handle resolves to handle — NOT quieted by its name', () => {
      const src = 'const path = new Database(conn);';
      expect(classify(src, 'path', new Map([['Database', DB_SEED]]))).toBe('handle');
    });

    it('the same `path` as an ambient global resolves to not-handle', () => {
      // No binding in the file — `path` is the node:path module / a global.
      expect(classify('path.join("a", "b");', 'path')).toBe('not-handle');
    });

    it('enumerator: a handle-bound `path` emits no cannot-fire (the finding path owns it)', () => {
      const src = 'const path = new Database(conn);\npath.query("SELECT 1");';
      expect(unproven(src, new Map([['Database', DB_SEED]]))).toEqual([]);
    });
  });

  describe('local `db` is a logging helper', () => {
    it('a local `db` bound to an object literal resolves to not-handle — NOT fired on by its name', () => {
      const src = 'const db = { query: (m: string) => console.log(m) };';
      expect(classify(src, 'db')).toBe('not-handle');
    });

    it('the same `db` bound to a DB handle resolves to handle', () => {
      const src = 'const db = new Database(conn);';
      expect(classify(src, 'db', new Map([['Database', DB_SEED]]))).toBe('handle');
    });

    it('enumerator: a logging-helper `db` emits no cannot-fire for its query-shaped call', () => {
      const src = [
        'const db = { query: (m: string) => console.log(m) };',
        'db.query("SELECT 1");',
      ].join('\n');
      expect(unproven(src)).toEqual([]);
    });
  });

  it('enumerator: an un-annotated factory return is still cannot-fire (unproven, not quieted)', () => {
    const src = 'const dataSource = getConnection();\ndataSource.query(sql);';
    const out = unproven(src);
    expect(out).toHaveLength(1);
    expect(out[0].receiver).toBe('dataSource');
    expect(out[0].reason).toContain('no in-repo declaration');
  });
});
