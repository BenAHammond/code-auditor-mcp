/**
 * Directive K10 — cache growth GC.
 *
 * Pins the two discriminants that bound the tool's own fallback cache:
 *   - a `cli/<version>` dir is removed iff its name differs from `PACKAGE_VERSION`
 *     (a superseded runtime copy);
 *   - a `projects/<hash>` dir is removed iff its newest file mtime is older than the
 *     age threshold (abandoned — an active project never ages out).
 *
 * Everything runs against an injected `cacheRoot` / `cliRoot`, never the real
 * `~/Library/Caches` / `~/.cache`, and a fixed clock, so the assertions are
 * deterministic and touch no operator state. The "never a user data dir" boundary
 * is pinned two ways: the pure function deletes only the roots it is handed, and
 * `resolveCacheGcRoots` omits the project root when a `CODE_AUDITOR_DATA_DIR` is set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gcStaleCacheDirs, gcStaleCacheDirsOnce, resolveCacheGcRoots } from '../cacheGc.js';
import { PACKAGE_VERSION } from '../constants.js';

const NOW = 1_000_000_000_000; // fixed clock
const ONE_HOUR_MS = 3_600_000;

let tempRoots: string[] = [];
let origXdg: string | undefined;
let origDataDir: string | undefined;

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'code-auditor-gc-'));
  tempRoots.push(dir);
  return dir;
}

function setMtime(p: string, ms: number): void {
  utimesSync(p, new Date(ms), new Date(ms));
}

/** Create a project cache dir with an `index.db` at `mtimeMs`. */
function makeProject(projectsRoot: string, name: string, mtimeMs: number): string {
  const dir = path.join(projectsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.db'), '');
  setMtime(path.join(dir, 'index.db'), mtimeMs);
  setMtime(dir, mtimeMs);
  return dir;
}

function makeCliVersion(cliRoot: string, name: string): string {
  const dir = path.join(cliRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{}');
  return dir;
}

beforeEach(() => {
  tempRoots = [];
  origXdg = process.env.XDG_CACHE_HOME;
  origDataDir = process.env.CODE_AUDITOR_DATA_DIR;
  delete process.env.CODE_AUDITOR_DATA_DIR;
});

afterEach(() => {
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  if (origXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = origXdg;
  if (origDataDir === undefined) delete process.env.CODE_AUDITOR_DATA_DIR;
  else process.env.CODE_AUDITOR_DATA_DIR = origDataDir;
});

describe('Directive K10 — cache GC (pure function)', () => {
  it('removes superseded CLI versions and keeps the running one', () => {
    const cliRoot = tempRoot();
    const current = makeCliVersion(cliRoot, PACKAGE_VERSION);
    const old = makeCliVersion(cliRoot, '5.2.0');
    const older = makeCliVersion(cliRoot, '4.9.1');

    const result = gcStaleCacheDirs({ cliRoot });

    expect(result.removedCliVersions.sort()).toEqual(['4.9.1', '5.2.0'].sort());
    expect(existsSync(current)).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(older)).toBe(false);
  });

  it('removes abandoned project indexes and keeps recently-touched ones', () => {
    const cacheRoot = tempRoot();
    const projectsRoot = path.join(cacheRoot, 'projects');

    const fresh = makeProject(projectsRoot, 'fresh01', NOW);
    const stale = makeProject(projectsRoot, 'stale01', NOW - 2 * ONE_HOUR_MS);

    const result = gcStaleCacheDirs({ cacheRoot, projectMaxAgeMs: ONE_HOUR_MS, now: NOW });

    expect(result.removedProjects).toEqual(['stale01']);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it('touches only the roots it is handed', () => {
    const cacheRoot = tempRoot();
    const cliRoot = tempRoot();
    // A separate tree the GC must NOT touch, standing in for a user-specified
    // CODE_AUDITOR_DATA_DIR: it holds a stale-looking project index, and a GC
    // that ignored its root boundary would delete it.
    const dataDir = tempRoot();
    const outsider = makeProject(path.join(dataDir, 'projects'), 'deadbeef', NOW - 10 * ONE_HOUR_MS);

    const result = gcStaleCacheDirs({ cacheRoot, cliRoot, projectMaxAgeMs: ONE_HOUR_MS, now: NOW });

    expect(result.removedProjects).toEqual([]);
    expect(existsSync(outsider)).toBe(true);
  });

  it('deletes nothing when handed no roots', () => {
    const result = gcStaleCacheDirs();
    expect(result).toEqual({ removedCliVersions: [], removedProjects: [] });
  });

  it('is a no-op when a root does not exist', () => {
    const result = gcStaleCacheDirs({
      cliRoot: path.join(tempRoot(), 'missing'),
      cacheRoot: path.join(tempRoot(), 'also-missing'),
    });
    expect(result).toEqual({ removedCliVersions: [], removedProjects: [] });
  });
});

describe('Directive K10 — production entry boundaries', () => {
  it('omits the project root when a data dir is configured, keeps the cli root', () => {
    process.env.XDG_CACHE_HOME = tempRoot();
    process.env.CODE_AUDITOR_DATA_DIR = tempRoot();

    const roots = resolveCacheGcRoots();

    expect(roots.cacheRoot).toBeUndefined();
    expect(roots.cliRoot).toBe(path.join(process.env.XDG_CACHE_HOME!, 'code-auditor', 'cli'));
  });

  it('includes both roots when no data dir is configured', () => {
    process.env.XDG_CACHE_HOME = tempRoot();
    delete process.env.CODE_AUDITOR_DATA_DIR;

    const roots = resolveCacheGcRoots();

    expect(roots.cliRoot).toBe(path.join(process.env.XDG_CACHE_HOME!, 'code-auditor', 'cli'));
    expect(roots.cacheRoot).toBe(path.join(process.env.XDG_CACHE_HOME!, 'code-auditor'));
  });

  it('is a no-op under a test harness (never deletes operator cache during tests)', () => {
    // Under vitest, `isTestRun()` is true, so the production entry returns empty
    // before resolving or touching any real root.
    const result = gcStaleCacheDirsOnce();
    expect(result).toEqual({ removedCliVersions: [], removedProjects: [] });
  });
});
