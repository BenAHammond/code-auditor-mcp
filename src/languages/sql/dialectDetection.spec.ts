/**
 * Spec 70 — dialect detection pins. One fixture per ecosystem (pg/neon →
 * postgres, mysql2 → mysql, better-sqlite3 → sqlite, D1 binding → sqlite), plus
 * the undetermined case (no driver) and the ambiguous case (two drivers). Each
 * proves the *real pipeline* dialect — derived from the dependency manifest, not
 * a config string — so the twelve SQL-content sites get a dialect without Ben
 * naming one, and an undetermined repo abstains loudly instead of reading empty
 * facts as clean.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectDialect } from './dialectDetection.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a package.json (+ optional wrangler.toml) into a fresh temp dir. */
function project(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }, wrangler?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dialect-detect-'));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  if (wrangler !== undefined) {
    writeFileSync(path.join(dir, 'wrangler.toml'), wrangler);
  }
  return dir;
}

describe('detectDialect — dependency-manifest dialect detection', () => {
  it('detects postgres from `pg`', () => {
    expect(detectDialect(project({ dependencies: { pg: '^8.16.3' } }))).toEqual({
      dialect: 'postgresql',
      reason: null,
    });
  });

  it('detects postgres from `@neondatabase/serverless`', () => {
    expect(detectDialect(project({ dependencies: { '@neondatabase/serverless': '^0.10.4' } }))).toEqual({
      dialect: 'postgresql',
      reason: null,
    });
  });

  it('detects mysql from `mysql2`', () => {
    expect(detectDialect(project({ dependencies: { mysql2: '^3.11.3' } }))).toEqual({
      dialect: 'mysql',
      reason: null,
    });
  });

  it('detects sqlite from `better-sqlite3`', () => {
    expect(detectDialect(project({ dependencies: { 'better-sqlite3': '^11.0.0' } }))).toEqual({
      dialect: 'sqlite',
      reason: null,
    });
  });

  it('detects sqlite from a D1 `wrangler.toml` binding (no driver package)', () => {
    const dir = project({}, '[[d1_databases]]\nbinding = "DB"\ndatabase_name = "recall"\n');
    expect(detectDialect(dir)).toEqual({ dialect: 'sqlite', reason: null });
  });

  it('reads devDependencies (e.g. `postgres` as a dev driver)', () => {
    expect(detectDialect(project({ devDependencies: { postgres: '^3.4.4' } }))).toEqual({
      dialect: 'postgresql',
      reason: null,
    });
  });

  it('returns undetermined (named reason) when no driver is declared', () => {
    const result = detectDialect(project({ dependencies: { react: '^19.0.0' } }));
    expect(result.dialect).toBeNull();
    expect(result.reason).toContain('dialect undetermined');
    expect(result.reason).toContain('no database driver');
  });

  it('returns undetermined (ambiguous reason) when two dialects are declared', () => {
    const result = detectDialect(project({ dependencies: { pg: '^8.16.3', mysql2: '^3.11.3' } }));
    expect(result.dialect).toBeNull();
    expect(result.reason).toContain('dialect undetermined');
    expect(result.reason).toContain('ambiguous');
    expect(result.reason).toContain('postgresql');
    expect(result.reason).toContain('mysql');
  });

  it('does not infer a dialect from a query builder or ORM (knex/drizzle/prisma)', () => {
    const result = detectDialect(project({ dependencies: { knex: '^3.0.0', 'drizzle-orm': '^0.39.0', '@prisma/client': '^5.0.0' } }));
    expect(result.dialect).toBeNull();
    expect(result.reason).toContain('dialect undetermined');
  });

  it('does not infer a dialect from a non-SQL store (mongodb)', () => {
    const result = detectDialect(project({ dependencies: { mongodb: '^6.0.0' } }));
    expect(result.dialect).toBeNull();
  });

  it('returns undetermined when there is no package.json at all', () => {
    expect(detectDialect(project({}))).toEqual({
      dialect: null,
      reason: 'dialect undetermined (no database driver in package.json or wrangler.toml)',
    });
  });
});
