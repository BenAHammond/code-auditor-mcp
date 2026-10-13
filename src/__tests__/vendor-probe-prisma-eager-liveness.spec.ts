/**
 * Item B2c — liveness for the two newly-derived sets (Prisma model verbs,
 * cross-driver eager-execution).
 *
 * The derivation test (`vendor-probe-dataaccess.spec.ts`) pins the set *logic* on
 * synthetic surfaces. This test proves what synthetic surfaces cannot: that the
 * sets resolve from a real declaration and that a finding appears only because the
 * probe supplied a method the old hand-kept list lacked.
 *
 * Two halves:
 *
 *   1. Prisma. The generated client fixture
 *      (`bench/corpus/vendor-probe-prisma/generated-client/`) is the *verbatim*
 *      `prisma generate` output for `prisma@6.19.3` (models `User`/`Post`), committed
 *      because regenerating it needs the Prisma CLI + query engines (a network-free
 *      test must not fetch them). The test materializes it into a temp tree's
 *      `node_modules/.prisma/client/` and asserts `resolveVendorSurfaces` reads the
 *      generated `*Delegate` union back out — path + `6.19.3` + the 18 member names
 *      (17 verbs + the `fields` property), including `createManyAndReturn` /
 *      `updateManyAndReturn`, the two verbs the old 15-verb `PRISMA_VERBS` list was
 *      missing. The *liveness* is `isQueryBuilderShape`: a `prisma.user.createManyAndReturn({ data })`
 *      object-form site is admitted by the derived set, dropped by the old 15-verb
 *      list (which lacks the verb), and still admitted — as unproven — when the set
 *      is null (the shape admits, only the verb confirmation degrades).
 *
 *   2. Eager-execution. The analyzer's own devDependency `@types/better-sqlite3`
 *      declares the same name twice — `interface Statement` (the surface) and a
 *      *conditional* `type Statement<…>` helper alias — the exact name collision the
 *      single-declaration reader used to mis-resolve (returning an empty surface, so
 *      a better-sqlite3-only tree lost `run`/`get`/`iterate`). This test copies the
 *      real declaration into a better-sqlite3-*only* tree (no `@types/node`, so
 *      node:sqlite contributes nothing), asserts the surface resolves non-empty, and
 *      proves the end-to-end finding: `db.run(\`…${name}\`, [name])` is parameterized
 *      (no `sql-injection-risk`) with the probe and flagged without it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile, findNodes, getNodeText } from '../languages/adapterBridge.js';
import {
  resolveVendorSurfaces,
  deriveVendorSets,
  EMPTY_VENDOR_SURFACES,
} from '../analyzers/vendorSurfaces.js';
import { isQueryBuilderShape } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { runDataAccessSlice } from '../phase/runner.js';

/** The `app/` directory — the source of the committed Prisma fixture and the
 *  analyzer's own `@types/better-sqlite3` devDependency. */
const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PRISMA_FIXTURE = path.join(APP_ROOT, 'bench', 'corpus', 'vendor-probe-prisma', 'generated-client');
const BETTER_SQLITE3_DTS = path.join(APP_ROOT, 'node_modules', '@types', 'better-sqlite3');

/** The old hand-kept 15-verb `PRISMA_VERBS` list — the pre-derivation snapshot the
 *  directive deleted. Missing `createManyAndReturn` and `updateManyAndReturn`. */
const OLD_PRISMA_VERBS = new Set([
  'aggregate', 'count', 'create', 'createMany', 'delete', 'deleteMany',
  'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow',
  'groupBy', 'update', 'updateMany', 'upsert',
]);

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** Copy the committed generated-client fixture into `root`'s `node_modules/.prisma/client/`. */
function materializePrismaClient(root: string): void {
  const dest = path.join(root, 'node_modules', '.prisma', 'client');
  mkdirSync(dest, { recursive: true });
  copyFileSync(path.join(PRISMA_FIXTURE, 'index.d.ts'), path.join(dest, 'index.d.ts'));
  copyFileSync(path.join(PRISMA_FIXTURE, 'package.json'), path.join(dest, 'package.json'));
}

/** Copy the analyzer's real `@types/better-sqlite3` into a temp tree's node_modules. */
function materializeBetterSqlite3(root: string): void {
  const dest = path.join(root, 'node_modules', '@types', 'better-sqlite3');
  mkdirSync(dest, { recursive: true });
  copyFileSync(path.join(BETTER_SQLITE3_DTS, 'index.d.ts'), path.join(dest, 'index.d.ts'));
  copyFileSync(path.join(BETTER_SQLITE3_DTS, 'package.json'), path.join(dest, 'package.json'));
}

/** Parse a snippet and return the adapter + the first `createManyAndReturn` call. */
function prismaCallNode(src: string) {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('/f.ts')!;
  const ast = parseFile('/f.ts', src)!;
  const calls = findNodes(ast.root, (n) => n.type === 'call_expression');
  const call = calls.find((c) => getNodeText(c, src).includes('createManyAndReturn'))!;
  return { adapter, call };
}

describe('Prisma verb-set liveness (item B2c)', () => {
  it('resolves the generated *Delegate union: path + 6.19.3 + 18 members incl. the two new verbs', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'prisma-live-'));
    try {
      materializePrismaClient(root);
      const s = resolveVendorSurfaces(root);

      expect(s.prismaVerbs).not.toBeNull();
      expect([...(s.prismaVerbs ?? [])].sort()).toEqual(
        ['aggregate', 'count', 'create', 'createMany', 'createManyAndReturn', 'delete',
          'deleteMany', 'fields', 'findFirst', 'findFirstOrThrow', 'findMany',
          'findUnique', 'findUniqueOrThrow', 'groupBy', 'update', 'updateMany',
          'updateManyAndReturn', 'upsert'].sort(),
      );

      const rec = s.resolutions.find((r) => r.pkg === '.prisma/client')!;
      expect(rec.path).toContain(path.join('node_modules', '.prisma', 'client', 'index.d.ts'));
      expect(rec.version).toBe('6.19.3');
      expect(rec.reason).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('createManyAndReturn is admitted by the derived set, dropped by the old 15-verb list, unproven-admitted when null', () => {
    const src = `import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
export async function f(data: unknown) {
  return prisma.user.createManyAndReturn({ data });
}
`;
    const { adapter, call } = prismaCallNode(src);
    const derived = new Set(['aggregate', 'count', 'create', 'createMany', 'createManyAndReturn', 'delete', 'deleteMany', 'fields', 'findFirst', 'findFirstOrThrow', 'findMany', 'findUnique', 'findUniqueOrThrow', 'groupBy', 'update', 'updateMany', 'updateManyAndReturn', 'upsert']);

    // The derived set contains the verb → admitted.
    expect(isQueryBuilderShape(call, adapter, src, derived)).toBe(true);
    // The old hand-kept list lacks it → dropped (the stale-snapshot gap the probe closes).
    expect(isQueryBuilderShape(call, adapter, src, OLD_PRISMA_VERBS)).toBe(false);
    // No generated client → the shape still admits, but only as unproven.
    expect(isQueryBuilderShape(call, adapter, src, null)).toBe(true);
  });

  it('a tree without a generated client is unproven with the named reason', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'prisma-bare-live-'));
    try {
      const s = resolveVendorSurfaces(bare);
      expect(s.prismaVerbs).toBeNull();
      const rec = s.resolutions.find((r) => r.pkg === '.prisma/client')!;
      expect(rec.path).toBeNull();
      expect(rec.version).toBeNull();
      expect(rec.reason).toContain('not present');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('eager-execution liveness (item B2c)', () => {
  it('reads the real @types/better-sqlite3 Statement/Database (name-collision) into a better-sqlite3-only set', () => {
    expect(existsSync(path.join(BETTER_SQLITE3_DTS, 'index.d.ts')), '@types/better-sqlite3 devDependency not installed').toBe(true);

    const root = mkdtempSync(path.join(tmpdir(), 'eager-better-only-'));
    try {
      materializeBetterSqlite3(root);
      const s = resolveVendorSurfaces(root);

      // The conditional `type Statement<…>` helper alias must not shadow the
      // interface: the surface resolves non-empty (the pre-fix behaviour was empty).
      expect(s.betterSqlite3Statement).not.toBeNull();
      for (const m of ['run', 'get', 'all', 'iterate', 'raw']) {
        expect(s.betterSqlite3Statement!.has(m), `Statement.${m}`).toBe(true);
      }
      expect(s.betterSqlite3Database).not.toBeNull();
      for (const m of ['prepare', 'transaction', 'exec']) {
        expect(s.betterSqlite3Database!.has(m), `Database.${m}`).toBe(true);
      }

      const stmt = s.resolutions.find((r) => r.pkg === '@types/better-sqlite3' && r.type === 'Statement')!;
      expect(stmt.path).toContain('better-sqlite3');
      expect(stmt.version).toBe('7.6.13');
      expect(stmt.reason).toBeNull();

      // No @types/node in this tree → node:sqlite contributes nothing, so the
      // derived set is better-sqlite3-only: no D1 `.first()`, no generic `.query()`.
      expect(s.nodeSqliteStatement).toBeNull();
      const d = deriveVendorSets(s);
      expect(d.eagerExecutionMethods).not.toBeNull();
      for (const m of ['run', 'get', 'all', 'iterate', 'raw', 'prepare', 'transaction', 'exec']) {
        expect(d.eagerExecutionMethods!.has(m), `eager.${m}`).toBe(true);
      }
      for (const m of ['first', 'query', 'execute']) {
        expect(d.eagerExecutionMethods!.has(m), `eager.${m} absent`).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('db.run(sql, params) is parameterized with the probe and flagged without it (sql-injection-risk)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'eager-live-'));
    try {
      materializeBetterSqlite3(root);
      const resolved = resolveVendorSurfaces(root);

      const src = `import Database from 'better-sqlite3';
const db = new Database(':memory:');
export function lookup(name: string) {
  return db.run(\`SELECT * FROM users WHERE name = \${name}\`, [name]);
}
`;
      const files = [{ path: 'src/lookup.ts', content: src }];

      const withProbe = await runDataAccessSlice(files, undefined, 'sqlite', resolved);
      const withoutProbe = await runDataAccessSlice(files, undefined, 'sqlite', EMPTY_VENDOR_SURFACES);

      const inj = (fs: { ruleId: string }[]) => fs.filter((f) => f.ruleId === 'sql-injection-risk').length;
      // The probe supplies `run` (a better-sqlite3 Statement method), so the
      // two-arg call is recognized as parameterized — no injection finding.
      expect(inj(withProbe)).toBe(0);
      // Without the probe, `run` is absent from the eager set → the raw
      // interpolation is flagged. This is the finding that only the probe removes.
      expect(inj(withoutProbe)).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
