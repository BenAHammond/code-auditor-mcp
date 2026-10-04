/**
 * Spec 69 §10 R1/R2 — receiver root extraction returns the FIRST chain segment,
 * not the last.
 *
 * `resolveReceiverRoot` walks a member/selector chain to its root identifier.
 * The defect: for a `this`-rooted chain it fell back to `findFirstProperty`,
 * which scanned the *whole callee* for the first `property_identifier` it found
 * — that is the *method* (`prepare`/`exec`), i.e. the last segment. So
 * `this.env.DB.prepare()` reported root `prepare` instead of `env`, and
 * `this.ctx.storage.sql.exec()` reported `exec` instead of `ctx`. The
 * mis-named root hid the real receiver from form-3 resolution (R3) and made the
 * cannot-fire diagnostic name the method, not the receiver's first segment.
 *
 * This pins the corrected walk: a `this`-rooted chain yields the first property
 * after `this` (`env`, `ctx`); non-`this` chains already yielded the leftmost
 * segment and are pinned here to lock the invariant across all shapes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import { resolveReceiverRoot } from '../analyzers/receiverRoot.js';
import { getCallExpressionCallee } from '../analyzers/provenance.js';
import type { ASTNode } from '../languages/types.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

/** Root of the (first) call expression's callee in `src`. */
function rootOf(src: string): string | null {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile('/fixture/root.ts')!;
  const ast = parseFile('/fixture/root.ts', src)!;
  try {
    const calls = adapter.findNodes(ast, { custom: (n: ASTNode) => n.type === 'call_expression' });
    const callee = getCallExpressionCallee(calls[0], adapter);
    return callee ? resolveReceiverRoot(callee, adapter, src) : null;
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 69 §10 R1/R2 — receiver root extraction returns the first segment', () => {
  it('this.env.DB.prepare() → env (not prepare)', () => {
    expect(rootOf('this.env.DB.prepare("SELECT 1");')).toBe('env');
  });

  it('this.ctx.storage.sql.exec() → ctx (not exec)', () => {
    expect(rootOf('this.ctx.storage.sql.exec("SELECT 1");')).toBe('ctx');
  });

  it('$(table).find() → $ (leftmost, ambient global)', () => {
    expect(rootOf('$(table).find();')).toBe('$');
  });

  it('a.b.c.d.query() → a (leftmost)', () => {
    expect(rootOf('a.b.c.d.query();')).toBe('a');
  });

  it('db.query() → db (leftmost)', () => {
    expect(rootOf('db.query("SELECT 1");')).toBe('db');
  });

  it('this.db.query() → db (first property after this, not the method)', () => {
    expect(rootOf('this.db.query("SELECT 1");')).toBe('db');
  });
});

describe('Spec 69 §10 — builder chains descend through call expressions', () => {
  // The receiver of `.first()`/`.all()`/`.run()` is a *call expression*
  // (`db.prepare(…).bind(…)`), not a member chain ending in an identifier. The
  // walk must recurse into the call's callee, then into *that* receiver, until
  // it reaches the leftmost identifier — otherwise it returns the trailing
  // property (`bind`/`prepare`/`first`/`run`/`where`/`query`/`then`) instead of
  // the root (`db`/`env`/`knex`/`pool`).
  it('db.prepare("SELECT 1").bind(1).first() → db (not bind/prepare/first)', () => {
    expect(rootOf('db.prepare("SELECT 1").bind(1).first();')).toBe('db');
  });

  it('db.prepare("SELECT 1").all() → db (not prepare/all)', () => {
    expect(rootOf('db.prepare("SELECT 1").all();')).toBe('db');
  });

  it('this.env.DB.prepare("SELECT 1").bind(1).run() → env (not run/bind/prepare)', () => {
    expect(rootOf('this.env.DB.prepare("SELECT 1").bind(1).run();')).toBe('env');
  });

  it('knex("t").where({a:1}).first() → knex (not where/first)', () => {
    expect(rootOf('knex("t").where({a:1}).first();')).toBe('knex');
  });

  it('pool.query("SELECT 1").then(r => r.rows) → pool (not query/then)', () => {
    expect(rootOf('pool.query("SELECT 1").then(r => r.rows);')).toBe('pool');
  });
});
