import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { resolveConfigGenerateDir } from './configGeneratePath.js';

describe('resolveConfigGenerateDir (Spec 61 R5.1 containment)', () => {
  const cwd = '/srv/project';

  it('resolves "." to the cwd itself', () => {
    expect(resolveConfigGenerateDir('.', cwd)).toBe(cwd);
  });

  it('resolves a relative subdirectory inside cwd', () => {
    expect(resolveConfigGenerateDir('configs', cwd)).toBe(path.join(cwd, 'configs'));
  });

  it('resolves an absolute path already inside cwd', () => {
    expect(resolveConfigGenerateDir(path.join(cwd, 'generated'), cwd)).toBe(
      path.join(cwd, 'generated')
    );
  });

  it('rejects an absolute path outside cwd', () => {
    expect(() => resolveConfigGenerateDir('/etc/generated', cwd)).toThrow(
      /must be within the current working directory/
    );
  });

  it('rejects a relative path that escapes cwd via ".."', () => {
    expect(() => resolveConfigGenerateDir('../outside', cwd)).toThrow(
      /must be within the current working directory/
    );
  });

  it('rejects a sibling directory that only shares a prefix string', () => {
    // `/srv/project-evil` shares the `/srv/project` prefix but is a sibling,
    // not a child — the trailing-separator guard must catch it.
    expect(() => resolveConfigGenerateDir('/srv/project-evil', cwd)).toThrow(
      /must be within the current working directory/
    );
  });

  describe('~ expansion', () => {
    const home = os.homedir();

    it('expands ~ to a path inside cwd when cwd IS the home dir', () => {
      const out = resolveConfigGenerateDir('~/configs', home);
      expect(out).toBe(path.join(home, 'configs'));
    });

    it('expands a bare ~ to the home dir when cwd is the home dir', () => {
      expect(resolveConfigGenerateDir('~', home)).toBe(home);
    });

    it('rejects ~ expansion when it escapes a cwd that is not home', () => {
      expect(() => resolveConfigGenerateDir('~/configs', cwd)).toThrow(
        /must be within the current working directory/
      );
    });
  });
});
