/**
 * Spec 55 R3 — `isTestOrSpecPath`, the shared language-agnostic test/spec path
 * predicate that rule-level test exclusion (loop-query / unfiltered-query /
 * too-many-queries) keys off. These pin the segment-anchored matching: a
 * `test`/`tests`/`__tests__` directory *segment* counts, but a path whose
 * component merely *contains* "test" (`contest`, `latest`) must not.
 */

import { describe, it, expect } from 'vitest';
import { isTestOrSpecPath } from './testConventions.js';

describe('isTestOrSpecPath — test/spec filename and directory shapes', () => {
  const testPaths = [
    'tests/e2e/harness.ts',
    'src/tests/query.test.ts',
    'test/foo.ts',
    'src/test/foo.spec.tsx',
    '__tests__/foo.js',
    'src/__tests__/foo.jsx',
    'foo.test.ts',
    'foo.spec.tsx',
    'foo.test.js',
    'foo.spec.js',
    'deep/nested/bar.test.ts',
    'foo_test.go',
    'C:\\proj\\tests\\foo.test.ts', // windows separators normalize
  ];

  const nonTestPaths = [
    'src/contest/foo.ts',
    'src/latest/bar.ts',
    'src/util.ts',
    'src/greatest/helper.ts',
    'src/testify.ts', // a module named "testify" is not a test directory
    'src/testsuitepkg.ts',
  ];

  for (const p of testPaths) {
    it(`matches ${p}`, () => {
      expect(isTestOrSpecPath(p)).toBe(true);
    });
  }

  for (const p of nonTestPaths) {
    it(`does not match ${p}`, () => {
      expect(isTestOrSpecPath(p)).toBe(false);
    });
  }
});
