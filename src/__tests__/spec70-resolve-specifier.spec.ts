/**
 * Spec 70 B1 — the one `resolveSpecifier` seam for all four specifier kinds.
 *
 * `resolveSpecifier` answers for relative, `@/`/`~/` alias, bare
 * (tsconfig-`paths` → in-repo, else node_modules vendor `.d.ts`), and nothing
 * else → `unresolved`. These pins exercise the two arms that are new in B1 and
 * have no filesystem-backed coverage elsewhere (the relative/alias arms are
 * pinned by `spec70-unresolved-query-parity.spec.ts` against real fixtures):
 *
 *   1. tsconfig-`paths` bare resolution — exact keys, wildcards, and `baseUrl`,
 *      against a synthetic `filesByPath` set (no node_modules, no disk).
 *   2. vendor resolution — a synthetic `node_modules` fixture in a temp dir,
 *      because the pinned measurement corpora carry no `node_modules`.
 *   3. the `classifyImportSource` arm — a resolved in-repo import returns
 *      `unproven` (never the old `not-handle`, which claimed a re-exported
 *      handle was clean), and records `importResolutionReason`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveSpecifier,
  type TsconfigPathMap,
} from '../analyzers/receiverResolution.js';
import {
  classifyRootIdentifier,
  type RootResolutionEnv,
  type Binding,
} from '../analyzers/receiverRoot.js';

// ── tsconfig-`paths` bare resolution (no filesystem) ─────────────────────────

describe('Spec 70 B1 — resolveSpecifier: tsconfig-`paths` bare resolution', () => {
  const root = '/repo';
  const importer = '/repo/src/main.ts';

  it('resolves an exact-key path (no wildcard) to an in-repo file', () => {
    const filesByPath = new Set(['/repo/db/index.ts']);
    const tsconfig: TsconfigPathMap = { paths: { db: ['./db/index.ts'] } };
    expect(resolveSpecifier('db', importer, filesByPath, root, tsconfig)).toEqual({
      kind: 'in-repo',
      path: '/repo/db/index.ts',
    });
  });

  it('resolves a wildcard path, substituting the captured segment', () => {
    const filesByPath = new Set(['/repo/packages/db/src/index.ts']);
    const tsconfig: TsconfigPathMap = { paths: { '@shared/*': ['packages/*/src'] } };
    expect(resolveSpecifier('@shared/db', importer, filesByPath, root, tsconfig)).toEqual({
      kind: 'in-repo',
      path: '/repo/packages/db/src/index.ts',
    });
  });

  it('honors baseUrl when resolving a path target', () => {
    const filesByPath = new Set(['/repo/src/db/client.ts']);
    const tsconfig: TsconfigPathMap = { baseUrl: 'src', paths: { db: ['db/client.ts'] } };
    expect(resolveSpecifier('db', importer, filesByPath, root, tsconfig)).toEqual({
      kind: 'in-repo',
      path: '/repo/src/db/client.ts',
    });
  });

  it('leaves a bare specifier that matches no tsconfig path unresolved', () => {
    const filesByPath = new Set(['/repo/src/db/client.ts']);
    const tsconfig: TsconfigPathMap = { paths: { db: ['./db/index.ts'] } };
    expect(resolveSpecifier('other', importer, filesByPath, root, tsconfig)).toEqual({ kind: 'unresolved' });
  });

  it('a `@/` specifier resolves through the alias arm, before tsconfig paths', () => {
    const filesByPath = new Set(['/repo/src/utils/helper.ts']);
    // Even with a wildcard `@/*` path present, `@/…` is the alias prefix and wins.
    const tsconfig: TsconfigPathMap = { paths: { '@/*': ['not/this/*'] } };
    expect(resolveSpecifier('@/utils/helper', importer, filesByPath, root, tsconfig)).toEqual({
      kind: 'in-repo',
      path: '/repo/src/utils/helper.ts',
    });
  });
});

// ── vendor resolution (synthetic node_modules fixture) ───────────────────────

describe('Spec 70 B1 — resolveSpecifier: node_modules vendor resolution', () => {
  it('resolves a bare specifier to a vendor declaration (`types` field, then `index.d.ts`)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-spec70-vendor-'));
    try {
      const importer = join(dir, 'src', 'main.ts');
      // `fake-db` declares a `types` entry.
      await mkdir(join(dir, 'node_modules', 'fake-db', 'dist'), { recursive: true });
      await writeFile(
        join(dir, 'node_modules', 'fake-db', 'package.json'),
        JSON.stringify({ name: 'fake-db', types: 'dist/index.d.ts' }),
      );
      await writeFile(join(dir, 'node_modules', 'fake-db', 'dist', 'index.d.ts'), 'declare const x: number;\n');
      // `simple-lib` has no package.json → falls back to `index.d.ts`.
      await mkdir(join(dir, 'node_modules', 'simple-lib'), { recursive: true });
      await writeFile(join(dir, 'node_modules', 'simple-lib', 'index.d.ts'), 'declare const y: number;\n');

      const filesByPath = new Set<string>([]);
      expect(resolveSpecifier('fake-db', importer, filesByPath, dir)).toEqual({
        kind: 'vendor',
        path: join(dir, 'node_modules', 'fake-db', 'dist', 'index.d.ts'),
      });
      expect(resolveSpecifier('simple-lib', importer, filesByPath, dir)).toEqual({
        kind: 'vendor',
        path: join(dir, 'node_modules', 'simple-lib', 'index.d.ts'),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves a scoped package and a Node builtin (builtin → unresolved)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-spec70-vendor-'));
    try {
      const importer = join(dir, 'src', 'main.ts');
      await mkdir(join(dir, 'node_modules', '@scope', 'pkg'), { recursive: true });
      await writeFile(join(dir, 'node_modules', '@scope', 'pkg', 'index.d.ts'), 'declare const z: number;\n');

      const filesByPath = new Set<string>([]);
      expect(resolveSpecifier('@scope/pkg', importer, filesByPath, dir)).toEqual({
        kind: 'vendor',
        path: join(dir, 'node_modules', '@scope', 'pkg', 'index.d.ts'),
      });
      // Node builtins have no vendor `.d.ts` and are not in-repo.
      expect(resolveSpecifier('node:fs', importer, filesByPath, dir)).toEqual({ kind: 'unresolved' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a bare specifier with no node_modules declaration resolves unresolved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-spec70-vendor-'));
    try {
      const importer = join(dir, 'src', 'main.ts');
      expect(resolveSpecifier('no-such-pkg', importer, new Set<string>([]), dir)).toEqual({ kind: 'unresolved' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── classifyImportSource arm: in-repo → unproven, not not-handle ─────────────

describe('Spec 70 B1 — classifyImportSource arm (resolved in-repo import → unproven)', () => {
  function importEnv(name: string, source: string, resolveImport?: RootResolutionEnv['resolveImport']): RootResolutionEnv {
    return {
      provenance: new Map<string, never>(),
      bindings: new Map<string, Binding>([[name, { kind: 'import', source }]]),
      ...(resolveImport ? { resolveImport } : {}),
      adapter: undefined,
      sourceCode: '',
    } as unknown as RootResolutionEnv;
  }

  it('a relative import resolved to an in-repo file abstains `unproven` and records the reason', () => {
    const env = importEnv('db', './db', () => ({ kind: 'in-repo', path: '/repo/db/index.ts' }));
    expect(classifyRootIdentifier('db', env)).toBe('unproven');
    expect(env.importResolutionReason).toContain('/repo/db/index.ts');
  });

  it('a relative import with no resolver stays `unproven` (never `not-handle`)', () => {
    expect(classifyRootIdentifier('db', importEnv('db', './db'))).toBe('unproven');
  });

  it('a Node builtin import is still `not-handle` (proven clean)', () => {
    expect(classifyRootIdentifier('readFile', importEnv('readFile', 'node:fs'))).toBe('not-handle');
  });

  it('a vendor-resolved (non-in-repo) DB package still resolves through the manifest', () => {
    // resolveImport returns `vendor`, not `in-repo` — so the manifest arm still
    // answers: `Pool` is a pg handle, `eq` from drizzle-orm is provably not.
    const pgEnv = importEnv('Pool', 'pg', () => ({ kind: 'vendor', path: '/repo/node_modules/pg/index.d.ts' }));
    expect(classifyRootIdentifier('Pool', pgEnv)).toBe('handle');
    const dzEnv = importEnv('eq', 'drizzle-orm', () => ({ kind: 'vendor', path: '/repo/node_modules/drizzle-orm/index.d.ts' }));
    expect(classifyRootIdentifier('eq', dzEnv)).toBe('not-handle');
  });

  it('a bare specifier that resolves to nothing names no module → `unproven` with a precise reason', () => {
    // `__prismaFolder__` (a codegen token) and blitz `db` (a build-step alias)
    // both answer `unresolved` from the seam: no in-repo file, no node_modules
    // declaration, no manifest package. The reason must say the specifier names
    // no module — never claim it is a package we merely fail to recognize.
    const env = importEnv('db', '__prismaFolder__', () => ({ kind: 'unresolved' }));
    expect(classifyRootIdentifier('db', env)).toBe('unproven');
    expect(env.importResolutionReason).toContain('names no module in this tree');
  });
});
