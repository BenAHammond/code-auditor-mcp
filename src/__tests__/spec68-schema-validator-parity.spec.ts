/**
 * Spec 68 §3.2 — parity: the migrated schema-validator rules reproduce the old
 * Stage-4 reducer's findings exactly.
 *
 * A rule is "migrated" only when the new `analyze(ctx)` over the
 * `cross-language-entities` fact produces the *same* findings the pre-migration
 * `createSchemaValidatorReducer` produced on a fixture — same file, line,
 * column, rule, severity. Not a "similar count": the full multiset of identity
 * tuples. This test runs BOTH paths and asserts the multisets are equal and
 * non-empty. It is the pin that lets §15 delete the reducer without losing the
 * golden reference.
 *
 * The fixture is a TS interface `User` and a Go struct `User` (same normalized
 * name → one cross-language pair). Its field set fires all three rule types:
 * `email` (TS-only required → missing-field), `extra` (Go-only → extra-field),
 * and `id`/`name` (shared names whose TS `: number`/`: string` type strings —
 * the producer emits the `:` prefix verbatim — differ from the Go `string`
 * types → schema-field-mismatch). The four-finding multiset pins all three
 * rules non-vacuously; the parity assertion is the load-bearing check, not the
 * exact count.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { PRODUCERS } from '../phase/producers.js';
import { analyzeSchemaValidator } from '../phase/runner.js';
import { schemaValidatorRules } from '../phase/rules/schemaValidator.js';
import { createSchemaValidatorReducer } from '../pipelineAdapters.js';
import type { ParsedFile, Entity } from '../phase/types.js';
import type { Violation } from '../types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function produce(path: string, source: string): Entity[] {
  const format = path.endsWith('.go') ? 'go' : 'typescript';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path);
  const ast = parseFile(path, source)!;
  const file: ParsedFile = { file: path, format, source, ast, adapter: adapter! };
  try {
    return PRODUCERS['cross-language-entities'][format].process(file) as Entity[];
  } finally {
    ast.dispose?.();
  }
}

/** The identity tuple a parity test pins — file, line, column, rule, severity. */
function key(f: { file: string; line?: number; column?: number; rule: string; severity: string }): string {
  return `${f.file}:${f.line ?? 0}:${f.column ?? 0}:${f.rule}:${f.severity}`;
}

const FIXTURE: ReadonlyArray<{ path: string; source: string }> = [
  {
    path: '/fixture/schema/user.ts',
    source: [
      'export interface User {',
      '  id: number;',
      '  name: string;',
      '  email: string;',
      '}',
    ].join('\n'),
  },
  {
    path: '/fixture/schema/user.go',
    source: [
      'package user',
      '',
      'type User struct {',
      '\tid    string',
      '\tname  string',
      '\textra int',
      '}',
    ].join('\n'),
  },
];

/** Build the producer's per-file fact map and the flat entity array. */
function buildFacts() {
  const byFile: Record<string, { entities: Entity[] }> = {};
  const flat: Entity[] = [];
  for (const { path, source } of FIXTURE) {
    const entities = produce(path, source);
    byFile[path] = { entities };
    flat.push(...entities);
  }
  return { byFile, flat };
}

describe('Spec 68 schema-validator parity (new analyze(ctx) === old reducer)', () => {
  it('covers exactly the three migrated schema-validator rules', () => {
    expect(schemaValidatorRules.map((r) => r.id)).toEqual([
      'schema-field-mismatch',
      'missing-field',
      'extra-field',
    ]);
  });

  it('produces the same identity multiset as the legacy reducer', async () => {
    const { byFile, flat } = buildFacts();

    const legacy = await createSchemaValidatorReducer().reduce(
      { 'cross-language-entities': byFile },
      { isScoped: false },
    );
    const old = (legacy.violations as Violation[]).map((v) => key({
      file: v.file,
      line: v.line,
      column: v.column,
      rule: v.rule,
      severity: v.severity,
    })).sort();

    const fresh = await analyzeSchemaValidator(flat, {});
    const nu = fresh.map((f) => key({
      file: f.file,
      line: f.line,
      column: f.column,
      rule: f.ruleId,
      severity: f.severity,
    })).sort();

    expect(nu).toEqual(old);
    expect(nu.length).toBeGreaterThan(0);
  });
});
