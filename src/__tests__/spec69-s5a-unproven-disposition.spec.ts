/**
 * Spec 69 §10 S5a — the disposition model: a query-shaped call site's receiver is
 * given an explicit disposition, never a silent `clean`.
 *
 * The root defect S5a fixes: `cannot-fire` used to be keyed to a *resolution
 * step failing* (an unresolved import), so every other way of not knowing a
 * receiver's DB-ness reported `clean`. S5a replaces that with a three-way
 * disposition on the receiver itself:
 *
 *   - proven-handle        → skipped here (the finding path extracts it and fires).
 *   - proven-not-a-handle  → `clean` (a literal/object/array declaration).
 *   - unproven             → `cannot-fire` with a reason, whatever the cause.
 *
 * `clean` is reachable *only* from proven-not-a-handle. This spec pins that
 * three-way split at the classifier boundary (`collectUnprovenQueryReceivers`) and
 * at the emission boundary (`checkUnprovenQueryReceivers`), so a change that
 * silently re-cleans an unproven receiver fails a test instead of a corpus.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { AST, LanguageAdapter } from '../languages/types.js';
import type { ProvenanceEvidence } from '../analyzers/provenance.js';
import {
  collectUnprovenQueryReceivers,
  isProvablyNonDbDeclaration,
} from '../analyzers/receiverResolution.js';
import {
  checkUnprovenQueryReceivers,
  checkUnresolvedReceiverImports,
  dedupeCannotFireByReceiver,
} from '../analyzers/universal/schema/codeAnalysis.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function parse(source: string): { ast: AST; adapter: LanguageAdapter; source: string } {
  const path = '/fixture/s5a.ts';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path)!;
  const ast = parseFile(path, source)!;
  return { ast, adapter, source };
}

/** Run the classifier over one file's source with an empty (within-file-only) seed. */
function unproven(
  source: string,
  provenance: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
) {
  const { ast, adapter } = parse(source);
  try {
    return collectUnprovenQueryReceivers(
      { filePath: '/fixture/s5a.ts', sourceCode: source, ast, adapter },
      provenance,
    );
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 69 §10 S5a — disposition replaces step-failure', () => {
  it('proven-not-a-handle (literal declaration) is clean — not a cannot-fire', () => {
    const src = [
      'const dataSource = "not a database";',
      'dataSource.query("SELECT 1");',
    ].join('\n');
    expect(unproven(src)).toEqual([]);
  });

  it('proven-handle (seeded) is clean here — the finding path fires, not a cannot-fire', () => {
    const seed: ReadonlyMap<string, ProvenanceEvidence> = new Map([
      ['db', { identifier: 'db', reason: 'binding', source: 'test seed', chain: [] }],
    ]);
    const src = 'db.query("SELECT 1");';
    expect(unproven(src, seed)).toEqual([]);
  });

  it('unproven receiver (call-initialized, no in-repo declaration) is cannot-fire, not clean', () => {
    const src = [
      'const dataSource = getConnection();',
      'dataSource.query(sql);',
    ].join('\n');
    const out = unproven(src);
    expect(out).toHaveLength(1);
    expect(out[0].receiver).toBe('dataSource');
    expect(out[0].method).toBe('query');
    expect(out[0].reason).toContain('no in-repo declaration');
  });

  it('a compound/this receiver with no annotation is cannot-fire', () => {
    const src = [
      'class Repo {',
      '  run() { this.pool.query(sql); }',
      '}',
    ].join('\n');
    const out = unproven(src);
    expect(out).toHaveLength(1);
    expect(out[0].receiver).toBe('this.pool');
    expect(out[0].reason).toContain('class field');
  });

  it('emits a cannot-fire diagnostic (never a clean omission) via checkUnprovenQueryReceivers', () => {
    const diags = checkUnprovenQueryReceivers(
      [{ receiver: 'dataSource', method: 'query', line: 2, reason: 'no in-repo declaration' }],
      '/fixture/s5a.ts',
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].kind).toBe('cannot-fire');
    expect(diags[0].analyzerName).toBe('schema');
    expect(diags[0].message).toContain('.query()');
    expect(diags[0].message).toContain('dataSource');
    expect(diags[0].line).toBe(2);
  });
});

describe('Spec 69 §10 Q3 — one receiver gets one cannot-fire disposition', () => {
  const FILE = '/fixture/q3.ts';

  function emitBoth() {
    const importDiags = checkUnresolvedReceiverImports(
      [{ source: './db', names: ['db'] }],
      FILE,
    );
    const siteDiags = checkUnprovenQueryReceivers(
      [{ receiver: 'db', method: 'query', line: 3, reason: 'no in-repo declaration' }],
      FILE,
    );
    return [...importDiags, ...siteDiags];
  }

  it('a receiver imported from an unresolvable specifier AND called is two raw diagnostics', () => {
    expect(emitBoth()).toHaveLength(2);
  });

  it('dedupe collapses the two into one, keeping the call-site signal (precise line)', () => {
    const deduped = dedupeCannotFireByReceiver(emitBoth());
    expect(deduped).toHaveLength(1);
    expect(deduped[0].kind).toBe('cannot-fire');
    expect(deduped[0].line).toBe(3);
    expect(deduped[0].details?.receiver).toBe('db');
  });

  it('an import name never called survives as the import-level signal', () => {
    const diags = checkUnresolvedReceiverImports(
      [{ source: './db', names: ['db'] }],
      FILE,
    );
    expect(dedupeCannotFireByReceiver(diags)).toHaveLength(1);
    expect(dedupeCannotFireByReceiver(diags)[0].line).toBe(0);
  });

  it('a compound receiver (this.db) dedupes against its bare name db', () => {
    const importDiags = checkUnresolvedReceiverImports(
      [{ source: './db', names: ['db'] }],
      FILE,
    );
    const siteDiags = checkUnprovenQueryReceivers(
      [{ receiver: 'this.db', method: 'query', line: 9, reason: 'class field' }],
      FILE,
    );
    const deduped = dedupeCannotFireByReceiver([...importDiags, ...siteDiags]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].details?.receiver).toBe('this.db');
  });

  it('an import with a called name and an uncalled name keeps only the uncalled one', () => {
    const importDiags = checkUnresolvedReceiverImports(
      [{ source: './db', names: ['db', 'pool'] }],
      FILE,
    );
    const siteDiags = checkUnprovenQueryReceivers(
      [{ receiver: 'db', method: 'query', line: 4, reason: 'no in-repo declaration' }],
      FILE,
    );
    const deduped = dedupeCannotFireByReceiver([...importDiags, ...siteDiags]);
    // call-site (db) + import-level trimmed to just `pool`.
    expect(deduped).toHaveLength(2);
    const importDiag = deduped.find((d) => d.line === 0)!;
    expect(importDiag.details?.names).toEqual(['pool']);
  });
});

describe('isProvablyNonDbDeclaration — the proven-not-a-handle gate', () => {
  it('a string-literal declaration is provably non-DB', () => {
    const { ast, adapter, source } = parse('const dataSource = "config";');
    try {
      expect(isProvablyNonDbDeclaration('dataSource', ast, adapter, source)).toBe(true);
    } finally {
      ast.dispose?.();
    }
  });

  it('an object-literal declaration is provably non-DB', () => {
    const { ast, adapter, source } = parse('const dataSource = { run() {} };');
    try {
      expect(isProvablyNonDbDeclaration('dataSource', ast, adapter, source)).toBe(true);
    } finally {
      ast.dispose?.();
    }
  });

  it('a call-initialized declaration is NOT provably non-DB (falls to unproven)', () => {
    const { ast, adapter, source } = parse('const dataSource = getConnection();');
    try {
      expect(isProvablyNonDbDeclaration('dataSource', ast, adapter, source)).toBe(false);
    } finally {
      ast.dispose?.();
    }
  });
});
