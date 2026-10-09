/**
 * Spec 70 R1.2 — the two evidence sources are independent siblings.
 *
 * A receiver's disposition is the fold of two sources that each prove or abstain
 * on their own: `sql-argument` (the call's static SQL text) and
 * `declaration-resolution` (the receiver root's binding). `identifyHandle` runs
 * *both* and folds them with the precedence `handle` > `not-handle` > `unproven`
 * (Spec 70 R1.2) — admission may be decided by either source, but the verdict is
 * always the combination of both. The bug this suite is a regression guard for:
 * one source silently gating the other. Three times in this area a present SQL
 * argument (or its absence) was allowed to skip the declaration-resolution
 * half, so a root that resolution had *disproved* (`expect` from `vitest`, a
 * Hono app) leaked back into the cannot-fire surface as `unproven`.
 *
 * Each test below disables one source and asserts the other still reaches its
 * verdict. The not-handle test *keeps a SQL argument present* (an unparseable
 * one, so `sql-argument` abstains) — that is the exact shape that must not gate
 * `declaration-resolution`'s proof.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { identifyHandle, type HandleVerdict } from '../analyzers/handleIdentification.js';
import type { RootResolutionEnv, Binding } from '../analyzers/receiverRoot.js';
import type { ProvenanceEvidence } from '../analyzers/provenance.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** Fold one site through `identifyHandle` with a hand-built TS resolution env. */
function verdict(opts: {
  root?: string;
  receiver?: string;
  method?: string;
  sqlArgument?: string | null;
  bindings?: ReadonlyMap<string, Binding>;
  provenance?: ReadonlyMap<string, ProvenanceEvidence>;
  declaredTypePackages?: ReadonlySet<string>;
}): HandleVerdict {
  const env = {
    provenance: opts.provenance ?? new Map<string, ProvenanceEvidence>(),
    bindings: opts.bindings ?? new Map<string, Binding>(),
    declaredTypePackages: opts.declaredTypePackages,
    adapter: undefined,
    sourceCode: '',
  } as unknown as RootResolutionEnv;
  return identifyHandle(
    {
      format: 'typescript',
      root: opts.root ?? 'db',
      receiver: opts.receiver ?? 'db.prepare',
      method: opts.method ?? 'prepare',
      sqlArgument: opts.sqlArgument ?? null,
      thisField: false,
    },
    {
      imports: new Map(),
      typeAnnotations: new Map(),
      bindings: new Map(),
      withinFileProvenance: new Map(),
      sqlDialect: 'postgresql',
      resolution: { dialect: 'ts', env },
    },
  );
}

/** A package-import provenance seed, shaped to `classifyRootIdentifier`'s read. */
function packageSeed(name: string): ProvenanceEvidence {
  return { identifier: name, reason: 'package', source: 'import from pg', chain: [] };
}

describe('Spec 70 R1.2 — evidence sources are independent siblings', () => {
  it('`sql-argument` alone proves `handle` (declaration-resolution abstains)', () => {
    // Root `db` is an un-annotated parameter → declaration-resolution abstains
    // (`unproven`). The parseable SQL argument must still prove `handle`.
    const v = verdict({
      root: 'db',
      receiver: 'db.prepare',
      method: 'prepare',
      sqlArgument: 'SELECT * FROM users',
      bindings: new Map([['db', { kind: 'parameter' }]]),
    });
    expect(v).toEqual({ kind: 'handle', via: 'sql-argument' });
  });

  it('`declaration-resolution` alone proves `handle` (sql-argument absent)', () => {
    // No SQL argument → `sql-argument` stays silent (empty reason). A
    // package-import provenance seed must still prove `handle`.
    const v = verdict({
      root: 'db',
      receiver: 'db.query',
      method: 'query',
      sqlArgument: null,
      provenance: new Map([['db', packageSeed('db')]]),
    });
    expect(v).toEqual({ kind: 'handle', via: 'declaration-resolution' });
  });

  it('`declaration-resolution` alone proves `not-handle` (sql-argument absent)', () => {
    // A named import from a *declared non-DB package* (Fix 2) is resolution
    // disproving. With no SQL argument, only `declaration-resolution` can speak,
    // and it must prove `not-handle`.
    const v = verdict({
      root: 'expect',
      receiver: 'expect.toBe',
      method: 'toBe',
      sqlArgument: null,
      bindings: new Map([['expect', { kind: 'import', source: 'vitest', importKind: 'named' }]]),
      declaredTypePackages: new Set(['vitest']),
    });
    expect(v).toEqual({ kind: 'not-handle', via: 'declaration-resolution' });
  });

  it('`declaration-resolution` proves `not-handle` with a present SQL argument (non-gating guard)', () => {
    // The regression the whole suite exists for: a SQL argument is *present*
    // (and cannot prove `handle` — `SELECT * FROM WHERE` is unparseable in every
    // dialect), yet the root resolves to a declared non-DB package. The
    // `not-handle` proof must NOT be skipped because SQL is nearby — a present
    // argument does not gate `declaration-resolution`.
    const v = verdict({
      root: 'expect',
      receiver: 'expect.toBe',
      method: 'toBe',
      sqlArgument: 'SELECT * FROM WHERE',
      bindings: new Map([['expect', { kind: 'import', source: 'vitest', importKind: 'named' }]]),
      declaredTypePackages: new Set(['vitest']),
    });
    expect(v).toEqual({ kind: 'not-handle', via: 'declaration-resolution' });
  });
});
