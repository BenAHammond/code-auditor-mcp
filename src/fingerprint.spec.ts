import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fingerprint, buildFingerprintInput } from './fingerprint.js';
import type { Violation } from './types.js';

describe('fingerprint', () => {
  it('produces the same fingerprint for the same violation at different lines (line-shift stability)', () => {
    const a = fingerprint({
      analyzer: 'solid',
      rule: 'single-responsibility',
      file: 'src/services/UserService.ts',
      symbol: 'UserService',
    });
    const b = fingerprint({
      analyzer: 'solid',
      rule: 'single-responsibility',
      file: 'src/services/UserService.ts',
      symbol: 'UserService',
    });
    // Same input → same output.  The key property is that line numbers are
    // NOT part of the fingerprint, so edits that shift lines above a
    // violation don't change its identity.
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // hex SHA-256
  });

  it('produces different fingerprints for different violations', () => {
    const base = fingerprint({
      analyzer: 'solid',
      rule: 'single-responsibility',
      file: 'src/services/UserService.ts',
      symbol: 'UserService',
    });

    // Different analyzer
    expect(
      fingerprint({
        analyzer: 'dry',
        rule: 'single-responsibility',
        file: 'src/services/UserService.ts',
        symbol: 'UserService',
      })
    ).not.toBe(base);

    // Different rule
    expect(
      fingerprint({
        analyzer: 'solid',
        rule: 'interface-segregation',
        file: 'src/services/UserService.ts',
        symbol: 'UserService',
      })
    ).not.toBe(base);

    // Different file
    expect(
      fingerprint({
        analyzer: 'solid',
        rule: 'single-responsibility',
        file: 'src/services/OrderService.ts',
        symbol: 'UserService',
      })
    ).not.toBe(base);

    // Different symbol
    expect(
      fingerprint({
        analyzer: 'solid',
        rule: 'single-responsibility',
        file: 'src/services/UserService.ts',
        symbol: 'OrderService',
      })
    ).not.toBe(base);
  });

  it('prevents delimiter collisions via JSON-array encoding', () => {
    // If we naively joined with ":", these two would collide.
    // JSON-array encoding prevents that.
    const fp1 = fingerprint({
      analyzer: 'a:b',
      rule: 'c',
      file: 'd',
      symbol: 'e',
    });
    const fp2 = fingerprint({
      analyzer: 'a',
      rule: 'b:c',
      file: 'd',
      symbol: 'e',
    });
    expect(fp1).not.toBe(fp2);
  });

  it('produces distinct fingerprints for different react rules on the same line', () => {
    // React analyzer sets violationType, not rule. Two different
    // react rules on the same line must fingerprint as distinct
    // findings — otherwise baseline known/new counts are wrong.
    const complexityViolation: Violation = {
      file: 'src/components/Widget.tsx',
      line: 42,
      rule: 'complexity',
      severity: 'high',
      message: "Component 'Widget' has high complexity (25)",
      analyzer: 'react',
      violationType: 'complexity',
    };

    const errorBoundaryViolation: Violation = {
      file: 'src/components/Widget.tsx',
      line: 42,
      rule: 'no-error-boundary',
      severity: 'severe',
      message: "Complex component 'Widget' should be wrapped in an error boundary",
      analyzer: 'react',
      violationType: 'no-error-boundary',
    };

    const fp1 = fingerprint(buildFingerprintInput(complexityViolation));
    const fp2 = fingerprint(buildFingerprintInput(errorBoundaryViolation));

    // Same line, same analyzer, same file — but different rules.
    // rule is now required on Violation, so they produce distinct fingerprints directly.
    expect(fp1).not.toBe(fp2);

    // Verify the rules are correct
    expect(buildFingerprintInput(complexityViolation).rule).toBe('complexity');
    expect(buildFingerprintInput(errorBoundaryViolation).rule).toBe('no-error-boundary');
  });

  it('canonicalizes the file path so symlink aliases hash identically', () => {
    // macOS `/tmp` is a symlink to `/private/tmp`: `changed -p /tmp/foo` carries
    // the lexical path into `file`, while `dismiss` run from inside the project
    // sees the resolved `/private/tmp/foo`. The same finding must hash the same
    // either way (the SKILL.md "changed --json → dismiss" workflow depends on it).
    const base = mkdtempSync(join(tmpdir(), 'ca-fp-'));
    const real = join(base, 'real');
    const link = join(base, 'link');
    mkdirSync(real);
    writeFileSync(join(real, 'a.ts'), '');
    symlinkSync(real, link);
    try {
      const violation: Violation = { analyzer: 'data-access', rule: 'loop-query', file: join(real, 'a.ts'), symbol: 'f' };
      const viaReal = fingerprint(buildFingerprintInput(violation));
      const viaAlias = fingerprint(buildFingerprintInput({ ...violation, file: join(link, 'a.ts') }));
      expect(viaAlias).toBe(viaReal);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
