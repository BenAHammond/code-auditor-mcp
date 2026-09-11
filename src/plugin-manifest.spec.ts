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
 * Spec 46 R1 (extended by Spec 54) — guard the skill docs against re-teaching a
 * reverted gate model.
 *
 * Two reversions are guarded here. Spec 45 reverted the per-rule `gating: true`
 * opt-in, the binary (severity-free) gate, and diff-scoped enforcement. Spec 54
 * then removed the configurable gate (`gateSeverities`), per-path severity
 * capping (`severityOverrides`), and the `warning`/`suggestion` vocabulary —
 * every reading is now `critical`, `severe`, or `high`, and every one of them
 * blocks. The skill files are what a consuming agent reads to learn how the gate
 * behaves, so drift here is the highest-leverage place a reverted model could
 * survive. This test fails if any of the three skill files re-mentions either
 * reverted model, so the docs and the code cannot silently diverge again.
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
    // All three severities name themselves as gating defects.
    expect(content).toContain('critical');
    expect(content).toContain('severe');
    expect(content).toContain('high');
  });
});

