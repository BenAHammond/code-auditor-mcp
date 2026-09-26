/**
 * Spec 68 §16 guard 1 (Amendment 1) — producer liveness.
 *
 * The four compile-time checks (§2.3 residue, §4 serializability, §3.1 single
 * producer) all pass over a `PRODUCERS` map whose `process` bodies throw. A
 * type-total map is not the same as a working one: a producer can be declared,
 * satisfy every mapped-type check, and still throw, return `undefined`, or
 * return a value of the wrong shape at runtime. TypeScript will not tell you
 * that. This test does.
 *
 * Every producer is run against a fixture of each format it declares; the
 * returned value must not throw, must not be `undefined`, and must match its
 * declared `FactShapes[K]` at the top level (an array for the twelve array
 * facts, a `{ tables: [...] }` object for `table-catalog`) and round-trip
 * through JSON. A producer that throws, returns undefined, or returns the
 * wrong shape fails. It is written red-first: before any producer is migrated
 * in §3.2, all thirteen throw "declared but not yet migrated" and the test is
 * the meter that reads 0/13 until the vertical slice (§3.2) and §9 land.
 *
 * The corpus producer `table-catalog` is not a per-file producer: it is run
 * against complete (empty) upstream facts, not a parsed file.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS, FACT_KINDS } from '../phase/producers.js';
import type { FactKind, FactShapes, ParsedFile, Format } from '../phase/types.js';

/** One fixture: a file path and its source. Path extension drives the adapter. */
type Fixture = { readonly path: string; readonly source: string };

/** A fixture per declared format. `typescript` and `javascript` are distinct
 *  grammars only in the format name; both parse via the tree-sitter loader. */
const FIXTURES: Record<Format, Fixture> = {
  typescript: {
    path: '/fixture/sample.ts',
    source: [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export class User {',
      '  id = 0;',
      '}',
      '',
    ].join('\n'),
  },
  tsx: {
    path: '/fixture/sample.tsx',
    source: [
      'export function Button({ label }: { label: string }) {',
      '  return <button>{label}</button>;',
      '}',
      '',
    ].join('\n'),
  },
  javascript: {
    path: '/fixture/sample.js',
    source: [
      'export function greet(name) {',
      '  return "hi " + name;',
      '}',
      '',
    ].join('\n'),
  },
  go: {
    path: '/fixture/sample.go',
    source: [
      'package main',
      '',
      'import "fmt"',
      '',
      'func main() {',
      '  fmt.Println("hello")',
      '}',
      '',
    ].join('\n'),
  },
  css: {
    path: '/fixture/sample.css',
    source: ['.button { color: red; }', ''].join('\n'),
  },
  scss: {
    path: '/fixture/sample.scss',
    source: ['$color: red;', '.button { color: $color; }', ''].join('\n'),
  },
  json: {
    path: '/fixture/sample.json',
    source: ['{', '  "users": {', '    "type": "object",',
      '    "properties": { "id": { "type": "integer" } }',
      '  }', '}', ''].join('\n'),
  },
};

/** The one fact kind whose top-level shape is an object, not an array. */
const OBJECT_FACTS: ReadonlySet<FactKind> = new Set<FactKind>(['table-catalog']);

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

/** Build a `ParsedFile` for a fixture — the only place an AST is allowed to live. */
function parsedFileFor(fixture: Fixture): ParsedFile {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(fixture.path);
  expect(adapter, `no adapter resolves ${fixture.path}`).not.toBeNull();
  const ast = parseFile(fixture.path, fixture.source);
  expect(ast, `fixture ${fixture.path} failed to parse`).not.toBeNull();
  return {
    file: fixture.path,
    format: formatFor(fixture.path),
    source: fixture.source,
    ast: ast!,
    adapter: adapter!,
  };
}

/** The format a fixture path declares (inverse of the FIXTURES key). */
function formatFor(path: string): Format {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.js')) return 'javascript';
  if (path.endsWith('.go')) return 'go';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.scss')) return 'scss';
  if (path.endsWith('.json')) return 'json';
  return 'typescript';
}

/** Assert a returned value matches the declared top-level shape and is serializable. */
function assertShape(kind: FactKind, value: unknown): void {
  expect(value, `producer for ${kind} returned undefined`).not.toBeUndefined();
  if (OBJECT_FACTS.has(kind)) {
    expect(value, `producer for ${kind} must return an object`).toBeTypeOf('object');
    const catalog = value as FactShapes['table-catalog'];
    expect(Array.isArray(catalog.tables), `producer for ${kind} must expose .tables array`).toBe(true);
  } else {
    expect(Array.isArray(value), `producer for ${kind} must return an array`).toBe(true);
    for (const element of value as unknown[]) {
      expect(element, `producer for ${kind} emitted a null element`).not.toBeNull();
      expect(typeof element, `producer for ${kind} emitted a non-object element`).toBe('object');
    }
  }
  // §4 serializability, exercised at runtime: a tree-sitter node or a function
  // cannot round-trip through JSON.
  expect(() => JSON.stringify(value), `producer for ${kind} returned a non-serializable value`).not.toThrow();
}

describe('Spec 68 §16 guard 1 — producer liveness (Amendment 1)', () => {
  it('every producer is declared for a known fact kind', () => {
    // The count is derived from FACT_KINDS (compile-time-pinned to FactKind via
    // `satisfies Record<FactKind, true>`), not a hand-maintained literal — it
    // widens with the vocabulary instead of being edited by hand. PRODUCERS
    // `satisfies ProducerMap`, so the producer count IS the fact-kind count.
    expect(Object.keys(PRODUCERS).length).toBe(Object.keys(FACT_KINDS).length);
  });

  for (const [id, producer] of Object.entries(PRODUCERS)) {
    const isCorpus = 'needs' in producer;
    if (isCorpus) {
      it(`corpus producer "${id}" produces a live ${producer.produces} from empty upstream facts`, () => {
        const upstream = {} as Record<string, unknown>;
        for (const need of producer.needs) upstream[need] = [];
        const value = (producer as { process(f: Record<string, unknown>): unknown }).process(upstream);
        assertShape(producer.produces, value);
      });
    } else {
      for (const format of producer.formats) {
        it(`file producer "${id}" produces a live ${producer.produces} from a ${format} file`, () => {
          const parsed = parsedFileFor(FIXTURES[format]);
          try {
            const value = (producer as { process(f: ParsedFile): unknown }).process(parsed);
            assertShape(producer.produces, value);
          } finally {
            parsed.ast.dispose?.();
          }
        });
      }
    }
  }
});
