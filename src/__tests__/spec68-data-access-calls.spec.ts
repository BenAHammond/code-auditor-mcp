/**
 * Spec 68 §3.2 — the `data-access-calls` producer.
 *
 * The liveness guard (§16.1) proves the producer returns a live, shaped array;
 * this test proves the extraction is *correct* against the fields the
 * data-access rules read: resolved `tables`, the write/read filter signals
 * (`hasFilter` / `hasOrganizationFilter`), injection-risk flags, and the
 * enclosing function. It exercises the producer wiring in `producers.ts`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import type { ParsedFile, ResolvedQuery } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function calls(path: string, source: string): ResolvedQuery[] {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = {
    file: path,
    format: 'typescript',
    source,
    ast,
    adapter: adapter!,
  };
  try {
    return PRODUCERS['data-access-calls']['typescript'].process(file);
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 68 data-access-calls producer', () => {
  it('resolves a raw db.query call to its table with filter + injection signals', () => {
    const out = calls('/fixture/a.ts', [
      'export function getUser(db, id) {',
      '  return db.query("SELECT * FROM users WHERE id = " + id);',
      '}',
    ].join('\n'));

    expect(out.length).toBeGreaterThan(0);
    const call = out[0];
    expect(call.file).toBe('/fixture/a.ts');
    expect(call.tables).toContain('users');
    expect(call.hasFilter).toBe(true);
    expect(call.enclosingFunction).toBe('getUser');
    // String-concatenated input is the injection-risk signal.
    expect(call.hasSqlInjectionRisk).toBe(true);
  });

  it('returns an empty array for a file with no DB calls', () => {
    const out = calls('/fixture/b.ts', 'export const x = 1;\n');
    expect(out).toEqual([]);
  });
});
