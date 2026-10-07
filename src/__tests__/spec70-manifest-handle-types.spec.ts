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
  function dispositionOf(typeText: string): string {
    const bindings = new Map<string, Binding>([['db', { kind: 'variable', typeText }]]);
    const env = {
      provenance: new Map<string, never>(),
      bindings,
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

  it('resolves a bare D1Database type annotation to `handle`', () => {
    expect(dispositionOf('D1Database')).toBe('handle');
  });

  it('resolves a union carrying a manifest handle type to `handle`', () => {
    expect(dispositionOf('D1Database | null')).toBe('handle');
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
