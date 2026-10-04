/**
 * Spec 69 R3 — form-3 `this.<field>` resolution through the class base type.
 *
 * `this.env.DB` resolves through the class's `extends Agent<Env>` heritage and the
 * corpus's own type-member declarations (`Env extends Cloudflare.Env` →
 * `Cloudflare.Env.DB: D1Database`), and `this.ctx.storage.sql` via the Durable
 * Object storage contract (`ctx` → `DurableObjectState` → `.storage` →
 * `DurableObjectStorage` → `.sql` → `SqlStorage`) — NOT a name match on `env.DB`
 * or an ambient `SqlStorage` guess.
 *
 * Since Spec 70 criterion 9, a resolved *type name* no longer proves handle: the
 * parsed SQL argument is the handle proof. So `classifyThisChain` returns
 * `unproven` (not `handle`) for a resolved DB-handle type; the end-to-end path
 * still resolves these sites to `handle` via the `sql-argument` source (parseable
 * SQL like `"SELECT 1"`). The negative: a plain class field with no resolvable
 * base type stays `unproven` (cannot-fire).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers } from '../languages/index.js';
import {
  classifyThisChain,
} from '../analyzers/receiverRoot.js';
import type { TypeRegistry } from '../analyzers/receiverRoot.js';
import {
  resolveReceiverProvenance,
} from '../analyzers/receiverResolution.js';
import type { SourceFile } from '../analyzers/receiverResolution.js';

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
});

const REGISTRY: TypeRegistry = {
  members: new Map([
    ['Env', new Map<string, string>()],
    ['Cloudflare.Env', new Map<string, string>([['DB', 'D1Database'], ['NAME', 'string']])],
  ]),
  methods: new Map<string, ReadonlySet<string>>(),
  heritage: new Map([['Env', ['Cloudflare.Env']]]),
};

describe('Spec 69 R3 — classifyThisChain (unit)', () => {
  it('this.env.DB → unproven (type name no longer proves handle; parsed SQL proves it)', () => {
    expect(classifyThisChain(['env', 'DB'], 'Agent<Env>', REGISTRY)).toBe('unproven');
  });

  it('this.ctx.storage.sql → unproven (type name no longer proves handle; parsed SQL proves it)', () => {
    expect(classifyThisChain(['ctx', 'storage', 'sql'], 'Agent<Env>', REGISTRY)).toBe('unproven');
  });

  it('an unknown this-field → unproven', () => {
    expect(classifyThisChain(['env', 'Nope'], 'Agent<Env>', REGISTRY)).toBe('unproven');
  });

  it('no base-class heritage → unproven (plain class field is not silently clean)', () => {
    expect(classifyThisChain(['db'], null, REGISTRY)).toBe('unproven');
  });

  it('a primitive resolved type → not-handle (declared non-DB field is clean)', () => {
    expect(classifyThisChain(['env', 'NAME'], 'Agent<Env>', REGISTRY)).toBe('not-handle');
  });
});

describe('Spec 69 R3 — end-to-end resolution (integration)', () => {
  const WORKER_CONFIG: SourceFile = {
    path: '/fixture/worker-config.d.ts',
    content: `declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    AI: Ai;
  }
}
interface Env extends Cloudflare.Env {}
`,
  };

  const HERO_AGENT: SourceFile = {
    path: '/fixture/hero.ts',
    content: `export class HeroDataAgent extends Agent<Env> {
  async resolve(heroSlug: string) {
    const row = await this.env.DB.prepare("SELECT 1").bind(heroSlug).first();
    this.ctx.storage.sql.exec("SELECT 1");
    this.ctx.storage.sql.prepare("SELECT 2").all();
  }
}
`,
  };

  const PLAIN_CLASS: SourceFile = {
    path: '/fixture/plain.ts',
    content: `export class PlainThing {
  run() {
    this.someUnknown.query(sql);
  }
}
`,
  };

  it('this.env.DB and this.ctx.storage.sql sites are NOT unproven (resolved to handle via parsed SQL)', async () => {
    // A named dialect enables the sql-argument source: `prepare("SELECT 1")` /
    // `exec("SELECT 1")` / `prepare("SELECT 2")` parse, proving handle. Without a
    // dialect the source abstains and these form-3 sites stay unproven.
    const report = await resolveReceiverProvenance([WORKER_CONFIG, HERO_AGENT], '/fixture', 'postgresql');
    const sites = report.unprovenQueryReceivers;
    const receivers = sites.map((s) => s.receiver);
    expect(receivers).not.toContain('this.env.DB');
    expect(receivers).not.toContain('this.ctx.storage.sql');
  });

  it('a plain unresolved this-field stays unproven (cannot-fire surface intact)', async () => {
    const report = await resolveReceiverProvenance([PLAIN_CLASS], '/fixture');
    const sites = report.unprovenQueryReceivers;
    const plain = sites.filter((s) => s.receiver === 'this.someUnknown');
    expect(plain.length).toBe(1);
    expect(plain[0].method.toLowerCase()).toBe('query');
  });
});
