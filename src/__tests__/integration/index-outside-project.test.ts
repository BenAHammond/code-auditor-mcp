/**
 * Spec 70 item 3 — the tool must never write into the audited project by default.
 *
 * With CODE_AUDITOR_DATA_DIR unset, the persisted index belongs in a user-level
 * OS cache, never in the audited tree. The earlier defaults — a project-local
 * `.code-index/`, then `<root>/node_modules/.cache/code-auditor` — wrote tool
 * scratch into consuming repositories on every run, dirtying read-only corpora
 * and making the measured tree itself non-reproducible.
 *
 * This test audits a fixture that *has* a `node_modules` (the exact shape the
 * old default polluted) and asserts the fixture is byte-identical afterward —
 * no new paths, no changed bytes — while the index still persisted in the OS
 * cache (so the assertion is non-vacuous: the write happened, just not here).
 *
 * Integration suite — loads tree-sitter WASM; excluded from `npm run test`,
 * run with `npm run test:integration`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, readdir, readFile } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { initParsers, initializeLanguages } from '../../languages/index.js';
import { runAudit } from '../../auditRunner.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

const TS_SOURCE = `export function findUser(id: string) {
  return { id };
}
`;

/** Recursively snapshot a directory as a map of `relative path → bytes`. */
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string, rel: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const relPath = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        out.set(relPath, await readFile(abs, 'utf-8'));
      }
    }
  }
  await walk(root, '');
  return out;
}

function assertSameTree(before: Map<string, string>, after: Map<string, string>): void {
  const beforeKeys = [...before.keys()].sort();
  const afterKeys = [...after.keys()].sort();
  expect(afterKeys, 'no new or removed paths in the fixture').toEqual(beforeKeys);
  for (const key of beforeKeys) {
    expect(after.get(key), `unchanged bytes for ${key}`).toBe(before.get(key));
  }
}

describe('Spec 70 item 3 — the audit writes nothing into the project by default', () => {
  it('audits a fixture with node_modules and leaves it byte-identical', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'ca-fixture-'));
    const xdgCache = await mkdtemp(join(tmpdir(), 'ca-xdg-'));
    const origXdg = process.env.XDG_CACHE_HOME;
    const origDataDir = process.env.CODE_AUDITOR_DATA_DIR;
    try {
      // Route the OS cache into a scratch dir; leave CODE_AUDITOR_DATA_DIR unset
      // (the default under test) so the index must land in the OS cache.
      process.env.XDG_CACHE_HOME = xdgCache;
      delete process.env.CODE_AUDITOR_DATA_DIR;

      await writeFile(join(fixture, 'src.ts'), TS_SOURCE, 'utf-8');
      // A Node project — the exact shape the old default polluted by writing
      // `<root>/node_modules/.cache/code-auditor/index.db`.
      await mkdir(join(fixture, 'node_modules'), { recursive: true });

      const before = await snapshotTree(fixture);

      await runAudit({
        projectRoot: fixture,
        indexFunctions: true, // exercise the real index write path
        showProgress: false,
        scope: 'all',
      });

      const after = await snapshotTree(fixture);
      assertSameTree(before, after);

      // Non-vacuous: the index still persisted — outside the project, in the
      // OS cache keyed by the project hash.
      const projectsDir = join(xdgCache, 'code-auditor', 'projects');
      const projectDirs = await readdir(projectsDir, { withFileTypes: true });
      const indexExists = await (async () => {
        for (const e of projectDirs) {
          if (!e.isDirectory()) continue;
          try {
            await readFile(join(projectsDir, e.name, 'index.db'));
            return true;
          } catch {
            /* keep looking */
          }
        }
        return false;
      })();
      expect(indexExists, 'the index must land in the OS cache, outside the fixture').toBe(true);
    } finally {
      if (origXdg === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = origXdg;
      if (origDataDir === undefined) delete process.env.CODE_AUDITOR_DATA_DIR;
      else process.env.CODE_AUDITOR_DATA_DIR = origDataDir;
      try { rmSync(fixture, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(xdgCache, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
