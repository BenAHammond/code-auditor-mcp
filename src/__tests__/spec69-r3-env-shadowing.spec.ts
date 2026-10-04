/**
 * Spec 69 R3 — `this.<field>` resolution must not be shadowed by a local name.
 *
 * `this.env.DB` is a *field* reference (`this` → the class's `env`), resolved
 * through the class's `extends Agent<Env>` heritage and the corpus type registry —
 * never a bare identifier. A local parameter or variable named `env` (or `ctx`,
 * `state`) in scope is a *shadow*, not the field's type: consulting it would let
 * `this.env.DB` resolve to the local's disposition instead of the field.
 *
 * Two failure directions, both of which a name-list approach and the original
 * flat-binding classifier got wrong:
 *
 *   • a local `env: string` + `extends Agent<Env>` — `this.env.DB` resolves
 *     through heritage to a `D1Database` type and, under Spec 70 criterion 9
 *     (a type name is not a handle test), must stay `unproven` (cannot-fire),
 *     never `not-handle`; the bug classified it `not-handle`, silently reading
 *     the DB access as clean.
 *   • a local `env: string` + *no* heritage — `this.env.DB` must stay `unproven`
 *     (cannot-fire); the bug classified it `not-handle`, quietly erasing a
 *     cannot-fire site.
 *
 * Pinned at both the classifier boundary (`classifyRootIdentifier` with
 * `thisField: true`) and the enumerator boundary (`resolveReceiverProvenance`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { AST, LanguageAdapter } from '../languages/types.js';
import {
  buildBindingEnv,
  classifyRootIdentifier,
} from '../analyzers/receiverRoot.js';
import type { RootResolutionEnv } from '../analyzers/receiverRoot.js';
import { resolveReceiverProvenance } from '../analyzers/receiverResolution.js';
import type { SourceFile } from '../analyzers/receiverResolution.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

function parse(source: string): { ast: AST; adapter: LanguageAdapter; source: string } {
  const path = '/fixture/env-shadowing.ts';
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(path)!;
  const ast = parseFile(path, source)!;
  return { ast, adapter, source };
}

/** Classify a root name as a `this`-rooted field (thisField: true). */
function classifyThisField(source: string, name: string): string {
  const { ast, adapter, source: sourceCode } = parse(source);
  try {
    const bindings = buildBindingEnv(ast, adapter, sourceCode);
    const env: RootResolutionEnv = { provenance: new Map(), bindings, adapter, sourceCode };
    return classifyRootIdentifier(name, env, 0, { thisField: true });
  } finally {
    ast.dispose?.();
  }
}

describe('Spec 69 R3 — env field shadowing (classifier boundary)', () => {
  it('a local `env: string` parameter does not shadow `this.env` (unproven, not not-handle)', () => {
    const src = 'function f(env: string) {}\n';
    expect(classifyThisField(src, 'env')).toBe('unproven');
  });

  it('a local `env` variable does not shadow `this.env` (unproven, not not-handle)', () => {
    const src = 'const env = loadThing();\n';
    expect(classifyThisField(src, 'env')).toBe('unproven');
  });

  it('a declared class field `db: D1Database` stays unproven through its field binding (criterion 9)', () => {
    const src = 'class P { db: D1Database; }\n';
    // A type name is no longer a handle test (Spec 70 criterion 9), so the
    // field's `D1Database` annotation keeps it visible-but-unproven rather than
    // proving it a handle (and rather than dropping it as not-handle).
    expect(classifyThisField(src, 'db')).toBe('unproven');
  });

  it('a declared class field `db: string` still resolves not-handle (clean, preserved)', () => {
    const src = 'class P { db: string; }\n';
    expect(classifyThisField(src, 'db')).toBe('not-handle');
  });
});

describe('Spec 69 R3 — env field shadowing (enumerator boundary)', () => {
  const CONFIG: SourceFile = {
    path: '/fixture/config.d.ts',
    content: `declare namespace Cloudflare {\n  interface Env { DB: D1Database; }\n}\ninterface Env extends Cloudflare.Env {}\n`,
  };

  it('this.env.DB with a shadowing local `env` AND heritage stays unproven (criterion 9)', async () => {
    const agent: SourceFile = {
      path: '/fixture/agent.ts',
      content: `export class HeroDataAgent extends Agent<Env> {\n  async resolve(env: string) {\n    return this.env.DB.prepare(sql).first();\n  }\n}\n`,
    };
    const report = await resolveReceiverProvenance([CONFIG, agent], '/fixture');
    const receivers = report.unprovenQueryReceivers.map((s) => s.receiver);
    // Heritage still resolves `this.env` to `Env.DB: D1Database`, but a type name
    // is not a handle test (criterion 9), so the site is reported unproven —
    // visible as cannot-fire, never dropped as not-handle (the original bug).
    // The SQL argument is a variable (`sql`), not a static literal: a static
    // literal would prove the receiver a handle via R3 under the default grammar
    // (Spec 70 R2), which is the adjacent behaviour this test must not entangle
    // with the type-name disposition it pins.
    expect(receivers).toContain('this.env.DB');
  });

  it('this.env.DB with a shadowing local `env` and NO heritage stays unproven (cannot-fire intact)', async () => {
    const plain: SourceFile = {
      path: '/fixture/plain.ts',
      content: `export class PlainThing {\n  run(env: string) {\n    this.env.DB.prepare(sql).first();\n  }\n}\n`,
    };
    const report = await resolveReceiverProvenance([plain], '/fixture');
    const sites = report.unprovenQueryReceivers.filter((s) => s.receiver === 'this.env.DB');
    expect(sites.length).toBe(1);
    expect(sites[0].method.toLowerCase()).toBe('prepare');
  });
});
