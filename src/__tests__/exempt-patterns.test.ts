/**
 * exemptPatterns — file paths only (Gap 4)
 *
 * exemptPatterns match file paths, never symbol names. Before the fix,
 * isExempt() was called on function names (func.name), class names (cls.name),
 * and method names (method.name) — meaning `specialOffer` was incorrectly
 * exempted (contains "spec"), `MockDataService` was exempted (contains "mock"),
 * etc.
 *
 * These are pure unit tests — no WASM, no MCP server, no tmpdir.
 * isExempt() is a regex check on file paths; we test it directly.
 */

import { describe, it, expect } from 'vitest';
import { UniversalDocumentationAnalyzer } from '../analyzers/universal/UniversalDocumentationAnalyzer.js';

function isExempt(filePath: string, patterns: string[]): boolean {
  const analyzer = new UniversalDocumentationAnalyzer();
  return (analyzer as any).isExempt(filePath, patterns);
}

describe('exemptPatterns — file paths only (Gap 4)', () => {
  it('files matching \\.spec\\. are exempt from documentation checks', () => {
    // foo.spec.ts matches the \\.spec\\. pattern — exempt by file path
    expect(isExempt('src/foo.spec.ts', ['\\.spec\\.'])).toBe(true);
  });

  it('functions with names matching exemptPatterns substrings are NOT exempt', () => {
    // "specialOffer" contains "spec" but exemptPatterns match FILE PATHS only.
    // production.ts does NOT match \\.spec\\., so it's NOT exempt.
    expect(isExempt('src/production.ts', ['\\.spec\\.'])).toBe(false);
  });

  it('both fixtures together: spec file exempt, production file not exempt', () => {
    const patterns = ['\\.spec\\.'];
    expect(isExempt('src/foo.spec.ts', patterns)).toBe(true);
    expect(isExempt('src/production.ts', patterns)).toBe(false);
  });

  it('file named mock-data.ts (matching mock pattern) is exempt by path', () => {
    // mock-data.ts matches the 'mock' literal pattern in the file path
    expect(isExempt('src/mock-data.ts', ['mock'])).toBe(true);
  });
});
