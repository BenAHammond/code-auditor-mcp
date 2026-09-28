/**
 * Spec 68 §3.2 — the `batch-functions` producer.
 *
 * The producer walks a file's AST and projects every function whose full source
 * span contains a transaction-scope commit signal: `.batch(` (Cloudflare D1 /
 * SQLite batching) or `.transaction(` (better-sqlite3's `db.transaction(fn)`,
 * which wraps its callback's statements in one atomic transaction). `multi-table-
 * write` skips any write whose enclosing function carries one of these spans,
 * because a single commit scope has no transaction-boundary risk.
 *
 * This test pins both signals directly against the producer (not the rule): the
 * `.transaction(` arm is the Spec 68 self-audit precision fix that stops
 * `clearIndex`'s transaction-wrapped `DELETE FROM` sequence from being flagged as
 * a multi-table boundary hazard.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import { extractBatchFunctions } from '../phase/batchFunctions.js';
import type { AstFile } from '../phase/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
}, 30_000);

/** Parse `source` as a TypeScript file and run the producer over it. */
function batches(source: string): Array<{ startLine: number; endLine: number }> {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('tx.ts')!;
  const ast = parseFile('tx.ts', source)!;
  const file: AstFile = { file: 'tx.ts', format: 'typescript', source, ast, adapter };
  return extractBatchFunctions(file).map((f) => ({ startLine: f.startLine, endLine: f.endLine }));
}

describe('Spec 68 batch-functions producer', () => {
  it('projects a function whose span contains .batch(', () => {
    const source = [
      'function run() {',
      '  db.batch([',
      '    db.prepare("DELETE FROM a").run(),',
      '    db.prepare("DELETE FROM b").run(),',
      '  ]);',
      '}',
      '',
    ].join('\n');
    expect(batches(source).length).toBe(1);
  });

  it('projects a function whose span contains .transaction(', () => {
    const source = [
      'function clear() {',
      '  db.transaction(() => {',
      '    db.prepare("DELETE FROM a").run();',
      '    db.prepare("DELETE FROM b").run();',
      '  })();',
      '}',
      '',
    ].join('\n');
    expect(batches(source).length).toBe(1);
  });

  it('projects a .transaction( in a nested callback up to the outer function', () => {
    // The signal sits in an arrow passed to `db.transaction`, but the enclosing
    // named method is the write owner and must be cleared too. The arrow's own
    // span does not contain `.transaction(` (the call is outside it), so only the
    // outer method emits — and that is exactly what clears the write.
    const source = [
      'class Db {',
      '  clear() {',
      '    this.db.transaction(() => { this.db.prepare("DELETE FROM a").run(); })();',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(batches(source)).toEqual([{ startLine: 2, endLine: 4 }]);
  });

  it('projects nothing when neither signal is present', () => {
    const source = [
      'function run() {',
      '  db.prepare("DELETE FROM a").run();',
      '  db.prepare("DELETE FROM b").run();',
      '}',
      '',
    ].join('\n');
    expect(batches(source)).toEqual([]);
  });
});
