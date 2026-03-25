import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolvePersistedIndexPath } from './dataPaths.js';

describe('resolvePersistedIndexPath', () => {
  const orig = process.env.CODE_AUDITOR_DATA_DIR;

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.CODE_AUDITOR_DATA_DIR;
    } else {
      process.env.CODE_AUDITOR_DATA_DIR = orig;
    }
  });

  it('uses cwd when env unset', () => {
    delete process.env.CODE_AUDITOR_DATA_DIR;
    expect(resolvePersistedIndexPath()).toBe(
      path.join(process.cwd(), '.code-index', 'index.db')
    );
  });

  it('uses DATA_DIR as the storage root (index.db inside it)', () => {
    const dir = path.join(tmpdir(), 'code-auditor-data-path-test');
    process.env.CODE_AUDITOR_DATA_DIR = dir;
    expect(resolvePersistedIndexPath()).toBe(path.join(dir, 'index.db'));
  });
});
