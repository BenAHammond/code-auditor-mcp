import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { notifyLegacyIndexLocation } from './legacyIndexNotice.js';

/**
 * One-time legacy-index notice — the write-path fix moved the index out of the
 * repo, but every pre-move user is left with a directory the tool created inside
 * their repository. On the first run against such a project the tool reports the
 * path, says a previous version wrote it, and says it is safe to delete — once,
 * recorded (in the user config dir, never in the repo), and never deleting
 * anything.
 */
describe('notifyLegacyIndexLocation', () => {
  let root: string;
  let configDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ca-legacy-root-'));
    configDir = mkdtempSync(join(tmpdir(), 'ca-legacy-config-'));
  });

  function notified(): string[] {
    const messages: string[] = [];
    const paths = notifyLegacyIndexLocation(root, {
      configDir,
      notify: (m) => messages.push(m),
    });
    return messages;
  }

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('reports nothing when no legacy location exists', () => {
    const messages: string[] = [];
    const paths = notifyLegacyIndexLocation(root, {
      configDir,
      notify: (m) => messages.push(m),
    });
    expect(paths).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('reports a legacy .code-index dir once and names it safe to delete', () => {
    const codeIndex = join(root, '.code-index');
    mkdirSync(codeIndex, { recursive: true });

    const messages = notified();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(codeIndex);
    expect(messages[0]).toContain('previous code-auditor version');
    expect(messages[0]).toContain('safe to delete');

    // The directory was reported, not removed.
    expect(existsSync(codeIndex)).toBe(true);
  });

  it('reports both legacy locations in one message', () => {
    mkdirSync(join(root, '.code-index'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '.cache', 'code-auditor'), { recursive: true });

    const messages = notified();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(join(root, '.code-index'));
    expect(messages[0]).toContain(join(root, 'node_modules', '.cache', 'code-auditor'));
  });

  it('records the notice so a second run does not repeat it', () => {
    mkdirSync(join(root, '.code-index'), { recursive: true });

    const first = notified();
    expect(first).toHaveLength(1);

    const second = notified();
    expect(second).toEqual([]);
  });

  it('keys the record by project, so a different project still reports', () => {
    mkdirSync(join(root, '.code-index'), { recursive: true });
    expect(notified()).toHaveLength(1);

    const other = mkdtempSync(join(tmpdir(), 'ca-legacy-other-'));
    try {
      mkdirSync(join(other, '.code-index'), { recursive: true });
      const messages: string[] = [];
      notifyLegacyIndexLocation(other, { configDir, notify: (m) => messages.push(m) });
      expect(messages).toHaveLength(1);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
