/**
 * Spec 60.1 — import specifier classification (five classes).
 *
 * Pure-function tests: `classifyImportSpecifier` takes a specifier, the source
 * file path, and an in-memory corpus file set. No filesystem, no parsers.
 *
 * Spec 60's original 13 fixture tests are retained below. Eight pass unchanged;
 * five asserted the three-class scheme (`external` or the 3-class enumeration) and
 * are updated to the five-class scheme — see the AC13 note in the report. AC12
 * fixture tests for each correction follow.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyImportSpecifier,
  DEFAULT_VIRTUAL_MODULES,
  type SpecifierClassification,
} from '../importClassification.js';

// A representative ESM TypeScript corpus file set (absolute paths).
function corpus(...files: string[]): Set<string> {
  return new Set(files);
}

const SRC = '/proj/src/index.ts';

describe('classifyImportSpecifier', () => {
  // ── internal-resolved (Spec 60 — unchanged) ───────────────────────────

  it('resolves a relative `.js` specifier to the `.ts` file (ESM strip)', () => {
    const files = corpus('/proj/src/types.ts');
    expect(classifyImportSpecifier('./types.js', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/types.ts',
    });
  });

  it('resolves a relative specifier with no extension via the `.ts` probe', () => {
    const files = corpus('/proj/src/types.ts');
    expect(classifyImportSpecifier('./types', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/types.ts',
    });
  });

  it('resolves a directory specifier via `/index.ts`', () => {
    const files = corpus('/proj/src/util/index.ts');
    expect(classifyImportSpecifier('./util', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/util/index.ts',
    });
  });

  it('resolves `../` traversal to a sibling directory file', () => {
    const files = corpus('/proj/foo/bar.ts');
    const source = '/proj/src/a/index.ts';
    // dirname('/proj/src/a/index.ts') = '/proj/src/a'; `../../foo/bar` climbs two
    // levels to `/proj`, then into `foo/bar`.
    expect(classifyImportSpecifier('../../foo/bar', source, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/foo/bar.ts',
    });
  });

  it('prefers an exact `base` hit over the stripped+ext probe', () => {
    const files = corpus('/proj/src/types.js', '/proj/src/types.ts');
    // base === '/proj/src/types.js' is probed first and must win.
    expect(classifyImportSpecifier('./types.js', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/types.js',
    });
  });

  it('strips `.jsx`/`.mjs`/`.cjs` and probes the TypeScript counterparts', () => {
    const files = corpus('/proj/src/a.tsx', '/proj/src/b.mts', '/proj/src/c.cts');
    expect(classifyImportSpecifier('./a.jsx', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/a.tsx',
    });
    expect(classifyImportSpecifier('./b.mjs', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/b.mts',
    });
    expect(classifyImportSpecifier('./c.cjs', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/c.cts',
    });
  });

  // ── package / unresolved-alias (Spec 60.1 — `external` split) ────────

  it('classifies a bare package name as package', () => {
    expect(classifyImportSpecifier('react', SRC, corpus()).classification).toBe(
      'package',
    );
  });

  it('classifies a scoped package as package', () => {
    expect(
      classifyImportSpecifier('@scope/pkg', SRC, corpus()).classification,
    ).toBe('package');
  });

  it('classifies Node builtins as package', () => {
    expect(classifyImportSpecifier('fs', SRC, corpus()).classification).toBe(
      'package',
    );
    expect(classifyImportSpecifier('path', SRC, corpus()).classification).toBe(
      'package',
    );
    expect(classifyImportSpecifier('node:fs', SRC, corpus()).classification).toBe(
      'package',
    );
  });

  it('classifies a `@/alias` specifier as unresolved-alias', () => {
    expect(
      classifyImportSpecifier('@/components/Button', SRC, corpus()).classification,
    ).toBe('unresolved-alias');
  });

  // ── internal-broken (Spec 60 — unchanged) ─────────────────────────────

  it('classifies a relative specifier with no matching file as internal-broken', () => {
    expect(classifyImportSpecifier('./missing', SRC, corpus('/proj/src/index.ts'))).toEqual(
      { classification: 'internal-broken' },
    );
  });

  it('does not resolve via basename, path-segment, or prefix matching', () => {
    // A file that *contains* the target as a segment must NOT satisfy the probe.
    const files = corpus('/proj/src/other/missing.ts', '/proj/src/missing_helper.ts');
    expect(classifyImportSpecifier('./missing', SRC, files)).toEqual({
      classification: 'internal-broken',
    });
  });

  // ── classification exhaustiveness (five classes) ─────────────────────

  it('returns exactly one of the five classes for a range of inputs', () => {
    const classes: SpecifierClassification[] = [
      'package',
      'unresolved-alias',
      'internal-resolved',
      'internal-broken',
      'unresolved-virtual',
    ];
    const files = corpus('/proj/src/types.ts', '/proj/src/util/index.ts');
    const inputs = [
      'react',
      '@x/y',
      'node:path',
      '@/x',
      './types.js',
      './types',
      './util',
      '../types',
      './nope',
    ];
    for (const s of inputs) {
      const r = classifyImportSpecifier(s, SRC, files);
      expect(classes).toContain(r.classification);
      if (r.classification === 'internal-resolved') {
        expect(typeof r.resolvedPath).toBe('string');
        expect(files.has(r.resolvedPath!)).toBe(true);
      } else {
        expect(r.resolvedPath).toBeUndefined();
      }
    }
  });

  // ── AC12 — one fixture per correction ─────────────────────────────────

  it('resolves a specifier to a `.d.ts` declaration file', () => {
    const files = corpus('/proj/src/types.d.ts');
    expect(classifyImportSpecifier('./types', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/types.d.ts',
    });
  });

  it('a `.ts` beats a `.d.ts` at the same stem', () => {
    const files = corpus('/proj/src/types.ts', '/proj/src/types.d.ts');
    expect(classifyImportSpecifier('./types', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/types.ts',
    });
  });

  it('strips a trailing `?query` suffix', () => {
    const files = corpus('/proj/src/data.jsonl');
    expect(classifyImportSpecifier('./data.jsonl?raw', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/data.jsonl',
    });
  });

  it('strips a trailing `#fragment` suffix', () => {
    const files = corpus('/proj/src/types.ts');
    expect(classifyImportSpecifier('./types.js#frag', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/types.ts',
    });
  });

  it('strips `?query` before the `.js`→`.ts` strip', () => {
    const files = corpus('/proj/src/types.ts');
    expect(classifyImportSpecifier('./types.js?raw', SRC, files)).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/types.ts',
    });
  });

  it('classifies `@/` as alias with no tsconfig present', () => {
    // No `aliasPatterns` supplied — `@/` is alias on its own.
    expect(classifyImportSpecifier('@/components/Button', SRC, corpus())).toEqual({
      classification: 'unresolved-alias',
    });
  });

  it('classifies a tsconfig `paths` pattern match as alias', () => {
    const opts = { aliasPatterns: ['~/*'] };
    expect(classifyImportSpecifier('~/utils/foo', SRC, corpus(), opts)).toEqual({
      classification: 'unresolved-alias',
    });
    expect(classifyImportSpecifier('utils/foo', SRC, corpus(), opts)).toEqual({
      classification: 'package',
    });
  });

  it('classifies a bare package as package', () => {
    expect(classifyImportSpecifier('react', SRC, corpus())).toEqual({
      classification: 'package',
    });
  });

  it('classifies a listed virtual specifier as unresolved-virtual', () => {
    expect(classifyImportSpecifier('.blitz', SRC, corpus())).toEqual({
      classification: 'unresolved-virtual',
    });
  });

  it('AC10 — default virtual list is [`.blitz`]; an unlisted `.`-prefixed specifier stays broken', () => {
    expect(DEFAULT_VIRTUAL_MODULES).toEqual(['.blitz']);
    // Listed → virtual.
    expect(
      classifyImportSpecifier('.blitz', SRC, corpus(), { virtualModules: DEFAULT_VIRTUAL_MODULES }),
    ).toEqual({ classification: 'unresolved-virtual' });
    // Unlisted, `.`-prefixed → not virtual, and no file → broken.
    expect(
      classifyImportSpecifier('.my-virtual', SRC, corpus(), { virtualModules: DEFAULT_VIRTUAL_MODULES }),
    ).toEqual({ classification: 'internal-broken' });
  });

  // ── alias resolution (Spec 60.1 — `@/` through tsconfig paths) ────────

  it('resolves a `@/*` → `./*` alias through tsconfig paths', () => {
    const files = corpus('/proj/app/components/Button.tsx');
    expect(
      classifyImportSpecifier('@/app/components/Button', '/proj/app/page.tsx', files, {
        pathMappings: { '@/*': ['./*'] },
        baseUrl: '.',
        projectRoot: '/proj',
      }),
    ).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/app/components/Button.tsx',
    });
  });

  it('resolves an alias through a `baseUrl`-rooted target', () => {
    const files = corpus('/proj/src/components/Button.tsx');
    expect(
      classifyImportSpecifier('@/components/Button', '/proj/app/page.tsx', files, {
        pathMappings: { '@/*': ['src/*'] },
        baseUrl: '.',
        projectRoot: '/proj',
      }),
    ).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/src/components/Button.tsx',
    });
  });

  it('returns unresolved-alias when the alias target is absent from the corpus', () => {
    expect(
      classifyImportSpecifier('@/missing', '/proj/app/page.tsx', corpus(), {
        pathMappings: { '@/*': ['./*'] },
        baseUrl: '.',
        projectRoot: '/proj',
      }),
    ).toEqual({ classification: 'unresolved-alias' });
  });

  it('resolves a `baseUrl`-rooted bare import to a local file', () => {
    const files = corpus('/proj/app/actions.ts');
    expect(
      classifyImportSpecifier('app/actions', '/proj/app/page.tsx', files, {
        baseUrl: '.',
        projectRoot: '/proj',
      }),
    ).toEqual({
      classification: 'internal-resolved',
      resolvedPath: '/proj/app/actions.ts',
    });
  });

  it('a bare import that is not under `baseUrl` stays `package`', () => {
    expect(
      classifyImportSpecifier('react', '/proj/app/page.tsx', corpus(), {
        baseUrl: '.',
        projectRoot: '/proj',
      }),
    ).toEqual({ classification: 'package' });
  });
});
