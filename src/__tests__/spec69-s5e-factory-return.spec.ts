/**
 * Spec 69 §10 S5e — a factory call on a *declared* name resolves through that
 * name's binding, but a factory call on a *truly unbound* name stays `unproven`.
 *
 * `classifyValue`'s identifier-callee branch only accepted a *provenanced* name
 * as `handle` and returned `unproven` for everything else — it never asked
 * `classifyRootIdentifier` whether the declared factory name resolved to a
 * non-handle import. The fix: for an identifier-callee call, fall through to
 * `classifyRootIdentifier` and accept `not-handle` only when the name has a
 * binding in scope. The binding guard matters — a *bare* unbound factory name is
 * NOT proof of non-handle (`getConnection()` might return a connection), so it
 * must stay `unproven`.
 *
 * Spec 70 R4 moved the goalposts on what "declared non-DB" means. `load` imported
 * from `cheerio` is a *bare-specifier node_modules* import, and `cheerio` is not
 * in the database-packages manifest — so the package is *unrecognized*, not
 * "known non-DB". Under R4 an unrecognized package reached by resolution reports
 * `cannot-fire` (`unproven`), never a guessed `not-handle`. The factory path still
 * yields `not-handle` when the binding resolves to a definitively non-DB target
 * (a relative in-repo import, a primitive-typed declaration); a node_modules
 * package we do not list is honest unknown, not clean.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { buildBindingEnv, classifyRootIdentifier } from '../analyzers/receiverRoot.js';
import type { RootResolutionEnv } from '../analyzers/receiverRoot.js';
import type { ProvenanceEvidence } from '../analyzers/provenance.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function envFor(
  source: string,
  provenance: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
): RootResolutionEnv {
  const path = '/fixture/s5e.ts';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path)!;
  const ast = parseFile(path, source)!;
  const bindings = buildBindingEnv(ast, adapter, source);
  // Keep the AST alive across the test; bindings hold node references into it.
  (envFor as unknown as { _ast?: unknown })._ast = ast;
  return { provenance, bindings, adapter, sourceCode: source };
}

const DB_FACTORY_SEED: ProvenanceEvidence = {
  identifier: 'getDb',
  reason: 'package',
  source: 'import { getDb } from "@neondatabase/serverless"',
  chain: [],
};

describe('Spec 69 §10 S5e — factory return on a declared name resolves its binding', () => {
  it('const $ = load(html) with load from cheerio (unrecognized package) → unproven (R4 cannot-fire)', () => {
    const env = envFor('import { load } from "cheerio";\nconst $ = load("<table></table>");\n');
    expect(classifyRootIdentifier('$', env)).toBe('unproven');
  });

  it('a provenanced factory name still yields a handle', () => {
    const env = envFor('const db = getDb();\n', new Map([['getDb', DB_FACTORY_SEED]]));
    expect(classifyRootIdentifier('db', env)).toBe('handle');
  });

  it('const conn = getConnection() with getConnection unbound → unproven (not not-handle)', () => {
    const env = envFor('const conn = getConnection();\n');
    expect(classifyRootIdentifier('conn', env)).toBe('unproven');
  });
});
