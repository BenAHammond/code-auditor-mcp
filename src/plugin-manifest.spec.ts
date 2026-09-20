/**
 * Plugin manifest validation tests — Spec 07 R1.2
 *
 * Validates that plugin.json, marketplace.json, hooks.json, and skill files
 * conform to the schemas documented at code.claude.com/docs (verified 2026-07-16).
 *
 * Note: .mcp.json was deliberately removed in A2 remediation (skill + CLI path
 * is cheaper — no standing tool-schema token cost).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname, '..', 'plugin');
const MARKETPLACE_DIR = resolve(__dirname, '..', '.claude-plugin');

function loadJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('Plugin manifest (plugin.json)', () => {
  const manifest = loadJson(resolve(PLUGIN_DIR, '.claude-plugin', 'plugin.json'));

  it('has required fields', () => {
    expect(manifest).toHaveProperty('name');
    expect(manifest).toHaveProperty('description');
    expect(manifest).toHaveProperty('version');
  });

  it('name is kebab-case', () => {
    expect(manifest.name).toMatch(/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/);
  });

  it('version is semver', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('version matches package.json', () => {
    const pkg = loadJson(resolve(__dirname, '..', 'package.json'));
    expect(manifest.version).toBe(pkg.version);
  });

  it('name is code-auditor', () => {
    expect(manifest.name).toBe('code-auditor');
  });

  it('has optional metadata fields', () => {
    expect(manifest.author).toHaveProperty('name');
    expect(manifest).toHaveProperty('homepage');
    expect(manifest).toHaveProperty('license');
  });

  it('does not have unexpected top-level fields', () => {
    const allowed = new Set([
      'name', 'description', 'version', 'author', 'displayName',
      'homepage', 'repository', 'license', 'keywords',
      'skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers',
      'category', 'tags', 'strict', 'defaultEnabled',
    ]);
    for (const key of Object.keys(manifest)) {
      expect(allowed.has(key), `unexpected field "${key}"`).toBe(true);
    }
  });
});

describe('Marketplace manifest (marketplace.json)', () => {
  const manifest = loadJson(resolve(MARKETPLACE_DIR, 'marketplace.json'));

  it('has required fields', () => {
    expect(manifest).toHaveProperty('name');
    expect(manifest).toHaveProperty('owner');
    expect(manifest).toHaveProperty('plugins');
  });

  it('owner has name', () => {
    expect(manifest.owner).toHaveProperty('name');
  });

  it('plugins is a non-empty array', () => {
    expect(Array.isArray(manifest.plugins)).toBe(true);
    expect(manifest.plugins.length).toBeGreaterThan(0);
  });

  it('each plugin entry has name and source', () => {
    for (const plugin of manifest.plugins) {
      expect(plugin).toHaveProperty('name');
      expect(plugin).toHaveProperty('source');
    }
  });

  it('plugin source points to ./plugin', () => {
    const codeAuditor = manifest.plugins.find(
      (p: any) => p.name === 'code-auditor',
    );
    expect(codeAuditor).toBeDefined();
    expect(codeAuditor.source).toBe('./plugin');
  });

  it('marketplace name is kebab-case', () => {
    expect(manifest.name).toMatch(/^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/);
  });

  it('version in plugin entry matches plugin.json', () => {
    const pluginManifest = loadJson(
      resolve(PLUGIN_DIR, '.claude-plugin', 'plugin.json'),
    );
    const codeAuditor = manifest.plugins.find(
      (p: any) => p.name === 'code-auditor',
    );
    expect(codeAuditor.version).toBe(pluginManifest.version);
  });
});

describe('Hooks manifest (hooks.json)', () => {
  const hooks = loadJson(resolve(PLUGIN_DIR, 'hooks', 'hooks.json'));

  it('has hooks key', () => {
    expect(hooks).toHaveProperty('hooks');
  });

  it('has PostToolUse hook', () => {
    expect(hooks.hooks).toHaveProperty('PostToolUse');
    expect(Array.isArray(hooks.hooks.PostToolUse)).toBe(true);
  });

  it('PostToolUse matcher targets Write|Edit', () => {
    const entry = hooks.hooks.PostToolUse[0];
    expect(entry).toHaveProperty('matcher');
    expect(entry.matcher).toBe('Write|Edit');
  });

  it('PostToolUse hook array contains a command hook', () => {
    const entry = hooks.hooks.PostToolUse[0];
    expect(entry).toHaveProperty('hooks');
    expect(Array.isArray(entry.hooks)).toBe(true);
    expect(entry.hooks.length).toBeGreaterThan(0);
  });

  it('inner hook is type command', () => {
    const inner = hooks.hooks.PostToolUse[0].hooks[0];
    expect(inner.type).toBe('command');
    expect(inner).toHaveProperty('command');
  });

  it('command references the hook-audit.sh script', () => {
    const inner = hooks.hooks.PostToolUse[0].hooks[0];
    expect(inner.command).toContain('hook-audit.sh');
  });

  it('command uses CLAUDE_PLUGIN_ROOT variable', () => {
    const inner = hooks.hooks.PostToolUse[0].hooks[0];
    expect(inner.command).toContain('${CLAUDE_PLUGIN_ROOT}');
  });

  it('command guards against an unset CLAUDE_PLUGIN_ROOT (fails loudly, not silently)', () => {
    const inner = hooks.hooks.PostToolUse[0].hooks[0];
    expect(inner.command).toContain('CLAUDE_PLUGIN_ROOT is unset');
    expect(inner.command).toContain('exit 1');
    // The guard must precede the script invocation so a missing plugin root
    // can never resolve to an absolute `/scripts/hook-audit.sh` that silently
    // fails to be found.
    expect(inner.command.indexOf('is unset')).toBeLessThan(
      inner.command.indexOf('hook-audit.sh'),
    );
  });
});

describe('SessionStart warm hook (hook-warm.sh)', () => {
  const hooks = loadJson(resolve(PLUGIN_DIR, 'hooks', 'hooks.json'));
  const warmContent = readFileSync(
    resolve(PLUGIN_DIR, 'scripts', 'hook-warm.sh'),
    'utf-8',
  );

  it('registers a SessionStart command hook that warms on startup and resume', () => {
    expect(hooks.hooks).toHaveProperty('SessionStart');
    expect(Array.isArray(hooks.hooks.SessionStart)).toBe(true);
    const entry = hooks.hooks.SessionStart[0];
    expect(entry.matcher).toBe('startup|resume');
    expect(entry.hooks[0].type).toBe('command');
    expect(entry.hooks[0].command).toContain('hook-warm.sh');
  });

  it('is silent on an unset CLAUDE_PLUGIN_ROOT (exit 0, not the loud exit 1)', () => {
    // A warm-the-cache nicety must never fail the session: unlike the PostToolUse
    // guards, an unset plugin root here exits 0, and that guard must precede the
    // script invocation.
    const command = hooks.hooks.SessionStart[0].hooks[0].command;
    expect(command).toContain('exit 0');
    expect(command.indexOf('exit 0')).toBeLessThan(command.indexOf('hook-warm.sh'));
  });

  it('exists and is executable', () => {
    const { accessSync, X_OK } = require('fs');
    expect(() => accessSync(resolve(PLUGIN_DIR, 'scripts', 'hook-warm.sh'), X_OK)).not.toThrow();
  });

  it('backgrounds the pinned install so it never blocks session start', () => {
    // `nohup … &` detaches the install and the script exits 0 immediately; a warm
    // that blocked session start would be worse than the cold fetch it avoids.
    expect(warmContent).toContain('nohup npm install --prefer-offline');
    expect(warmContent).toContain('>/dev/null 2>&1 </dev/null &');
    expect(warmContent).toContain('exit 0');
  });

  it('installs to the same deterministic dir resolve_code_audit uses (pin_dir)', () => {
    // The warm must target the exact dir resolve_pinned_bin installs into, so the
    // first edit's resolver finds the CLI already there — no PATH resolution that
    // a same-named global could shadow.
    expect(warmContent).toContain('pin_dir');
    expect(warmContent).toContain('node_modules/.bin/code-audit');
  });

  it('pins the warm to the plugin version, never @latest', () => {
    // plugin_version feeds the exact manifest version into the pinned install,
    // matching resolve_code_audit's last-resort command.
    expect(warmContent).toContain('plugin_version');
    expect(warmContent).toContain('code-auditor-mcp@${pv}');
  });

  it('short-circuits when already installed (no re-check on a warm session)', () => {
    // A warm session must not re-run npm install on every launch; it exits 0 as
    // soon as the installed bin exists.
    expect(warmContent).toContain('[ -x "${bin}" ] && exit 0');
  });

  it('is silent on failure — output to /dev/null, no stderr diagnostics', () => {
    expect(warmContent).toContain('>/dev/null 2>&1');
    expect(warmContent).not.toContain('>&2');
  });

  it('uses --prefer-offline so a warm cache is a cache hit, not a re-check', () => {
    expect(warmContent).toContain('--prefer-offline');
  });
});

describe('MCP server config — deliberately no .mcp.json', () => {
  it('does NOT bundle an .mcp.json (skill + CLI path; standalone server for shell-less hosts)', () => {
    const { existsSync } = require('fs');
    expect(existsSync(resolve(PLUGIN_DIR, '.mcp.json'))).toBe(false);
  });
});

describe('Hook script (hook-audit.sh)', () => {
  it('exists and is executable', () => {
    const { statSync, accessSync, X_OK } = require('fs');
    const scriptPath = resolve(PLUGIN_DIR, 'scripts', 'hook-audit.sh');
    expect(() => accessSync(scriptPath, X_OK)).not.toThrow();
  });

  it('contains the audit command', () => {
    const content = readFileSync(
      resolve(PLUGIN_DIR, 'scripts', 'hook-audit.sh'),
      'utf-8',
    );
    expect(content).toContain('code-audit changed --stdin --json');
  });

  it('fails loudly when the CLI breaks (never a silent no-op)', () => {
    const content = readFileSync(
      resolve(PLUGIN_DIR, 'scripts', 'hook-audit.sh'),
      'utf-8',
    );
    // A non-zero CLI exit that isn't a finding (2) must be reported and exit 1,
    // not swallowed as a clean pass.
    expect(content).toContain('HOOK BROKEN');
    expect(content).toContain('exit 1');
  });

  it('sources the shared resolver and pins to a compatible CLI', () => {
    const content = readFileSync(
      resolve(PLUGIN_DIR, 'scripts', 'hook-audit.sh'),
      'utf-8',
    );
    expect(content).toContain('hook-common.sh');
    expect(content).toContain('assert_compatible');
  });
});

describe('Hook compatibility pin (hook-common.sh)', () => {
  const content = readFileSync(
    resolve(PLUGIN_DIR, 'scripts', 'hook-common.sh'),
    'utf-8',
  );

  it('compares semvers, not the full --version banner', () => {
    // The `--version` output carries a "(sqlite: …)" suffix, so the pin must
    // extract a bare semver before comparing against the manifest version.
    expect(content).toContain('semver_of');
    expect(content).toContain('[0-9]+\\.[0-9]+\\.[0-9]+');
  });

  it('fails loudly when a version cannot be determined (never trusts an unidentified binary)', () => {
    expect(content).toContain('cannot verify CLI version');
    expect(content).toContain('refusing to run an unidentified binary');
  });

  it('names both versions on a mismatch', () => {
    expect(content).toContain('version mismatch: plugin');
    expect(content).toContain('vs CLI');
  });

  it('installs the pinned package to a deterministic dir and invokes it by absolute path (not npx)', () => {
    // The shadowing fix: npx -p puts the package bin on PATH where a same-named
    // global shim shadows it. resolve_pinned_bin must npm-install to pin_dir and
    // echo node_modules/.bin/code-audit, so PATH is never consulted.
    expect(content).toContain('resolve_pinned_bin');
    expect(content).toContain('pin_dir');
    expect(content).toContain('node_modules/.bin/code-audit');
    expect(content).toContain('npm install --prefer-offline --prefix');
    expect(content).toContain('--ignore-scripts');
  });

  it('pin_dir keys the install by version so a plugin update installs a fresh copy', () => {
    expect(content).toContain('XDG_CACHE_HOME');
    expect(content).toContain('/code-auditor/cli/');
  });
});

describe('Skill file (SKILL.md)', () => {
  const content = readFileSync(
    resolve(PLUGIN_DIR, 'skills', 'code-auditor', 'SKILL.md'),
    'utf-8',
  );

  it('has YAML frontmatter with description', () => {
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('description:');
  });

  it('references search tool', () => {
    expect(content).toContain('search');
  });

  it('references audit tool', () => {
    expect(content).toContain('audit');
  });

  it('references config rules-list', () => {
    expect(content).toContain('config');
    expect(content).toContain('rules-list');
  });

  it('references next-file (the file-by-file remediation loop)', () => {
    expect(content).toContain('next-file');
  });

  it('teaches hook feedback interpretation', () => {
    expect(content).toContain('hook');
  });

  it('references definition tool', () => {
    expect(content).toContain('definition');
  });
});

/**
 * Spec 46 R1 (extended by Spec 54, then by the advisory→high rename) — guard the
 * skill docs against re-teaching a reverted gate model.
 *
 * Three reversions are guarded here. Spec 45 reverted the per-rule `gating: true`
 * opt-in, the binary (severity-free) gate, and diff-scoped enforcement. Spec 54
 * then removed the configurable gate (`gateSeverities`), per-path severity
 * capping (`severityOverrides`), and the `warning`/`suggestion` vocabulary —
 * every reading is now `critical`, `severe`, or `high`, and every one of them
 * blocks. Spec 54's own third-tier name `advisory` was later renamed to `high`
 * because "advisory" read as optional — the same failure mode the rename was
 * meant to eliminate — so `advisory` is a reverted phrase too. The skill files
 * are what a consuming agent reads to learn how the gate behaves, so drift here
 * is the highest-leverage place a reverted model could survive. This test fails
 * if any of the three skill files re-mentions a reverted model, so the docs and
 * the code cannot silently diverge again.
 */
describe('Skill gate-model drift guard (Spec 46 R1)', () => {
  const SKILL_FILES = ['SKILL.md', 'SKILL-RULE-KINDS.md', 'SKILL-SEARCH.md'];
  const SKILL_DIR = resolve(PLUGIN_DIR, 'skills', 'code-auditor');

  // Phrases that describe a reverted gate model. Each is a specific claim a
  // consuming agent would act on wrongly. Kept as literal substrings so the test
  // fails on the exact regression, not on fuzzy prose. (The bare words
  // "per-rule" and "severity" are deliberately NOT here: the corrected docs
  // legitimately say "there is no per-rule opt-in" and "severity is urgency",
  // and those negations must pass.)
  const REVERTED_PHRASES = [
    'gating: true', // the per-rule opt-in (removed — every rule gates)
    'gating:true',
    'pass the gate', // warnings/suggestions "pass the gate" (removed — every severity gates)
    'regardless of severity', // binary gate (removed — severity decides)
    'per-rule gating', // per-rule gating flag (removed)
    'per-rule flag', // per-rule gating flag (removed)
    'gateSeverities', // the configurable gate (Spec 54 — removed)
    'severityOverrides', // per-path severity capping (Spec 54 — removed)
    'advisory', // Spec 54's third-tier name (renamed to `high` — it read as optional)
  ];

  for (const file of SKILL_FILES) {
    it(`${file} does not teach the reverted gate model`, () => {
      const content = readFileSync(resolve(SKILL_DIR, file), 'utf-8');
      for (const phrase of REVERTED_PHRASES) {
        expect(
          content.toLowerCase().includes(phrase.toLowerCase()),
          `${file} re-mentions the reverted gate model: "${phrase}". ` +
            'Spec 45 reverted the per-rule gate and Spec 54 removed the ' +
            'configurable gate and the warning/suggestion vocabulary — every ' +
            'reading is critical, severe, or high, every severity blocks, and ' +
            'enforcement is not diff-scoped.',
        ).toBe(false);
      }
    });
  }

  it('SKILL.md teaches the current gate model', () => {
    const content = readFileSync(resolve(SKILL_DIR, 'SKILL.md'), 'utf-8');
    // Every severity is gating, not per-rule, and explicitly not diff-scoped.
    expect(content).toContain('not diff-scoped');
    expect(content).toContain('no non-blocking severity tier');
    // All three severities name themselves as gating readings.
    expect(content).toContain('critical');
    expect(content).toContain('severe');
    expect(content).toContain('high');
  });
});

