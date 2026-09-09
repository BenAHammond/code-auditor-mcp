/**
 * Spec 50 — daemon argument parsing.
 *
 * Guards the `--help` / `--version` early-exit contract: a bare
 * `code-auditor-daemon --help` must be parsed as `help: true`, never as a
 * positional project root (the pre-fix behavior silently swallowed `--help` and
 * launched a ~800 MB daemon).
 */
import { describe, it, expect } from 'vitest';
import { parseArgs, USAGE } from './args.js';

const CWD = '/tmp/project';

describe('parseArgs — daemon CLI arguments', () => {
  it('flags --help and does not treat it as a project root', () => {
    const opts = parseArgs(['--help'], CWD);
    expect(opts.help).toBe(true);
    expect(opts.version).toBe(false);
    expect(opts.projectRoot).toBe(CWD);
  });

  it('flags -h shorthand', () => {
    expect(parseArgs(['-h'], CWD).help).toBe(true);
  });

  it('flags --version and -v', () => {
    expect(parseArgs(['--version'], CWD).version).toBe(true);
    expect(parseArgs(['-v'], CWD).version).toBe(true);
  });

  it('a bare positional is the project root', () => {
    const opts = parseArgs(['/srv/app'], CWD);
    expect(opts.help).toBe(false);
    expect(opts.version).toBe(false);
    expect(opts.projectRoot).toBe('/srv/app');
  });

  it('defaults project root to cwd when no positional is given', () => {
    expect(parseArgs([], CWD).projectRoot).toBe(CWD);
  });

  it('parses --config, --idle-timeout-ms, --foreground, --lsp', () => {
    const opts = parseArgs(
      ['/srv/app', '--config', 'prod', '--idle-timeout-ms', '90000', '--foreground', '--lsp'],
      CWD
    );
    expect(opts.projectRoot).toBe('/srv/app');
    expect(opts.configName).toBe('prod');
    expect(opts.idleTimeoutMs).toBe(90000);
    expect(opts.foreground).toBe(true);
    expect(opts.lsp).toBe(true);
  });

  it('help wins even when combined with other flags', () => {
    const opts = parseArgs(['--lsp', '--help', '/srv/app'], CWD);
    expect(opts.help).toBe(true);
  });

  it('USAGE documents the -h/--help and -v/--version flags', () => {
    expect(USAGE).toContain('-h, --help');
    expect(USAGE).toContain('-v, --version');
  });
});
