/**
 * Spec 68 §3.2 — the `cross-language-entities` producer.
 *
 * The liveness guard (§16.1) proves the producer returns a live, shaped array;
 * this test proves the extraction is *correct* against the fields the
 * cross-language analyzers actually read: TS `metadata.callees` /
 * `metadata.isMethod` / `visibility`, and Go `metadata.fields` with per-field
 * `isExported`. It exercises the producer wiring in `producers.ts`, not the
 * `extractCrossLanguageEntities` wrapper directly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import type { ParsedFile, Entity } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function entities(path: string, source: string): Entity[] {
  const format = path.endsWith('.go') ? 'go' : path.endsWith('.tsx') ? 'tsx' : 'typescript';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = { file: path, format, source, ast, adapter: adapter! };
  try {
    return PRODUCERS['cross-language-entities'][format].process(file);
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 68 cross-language-entities producer', () => {
  it('extracts a TS function with resolved callees, export visibility, and non-method flag', () => {
    const out = entities('/fixture/a.ts', [
      'import { send } from "./mail";',
      'export function notify(user: string) { send(); }',
    ].join('\n'));

    const fn = out.find((e) => e.name === 'notify')!;
    expect(fn).toBeDefined();
    expect(fn.type).toBe('function');
    expect(fn.language).toBe('typescript');
    expect(fn.visibility).toBe('public');
    expect(fn.metadata?.isMethod).toBe(false);
    expect(fn.metadata?.callees).toContain('send');
    // `clExtractTSParams` reads the `type` field's node text, which tree-sitter
    // renders as `type_annotation` (leading colon). Re-home faithfully — the
    // producer preserves the visitor's exact output.
    expect(fn.parameters).toEqual([{ name: 'user', type: ': string', optional: false, language: 'typescript' }]);
  });

  it('extracts a Go struct with per-field export status', () => {
    const out = entities('/fixture/b.go', [
      'package user',
      'type User struct {',
      '  Name string `json:"name"`',
      '  age  int',
      '}',
    ].join('\n'));

    const s = out.find((e) => e.name === 'User')!;
    expect(s).toBeDefined();
    expect(s.type).toBe('struct');
    expect(s.language).toBe('go');
    const fields = s.metadata?.fields ?? [];
    expect(fields.map((f) => f.name)).toEqual(['Name', 'age']);
    expect(fields.find((f) => f.name === 'Name')?.isExported).toBe(true);
    expect(fields.find((f) => f.name === 'age')?.isExported).toBe(false);
  });
});
