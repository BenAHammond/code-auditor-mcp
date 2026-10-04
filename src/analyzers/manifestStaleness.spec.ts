/**
 * Part 2b — the manifest staleness self-check. The package manifest does not
 * participate in classification: a receiver classifies as a DB handle by
 * declaration resolution and SQL-argument evidence, never by whether the project
 * names the package. The manifest is a *staleness report* — "our list names X,
 * this project doesn't depend on it" — emitted as a diagnostic, affecting no
 * verdict.
 *
 * This spec pins three properties at the module boundary:
 *
 *   1. {@link computeManifestStaleness} reports exactly the gap between a
 *      hardcoded ecosystem list and the project's declared names — no more, no
 *      less.
 *   2. An absent manifest produces *no* staleness for that ecosystem (there is
 *      nothing to be stale against).
 *   3. {@link readProjectManifest} reads package.json dependency groups and
 *      go.mod `require` lines (single-line and block form), and reports null
 *      paths for manifests that are absent.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readProjectManifest,
  computeManifestStaleness,
  type ProjectManifest,
} from './manifestStaleness.js';
import { DB_PACKAGES } from './tsEcosystem.js';
import { GO_DB_PACKAGES } from '../languages/go/goResolution.js';

describe('computeManifestStaleness', () => {
  it('reports only the packages our list names that the manifest lacks', () => {
    // A TS project that depends on exactly three of the DB_PACKAGES names.
    const dependOn = new Set(['pg', 'knex', 'drizzle-orm']);
    const manifest: ProjectManifest = {
      names: dependOn,
      tsManifestPath: '/project/package.json',
      goManifestPath: null,
    };

    const stale = computeManifestStaleness(manifest);

    const expected = [...DB_PACKAGES].filter((p) => !dependOn.has(p));
    expect(stale.map((s) => s.package).sort()).toEqual(expected.sort());
    // Every entry is keyed to the TS manifest, tagged ts.
    expect(stale.length).toBe(DB_PACKAGES.size - dependOn.size);
    for (const s of stale) {
      expect(s.ecosystem).toBe('ts');
      expect(s.manifestPath).toBe('/project/package.json');
    }
  });

  it('reports no staleness when the manifest declares every list name', () => {
    const manifest: ProjectManifest = {
      names: new Set(DB_PACKAGES),
      tsManifestPath: '/project/package.json',
      goManifestPath: null,
    };
    expect(computeManifestStaleness(manifest)).toEqual([]);
  });

  it('emits no TS staleness when there is no package.json', () => {
    const manifest: ProjectManifest = {
      names: new Set<string>(),
      tsManifestPath: null,
      goManifestPath: null,
    };
    expect(computeManifestStaleness(manifest)).toEqual([]);
  });

  it('flags the Go stdlib list only when a go.mod exists', () => {
    // go.mod exists but does not name `database/sql` (it is stdlib — never in
    // go.mod). The report flags it: technically correct, diagnostic-only.
    const goStale = computeManifestStaleness({
      names: new Set<string>(),
      tsManifestPath: null,
      goManifestPath: '/project/go.mod',
    });
    expect(goStale.map((s) => s.package)).toEqual([...GO_DB_PACKAGES]);
    for (const s of goStale) {
      expect(s.ecosystem).toBe('go');
      expect(s.manifestPath).toBe('/project/go.mod');
    }
  });
});

describe('readProjectManifest', () => {
  it('reads package.json dependencies, devDependencies, and peerDependencies', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ca-manifest-'));
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { pg: '^8.0.0', knex: '^3.0.0' },
        devDependencies: { '@types/pg': '^8.0.0' },
        peerDependencies: { react: '^18.0.0' },
      }),
    );

    const manifest = await readProjectManifest(dir);

    expect(manifest.tsManifestPath).toBe(path.join(dir, 'package.json'));
    expect(manifest.goManifestPath).toBeNull();
    expect(manifest.names).toEqual(new Set(['pg', 'knex', '@types/pg', 'react']));
  });

  it('reads go.mod require lines, both single-line and block form', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ca-gomod-'));
    await writeFile(
      path.join(dir, 'go.mod'),
      [
        'module example.com/app',
        '',
        'go 1.21',
        '',
        'require github.com/gin-gonic/gin v1.9.0',
        '',
        'require (',
        '\tgithub.com/jmoiron/sqlx v1.3.5',
        '\tgorm.io/gorm v1.25.0',
        ')',
        '',
      ].join('\n'),
    );

    const manifest = await readProjectManifest(dir);

    expect(manifest.goManifestPath).toBe(path.join(dir, 'go.mod'));
    expect(manifest.tsManifestPath).toBeNull();
    expect(manifest.names).toEqual(
      new Set(['github.com/gin-gonic/gin', 'github.com/jmoiron/sqlx', 'gorm.io/gorm']),
    );
  });

  it('returns empty names and null paths when neither manifest exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ca-nomanifest-'));
    await mkdir(path.join(dir, 'src')); // a non-manifest file — still nothing to read

    const manifest = await readProjectManifest(dir);

    expect(manifest.names).toEqual(new Set());
    expect(manifest.tsManifestPath).toBeNull();
    expect(manifest.goManifestPath).toBeNull();
  });
});
