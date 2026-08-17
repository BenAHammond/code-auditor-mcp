/**
 * Regression tests for extractClassUsage's attribute-matching boundary.
 *
 * The className/class attribute regex must be word-boundary anchored: without
 * the leading \b, `class` matches as a substring of identifiers like
 * `error_class`, so a SQL string literal (`error_class = 'zombie-capped'`)
 * leaks its *value* into the class-usage table and is later flagged
 * undefined-class. This encodes the #4(a) bug.
 */
import { describe, it, expect } from 'vitest';
import { extractClassUsage } from './styleIndexer.js';

describe('extractClassUsage — attribute boundary', () => {
  it('extracts real className="..." attributes', () => {
    const usage = extractClassUsage('component.tsx', '<div className="mt-1 text-xs">hi</div>');
    expect(usage.map((u) => u.className)).toEqual(['mt-1', 'text-xs']);
  });

  it('extracts real class="..." attributes in HTML', () => {
    const usage = extractClassUsage('page.html', '<p class="mt-1 text-xs">hi</p>');
    expect(usage.map((u) => u.className)).toEqual(['mt-1', 'text-xs']);
  });

  it('does NOT treat `class` inside `error_class = ...` as an attribute', () => {
    const sql = `"UPDATE discovery_queue SET state = 'failed', error_class = 'zombie-capped', error = '' WHERE state = 'processing'"`;
    const usage = extractClassUsage('discovery-drain.ts', sql);
    // The value 'zombie-capped' must not leak into class usage.
    expect(usage.map((u) => u.className)).not.toContain('zombie-capped');
    expect(usage).toEqual([]);
  });

  it('does NOT match `class` inside other identifiers (myclassName, foo_class)', () => {
    const src = `const myclassName = 'x'; const foo_class = 'y'; const x = 'bar';`;
    const usage = extractClassUsage('app.ts', src);
    expect(usage).toEqual([]);
  });

  it('does NOT extract class usage from data/config files (Bug #3)', () => {
    // A .json/.sql/.toml/.prisma/.go file can contain a raw source snippet with
    // `error_class = 'zombie-capped'`; it must never reach the class-usage table.
    const src = `<div className="mt-1">hi</div> error_class = 'zombie-capped'`;
    for (const ext of ['.json', '.sql', '.toml', '.prisma', '.go', '.css', '.scss']) {
      expect(extractClassUsage(`report${ext}`, src)).toEqual([]);
    }
  });

  it('still extracts class usage from markup/component extensions', () => {
    const src = `<div className="mt-1">hi</div>`;
    for (const ext of ['.tsx', '.jsx', '.ts', '.js', '.html', '.vue', '.svelte']) {
      expect(extractClassUsage(`component${ext}`, src).map((u) => u.className)).toEqual(['mt-1']);
    }
  });
});
