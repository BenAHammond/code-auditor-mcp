/**
 * Spec 70 Decision A — the manifest keys on package AND type.
 *
 * Each `database-packages.json` entry names the exported names that are DB
 * handles, not just the package. A *named* import from a DB package seeds handle
 * provenance only when the package's entry lists the imported name; a default
 * import still seeds (a DB package's default is its handle, and tree-sitter
 * records no original export name for a default import to match against). This
 * is what stops `import { KVNamespace } from '@cloudflare/workers-types'` from
 * seeding while `import { D1Database }` does.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import { extractDBProvenancedImports } from '../analyzers/provenance.js';
import { classifyRootIdentifier, type RootResolutionEnv, type Binding } from '../analyzers/receiverRoot.js';
import { handleTypesForPackage, isDbHandleTypeName, DB_HANDLE_TYPES, DB_PACKAGES } from '../analyzers/tsEcosystem.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

function seededNames(code: string): string[] {
  const ast = parseFile('probe.ts', code)!;
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('probe.ts')!;
  return [...extractDBProvenancedImports(ast, adapter).keys()].sort();
}

describe('Spec 70 Decision A — manifest handle types', () => {
  it('every DB_PACKAGES key has a handle-types entry (no types-absent arm)', () => {
    for (const pkg of DB_PACKAGES) {
      const types = DB_HANDLE_TYPES.get(pkg);
      expect(types, `package ${pkg} must list its handle types`).toBeDefined();
      expect(types!.size).toBeGreaterThan(0);
    }
  });

  it('resolves a subpath specifier to its base package handle types', () => {
    expect(handleTypesForPackage('pg')).toBe(DB_HANDLE_TYPES.get('pg'));
    expect(handleTypesForPackage('pg/lib')).toBe(DB_HANDLE_TYPES.get('pg'));
    expect(handleTypesForPackage('mysql2/promise')).toBe(DB_HANDLE_TYPES.get('mysql2'));
    expect(handleTypesForPackage('@cloudflare/workers-types')).toBe(DB_HANDLE_TYPES.get('@cloudflare/workers-types'));
    expect(handleTypesForPackage('@cloudflare/workers-types/sub')).toBe(DB_HANDLE_TYPES.get('@cloudflare/workers-types'));
    expect(handleTypesForPackage('left-pad')).toBeUndefined();
  });

  it('seeds the D1 handle types from @cloudflare/workers-types, but not its non-DB types', () => {
    const names = seededNames([
      "import { D1Database, D1PreparedStatement, KVNamespace, R2Bucket, ExecutionContext } from '@cloudflare/workers-types';",
      'export const x = 1;',
    ].join('\n'));
    expect(names).toEqual(['D1Database', 'D1PreparedStatement']);
  });

  it('seeds a listed named import from pg, and not an unlisted one', () => {
    const names = seededNames([
      "import { Pool, types } from 'pg';",
      'export const x = 1;',
    ].join('\n'));
    expect(names).toContain('Pool');
    expect(names).not.toContain('types');
  });

  it('still seeds a default import (better-sqlite3 Database)', () => {
    const names = seededNames([
      "import Database from 'better-sqlite3';",
      'export const x = 1;',
    ].join('\n'));
    expect(names).toContain('Database');
  });

  it('seeds a renamed named import under its local alias, matching the original name', () => {
    const names = seededNames([
      "import { Pool as PgPool } from 'pg';",
      'export const x = 1;',
    ].join('\n'));
    expect(names).toEqual(['PgPool']);
  });
});

describe('Spec 70 Decision A — type→package resolution in classifyTypeText', () => {
  /** Classify a variable annotated with `typeText`, through the same seam the
   *  receiver-resolution processor uses (`classifyRootIdentifier` → `classifyTypeText`). */
  function dispositionOf(typeText: string, declaredTypePackages?: ReadonlySet<string>): string {
    const bindings = new Map<string, Binding>([['db', { kind: 'variable', typeText }]]);
    const env = {
      provenance: new Map<string, never>(),
      bindings,
      declaredTypePackages,
      adapter: undefined,
      sourceCode: '',
    } as unknown as RootResolutionEnv;
    return classifyRootIdentifier('db', env);
  }

  it('treats every manifest handle type as a name, and every non-listed type as not', () => {
    expect(isDbHandleTypeName('D1Database')).toBe(true);
    expect(isDbHandleTypeName('D1PreparedStatement')).toBe(true);
    expect(isDbHandleTypeName('Pool')).toBe(true);
    expect(isDbHandleTypeName('Kysely')).toBe(true);
    expect(isDbHandleTypeName('KVNamespace')).toBe(false);
    expect(isDbHandleTypeName('R2Bucket')).toBe(false);
    expect(isDbHandleTypeName('ExecutionContext')).toBe(false);
    expect(isDbHandleTypeName('MyDb')).toBe(false);
  });

  it('resolves a bare D1Database type annotation to `handle` only with a declared dependency', () => {
    // Ambient arm (Item 3): an unbound handle-type name is credited only when its
    // declaring package is a declared dependency — package.json or tsconfig `types`.
    expect(dispositionOf('D1Database', new Set(['@cloudflare/workers-types']))).toBe('handle');
    expect(dispositionOf('D1Database')).toBe('unproven');
  });

  it('resolves a union carrying a manifest handle type to `handle` only with a declared dependency', () => {
    expect(dispositionOf('D1Database | null', new Set(['@cloudflare/workers-types']))).toBe('handle');
    expect(dispositionOf('D1Database | null')).toBe('unproven');
  });

  it('leaves a non-manifest type annotation (`KVNamespace`) `unproven`, never `handle`', () => {
    expect(dispositionOf('KVNamespace')).toBe('unproven');
    expect(dispositionOf('R2Bucket')).toBe('unproven');
    expect(dispositionOf('ExecutionContext')).toBe('unproven');
  });

  it('still classifies primitives and JS globals `not-handle` (the manifest arm is not a catch-all)', () => {
    expect(dispositionOf('string')).toBe('not-handle');
    expect(dispositionOf('Promise')).toBe('not-handle');
    expect(dispositionOf('Array<Pool>')).toBe('not-handle');
  });
});

describe('Spec 70 criterion 9 — type name resolves to its origin before the manifest', () => {
  /** Classify a variable typed `typeText`, with an extra name→binding map for the
   *  type-name origin (an import, a local type/class declaration, or none). */
  function dispositionWith(bindings: Record<string, Binding>, typeText = 'D1Database', declaredTypePackages?: ReadonlySet<string>): string {
    const map = new Map<string, Binding>(Object.entries(bindings));
    map.set('db', { kind: 'variable', typeText });
    const env = {
      provenance: new Map<string, never>(),
      bindings: map,
      declaredTypePackages,
      adapter: undefined,
      sourceCode: '',
    } as unknown as RootResolutionEnv;
    return classifyRootIdentifier('db', env);
  }

  it('resolves an import from @cloudflare/workers-types to `handle` (matching handle name)', () => {
    expect(dispositionWith({ D1Database: { kind: 'import', source: '@cloudflare/workers-types' } })).toBe('handle');
  });

  it('resolves an import from a non-manifest package to `unproven`, not `handle`', () => {
    expect(dispositionWith({ D1Database: { kind: 'import', source: 'my-own-d1' } })).toBe('unproven');
  });

  it('resolves an import of a non-handle name from a manifest package to `unproven`', () => {
    // KVNamespace is exported by @cloudflare/workers-types but is not a handle type.
    expect(dispositionWith({ KVNamespace: { kind: 'import', source: '@cloudflare/workers-types' } }, 'KVNamespace')).toBe('unproven');
  });

  it('a local `interface D1Database` shadows the ambient manifest name → `unproven`', () => {
    expect(dispositionWith({ D1Database: { kind: 'type' } })).toBe('unproven');
  });

  it('a local `class D1Database` shadows the ambient manifest name → `unproven`', () => {
    expect(dispositionWith({ D1Database: { kind: 'class' } })).toBe('unproven');
  });

  it('an ambient (unbound) manifest handle name resolves `handle` only with a declared dependency', () => {
    expect(dispositionWith({}, 'D1Database', new Set(['@cloudflare/workers-types']))).toBe('handle');
    expect(dispositionWith({})).toBe('unproven');
  });
});

describe('Spec 70 criterion 10 — a named import from a DB package resolves by its handle list', () => {
  /** Classify the *imported name itself* as the root — a bare-identifier call
   *  `eq(…)` whose binding is `import { eq } from 'drizzle-orm'`. */
  function importDisposition(name: string, source: string, importKind?: 'default' | 'named' | 'namespace'): string {
    const bindings = new Map<string, Binding>([[name, { kind: 'import', source, ...(importKind ? { importKind } : {}) }]]);
    const env = {
      provenance: new Map<string, never>(),
      bindings,
      adapter: undefined,
      sourceCode: '',
    } as unknown as RootResolutionEnv;
    return classifyRootIdentifier(name, env);
  }

  it('resolves a named import absent from the handle list to `not-handle` (proven, not dropped)', () => {
    // eq/inArray/relations are drizzle-orm exports but not its handle types.
    expect(importDisposition('eq', 'drizzle-orm')).toBe('not-handle');
    expect(importDisposition('inArray', 'drizzle-orm')).toBe('not-handle');
    expect(importDisposition('relations', 'drizzle-orm')).toBe('not-handle');
  });

  it('resolves a named import present in the handle list to `handle` (unprovenanced arm)', () => {
    expect(importDisposition('Pool', 'pg')).toBe('handle');
    expect(importDisposition('D1Database', '@cloudflare/workers-types')).toBe('handle');
  });

  it('resolves a named import from a non-manifest package to `unproven`', () => {
    expect(importDisposition('something', 'left-pad')).toBe('unproven');
  });

  it('a Node builtin import stays `not-handle`', () => {
    expect(importDisposition('readFile', 'node:fs')).toBe('not-handle');
  });

  it('a default import from a DB package is its handle, regardless of the local name', () => {
    // `import mysql from 'mysql2/promise'` — the local name `mysql` is not in the
    // handle list, but a default import's name is arbitrary: the package's default
    // IS its handle, never `not-handle`.
    expect(importDisposition('mysql', 'mysql2/promise', 'default')).toBe('handle');
  });

  it('a namespace import from a DB package is its handle', () => {
    expect(importDisposition('pg', 'pg', 'namespace')).toBe('handle');
  });
});
