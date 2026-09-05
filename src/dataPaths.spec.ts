import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolvePersistedIndexPath } from './dataPaths.js';

describe('resolvePersistedIndexPath', () => {
  const origDataDir = process.env.CODE_AUDITOR_DATA_DIR;
  const origXdg = process.env.XDG_CACHE_HOME;

  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    delete process.env.CODE_AUDITOR_DATA_DIR;
    delete process.env.XDG_CACHE_HOME;
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env.CODE_AUDITOR_DATA_DIR;
    else process.env.CODE_AUDITOR_DATA_DIR = origDataDir;
    if (origXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = origXdg;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses DATA_DIR as the storage root (index.db inside it)', () => {
    const dir = makeTempDir('ca-data-path-');
    process.env.CODE_AUDITOR_DATA_DIR = dir;
    expect(resolvePersistedIndexPath()).toBe(path.join(dir, 'index.db'));
  });

  it('scopes by project hash under DATA_DIR when projectRoot is provided', () => {
    const dir = makeTempDir('ca-data-path-');
    process.env.CODE_AUDITOR_DATA_DIR = dir;
    const root = makeTempDir('ca-project-');
    const hash = createHash('sha256').update(fs.realpathSync(root)).digest('hex').substring(0, 16);
    expect(resolvePersistedIndexPath(root)).toBe(
      path.join(dir, 'projects', hash, 'index.db')
    );
  });

  it('hashes a symlinked project path identically to its real path', () => {
    const dataDir = makeTempDir('ca-data-path-');
    process.env.CODE_AUDITOR_DATA_DIR = dataDir;
    const real = makeTempDir('ca-real-project-');
    const linkParent = makeTempDir('ca-link-parent-');
    const link = path.join(linkParent, 'project-link');
    fs.symlinkSync(real, link);
    // `-p <symlink>` and the resolved real path must land on the same DB.
    expect(resolvePersistedIndexPath(link)).toBe(resolvePersistedIndexPath(real));
  });

  it('uses the project-local node_modules/.cache when the project has node_modules', () => {
    const root = makeTempDir('ca-project-');
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    expect(resolvePersistedIndexPath(root)).toBe(
      path.join(root, 'node_modules', '.cache', 'code-auditor', 'index.db')
    );
  });

  it('scopes by project hash when node_modules is hoisted (ancestor)', () => {
    const mono = makeTempDir('ca-mono-');
    fs.mkdirSync(path.join(mono, 'node_modules'), { recursive: true });
    const pkg = path.join(mono, 'packages', 'foo');
    fs.mkdirSync(pkg, { recursive: true });
    const hash = createHash('sha256').update(fs.realpathSync(pkg)).digest('hex').substring(0, 16);
    expect(resolvePersistedIndexPath(pkg)).toBe(
      path.join(mono, 'node_modules', '.cache', 'code-auditor', 'projects', hash, 'index.db')
    );
  });

  it('falls back to the OS cache dir (via XDG_CACHE_HOME) for projects without node_modules', () => {
    const root = makeTempDir('ca-project-');
    const xdg = makeTempDir('ca-xdg-');
    process.env.XDG_CACHE_HOME = xdg;
    const hash = createHash('sha256').update(fs.realpathSync(root)).digest('hex').substring(0, 16);
    expect(resolvePersistedIndexPath(root)).toBe(
      path.join(xdg, 'code-auditor', 'projects', hash, 'index.db')
    );
  });
});
