import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolvePersistedIndexPath, resolveDaemonSocketPath } from './dataPaths.js';

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

  it('never defaults into the project tree — a project with node_modules still gets the OS cache', () => {
    // The old default wrote `<root>/node_modules/.cache/code-auditor` — inside the
    // audited repo. That dirtied read-only corpora with tool scratch. A
    // `node_modules` in the tree must NOT redirect the default back into it.
    const root = makeTempDir('ca-project-');
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    const xdg = makeTempDir('ca-xdg-');
    process.env.XDG_CACHE_HOME = xdg;
    const hash = createHash('sha256').update(fs.realpathSync(root)).digest('hex').substring(0, 16);
    expect(resolvePersistedIndexPath(root)).toBe(
      path.join(xdg, 'code-auditor', 'projects', hash, 'index.db')
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

describe('resolveDaemonSocketPath', () => {
  const origXdg = process.env.XDG_CACHE_HOME;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    delete process.env.XDG_CACHE_HOME;
  });

  afterEach(() => {
    if (origXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = origXdg;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashes a symlinked project path identically to its real path (Spec 50 R5)', () => {
    const xdg = makeTempDir('ca-xdg-');
    process.env.XDG_CACHE_HOME = xdg;
    const real = makeTempDir('ca-real-project-');
    const linkParent = makeTempDir('ca-link-parent-');
    const link = path.join(linkParent, 'project-link');
    fs.symlinkSync(real, link);
    // The daemon (started from the real path) and the CLI (invoked via the
    // symlink) must derive the same socket, or they will not find each other.
    expect(resolveDaemonSocketPath(link)).toBe(resolveDaemonSocketPath(real));
  });

  it('places the socket under the OS cache dir keyed by the realpath project hash', () => {
    const xdg = makeTempDir('ca-xdg-');
    process.env.XDG_CACHE_HOME = xdg;
    const root = makeTempDir('ca-project-');
    const hash = createHash('sha256').update(fs.realpathSync(root)).digest('hex').substring(0, 16);
    expect(resolveDaemonSocketPath(root)).toBe(
      path.join(xdg, 'code-auditor', 'sockets', `code-auditor-${hash}.sock`)
    );
  });
});
