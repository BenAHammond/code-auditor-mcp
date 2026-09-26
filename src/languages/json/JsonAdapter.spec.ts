/**
 * Spec 68 Amendment 1 — the JSON adapter's position-preserving parse.
 *
 * The one property that matters: a finding emitted from a JSON schema rule must
 * carry a real line and column, so the parser must record the byte range and
 * line/column of every value. The old `jsonSchema.ts` `emit` hardcoded
 * `line: 1, column: 1`; this test pins the parser so that loss can never return.
 */

import { describe, it, expect } from 'vitest';
import { JsonAdapter } from './JsonAdapter.js';

const adapter = new JsonAdapter();

async function parse(source: string) {
  return adapter.parse('/fixture/sample.json', source);
}

describe('JsonAdapter (position-preserving JSON parse)', () => {
  it('resolves .json files only', () => {
    expect(adapter.supportsFile('/a/b/schema.json')).toBe(true);
    expect(adapter.supportsFile('/a/b/schema.JSON')).toBe(true);
    expect(adapter.supportsFile('/a/b/schema.ts')).toBe(false);
    expect(adapter.fileExtensions).toContain('.json');
  });

  it('parses a single-line object with exact positions', async () => {
    // `{"a": 1}` — indices: {0 "1 a2 "3 :4 (sp)5 16 }7  (length 8)
    const ast = await parse('{"a": 1}');
    expect(ast.errors).toEqual([]);
    expect(ast.root.type).toBe('object');
    expect(ast.root.range).toEqual([0, 8]);
    expect(ast.root.location.start).toEqual({ line: 1, column: 1 });
    expect(ast.root.location.end).toEqual({ line: 1, column: 9 });

    const value = ast.root.children![0];
    expect(adapter.getNodeName(value)).toBe('a');
    expect(value.type).toBe('number');
    expect(value.range).toEqual([6, 7]);
    expect(value.location.start).toEqual({ line: 1, column: 7 });
  });

  it('preserves line/column across multiple lines', async () => {
    const source = '{\n  "a": 1,\n  "b": "x"\n}';
    const ast = await parse(source);
    expect(ast.errors).toEqual([]);
    expect(ast.root.range).toEqual([0, 24]);
    expect(ast.root.location.start).toEqual({ line: 1, column: 1 });
    // Root ends after the closing `}` on line 4 (exclusive column 2).
    expect(ast.root.location.end).toEqual({ line: 4, column: 2 });

    const [aValue, bValue] = ast.root.children!;
    expect(adapter.getNodeName(aValue)).toBe('a');
    expect(aValue.type).toBe('number');
    expect(aValue.location.start).toEqual({ line: 2, column: 8 });

    expect(adapter.getNodeName(bValue)).toBe('b');
    expect(bValue.type).toBe('string');
    expect(bValue.location.start).toEqual({ line: 3, column: 8 });
  });

  it('nests arrays and objects, preserving each element position', async () => {
    const ast = await parse('{"items": [1, 2, 3], "nested": {"k": null}}');
    expect(ast.errors).toEqual([]);
    const root = ast.root;
    expect(root.type).toBe('object');
    const items = root.children!.find((c) => adapter.getNodeName(c) === 'items')!;
    expect(items.type).toBe('array');
    expect(items.children).toHaveLength(3);
    expect(items.children![0].type).toBe('number');
    // Element `2` sits at offset 14 on the single line → column 15.
    expect(items.children![1].location.start).toEqual({ line: 1, column: 15 });
    const nested = root.children!.find((c) => adapter.getNodeName(c) === 'nested')!;
    expect(nested.type).toBe('object');
    expect(nested.children![0].type).toBe('null');
  });

  it('records every scalar type', async () => {
    const ast = await parse('{"t": true, "f": false, "n": null, "s": "x", "num": -1.5e2}');
    expect(ast.errors).toEqual([]);
    const byName = new Map(ast.root.children!.map((c) => [adapter.getNodeName(c), c.type]));
    expect(byName.get('t')).toBe('boolean');
    expect(byName.get('f')).toBe('boolean');
    expect(byName.get('n')).toBe('null');
    expect(byName.get('s')).toBe('string');
    expect(byName.get('num')).toBe('number');
  });

  it('reports a parse error with its position rather than throwing', async () => {
    const ast = await parse('{"a": }');
    expect(ast.root.type).toBe('error');
    expect(ast.errors).toHaveLength(1);
    expect(ast.errors[0].severity).toBe('error');
    expect(ast.errors[0].location.start.line).toBe(1);
  });
});
