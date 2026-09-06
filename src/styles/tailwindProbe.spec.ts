/**
 * Unit tests for TailwindProbe's bare-import resolution.
 *
 * These cover the #4(b) fix: Tailwind v4 ecosystem plugin imports
 * (tw-animate-css, shadcn/tailwind.css) were previously dropped from the
 * compile-probe input, so plugin-provided utilities (animate-accordion-up,
 * data-closed:animate-accordion-up, …) were wrongly flagged undefined. The
 * probe now re-injects those bare @imports and serves their CSS from the
 * audited project's node_modules.
 *
 * `extractBareImports` and `resolveCssImport` are pure string/fs helpers, so
 * they are tested directly (via the private-method escape hatch) with a
 * synthetic node_modules fixture — no tailwindcss needed in this repo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TailwindProbe, flattenThemeSection } from './tailwindProbe.js';

describe('TailwindProbe — extractBareImports', () => {
  const probe = new TailwindProbe();

  it('extracts only bare package specifiers, dropping relative/absolute/url/tailwindcss imports', () => {
    probe.setProjectCss(`
      @import "tailwindcss";
      @import "tailwindcss/theme";
      @import "./theme.css";
      @import "../shared/ui.css";
      @import "/abs/path.css";
      @import url("https://cdn.example.com/x.css");
      @import url('tw-animate-css');
      @import "tw-animate-css";
      @import "shadcn/tailwind.css";
      @import "@scope/pkg/theme.css";
    `);
    const specs = (probe as unknown as { extractBareImports(): string[] }).extractBareImports();
    expect(specs).toEqual(['tw-animate-css', 'shadcn/tailwind.css', '@scope/pkg/theme.css']);
  });

  it('deduplicates repeated specifiers and returns [] with no project css', () => {
    probe.setProjectCss('@import "tw-animate-css";\n@import "tw-animate-css";');
    const specs = (probe as unknown as { extractBareImports(): string[] }).extractBareImports();
    expect(specs).toEqual(['tw-animate-css']);

    probe.setProjectCss('');
    expect((probe as unknown as { extractBareImports(): string[] }).extractBareImports()).toEqual([]);
  });
});

describe('TailwindProbe — resolveCssImport', () => {
  let root: string;
  const probe = new TailwindProbe();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tw-probe-spec-'));
    const writePkg = (dir: string, pkg: unknown) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
    };
    const writeCss = (filePath: string, css: string) => {
      mkdirSync(join(filePath, '..'), { recursive: true });
      writeFileSync(filePath, css);
    };
    // tw-animate-css: bare package, "." export with a `style` condition.
    writePkg(join(root, 'node_modules', 'tw-animate-css'), {
      name: 'tw-animate-css',
      exports: { '.': { style: './dist/tw-animate.css', import: './dist/index.mjs' } },
    });
    writeCss(join(root, 'node_modules', 'tw-animate-css', 'dist', 'tw-animate.css'), '/* animate */');

    // shadcn: subpath export "./tailwind.css" with a `style` condition.
    writePkg(join(root, 'node_modules', 'shadcn'), {
      name: 'shadcn',
      exports: { './tailwind.css': { style: './dist/tailwind.css' } },
    });
    writeCss(join(root, 'node_modules', 'shadcn', 'dist', 'tailwind.css'), '/* shadcn */');

    // scoped package with a plain-string export.
    writePkg(join(root, 'node_modules', '@scope', 'pkg'), {
      name: '@scope/pkg',
      exports: { './theme.css': './dist/theme.css' },
    });
    writeCss(join(root, 'node_modules', '@scope', 'pkg', 'dist', 'theme.css'), '/* scoped */');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves a bare package export preferring the style condition', () => {
    const resolved = (probe as unknown as { resolveCssImport(s: string, r: string): string | null })
      .resolveCssImport('tw-animate-css', root);
    expect(resolved).toBe(join(root, 'node_modules', 'tw-animate-css', 'dist', 'tw-animate.css'));
  });

  it('resolves a subpath export (shadcn/tailwind.css)', () => {
    const resolved = (probe as unknown as { resolveCssImport(s: string, r: string): string | null })
      .resolveCssImport('shadcn/tailwind.css', root);
    expect(resolved).toBe(join(root, 'node_modules', 'shadcn', 'dist', 'tailwind.css'));
  });

  it('resolves a scoped package subpath export', () => {
    const resolved = (probe as unknown as { resolveCssImport(s: string, r: string): string | null })
      .resolveCssImport('@scope/pkg/theme.css', root);
    expect(resolved).toBe(join(root, 'node_modules', '@scope', 'pkg', 'dist', 'theme.css'));
  });

  it('returns null for an absent package or unknown subpath', () => {
    const fn = (probe as unknown as { resolveCssImport(s: string, r: string): string | null }).resolveCssImport.bind(probe);
    expect(fn('no-such-plugin', root)).toBeNull();
    expect(fn('tw-animate-css/nope.css', root)).toBeNull();
    expect(fn('', root)).toBeNull();
  });
});

describe('flattenThemeSection — Tailwind v3 array-valued keys', () => {
  it('collapses a fontSize array to its size string, not numeric indices', () => {
    // Tailwind v3: fontSize '3xl' => ['1.875rem', { lineHeight: '2.25rem' }].
    // flattenThemeSection receives the section itself (theme.fontSize), so
    // the key is '3xl', not 'fontSize-3xl'.
    const out = flattenThemeSection({
      '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
      'sm': '0.875rem',
    } as Record<string, unknown>);

    expect(out['3xl']).toBe('1.875rem');
    expect(out['sm']).toBe('0.875rem');
    // The old object-walk produced garbage keys like these:
    expect(Object.keys(out)).not.toContain('3xl-0');
    expect(Object.keys(out)).not.toContain('3xl-1-lineHeight');
  });

  it('still flattens nested color objects with dotted keys', () => {
    const out = flattenThemeSection({
      blue: { 500: '#3b82f6' },
    } as Record<string, unknown>);
    expect(out['blue-500']).toBe('#3b82f6');
  });
});
