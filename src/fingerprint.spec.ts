import { describe, it, expect } from 'vitest';
import { fingerprint } from './fingerprint.js';

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
});
