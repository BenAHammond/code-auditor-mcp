/**
 * Spec 38 R5 / task #41 — `dependency-inversion` must fire on *concrete types*,
 * not only statically-imported ones.
 *
 * The prior implementation gated the DIP signal on an imported-name table
 * (`importedNames.has(ctorName)`), which made the rule dead on locally-defined
 * classes and on every CommonJS `require()` codebase. These cases are the common
 * case, so this is a false-negative class in a shipping rule, not a calibration
 * detail. Each case below is run through the real analyzer — not registry
 * metadata — and asserts the correct presence/absence of a finding.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../../languages/index.js';
import { parseFile } from '../../languages/adapterBridge.js';
import type { LanguageAdapter } from '../../languages/types.js';
import { UniversalSOLIDAnalyzer, DEFAULT_SOLID_CONFIG } from './UniversalSOLIDAnalyzer.js';

let adapter: LanguageAdapter;
let analyzer: UniversalSOLIDAnalyzer;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  adapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!adapter) throw new Error('TypeScript adapter not registered');
  analyzer = new UniversalSOLIDAnalyzer();
}, 30_000);

async function solidViolations(code: string, name: string) {
  const ast = parseFile(`${name}.ts`, code)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  const violations = await (analyzer as any).analyzeAST(
    ast,
    adapter,
    DEFAULT_SOLID_CONFIG,
    code
  );
  return violations.filter((v: any) => v.rule === 'solid/dependency-inversion');
}

describe('dependency-inversion — concrete-type signal (task #41)', () => {
  it('flags a locally-defined class instantiated in the same file', async () => {
    const code = `
class AppGenerator {
  generate() { return 'ok'; }
}

class Bootstrap {
  run() {
    const g = new AppGenerator();
    return g.generate();
  }
}
`;
    const violations = await solidViolations(code, 'local-class');
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('Bootstrap');
  });

  it('flags a CommonJS require() binding instantiated directly', async () => {
    const code = `
const Runner = require('./runner');

class Client {
  constructor() {
    this.runner = new Runner();
  }
}
`;
    const violations = await solidViolations(code, 'require-binding');
    expect(violations).toHaveLength(1);
  });

  it('flags a statically-imported type (the case that always worked)', async () => {
    const code = `
import { PostgresRepo } from './repo';

class Service {
  constructor() {
    this.repo = new PostgresRepo();
  }
}
`;
    const violations = await solidViolations(code, 'imported-type');
    expect(violations).toHaveLength(1);
  });

  it('matches the registry invalid sample: unresolved bare concrete type', async () => {
    const code = `
class Service {
  constructor() {
    this.repo = new PostgresRepo();
  }
}
`;
    const violations = await solidViolations(code, 'unresolved-type');
    expect(violations).toHaveLength(1);
  });

  it('does not flag builtins, self-instantiation, or lowercase bindings', async () => {
    const code = `
class Widget {
  static create() { return new Widget(); }
  constructor() {
    this.date = new Date();
    this.map = new Map();
    this.err = new Error('boom');
    const factory = this.makeFactory();
    this.thing = new factory();
  }
  makeFactory() { return Widget; }
}
`;
    const violations = await solidViolations(code, 'near-misses');
    expect(violations).toHaveLength(0);
  });

  it('does not flag a member-access construction', async () => {
    const code = `
class Registry {
  build() {
    return new this.Ctor();
  }
  Ctor() { return class {}; }
}
`;
    const violations = await solidViolations(code, 'member-access');
    expect(violations).toHaveLength(0);
  });

  it('does not flag constructor injection (the registry valid sample)', async () => {
    const code = `
class Service {
  constructor(repo) { this.repo = repo; }
}
`;
    const violations = await solidViolations(code, 'constructor-injection');
    expect(violations).toHaveLength(0);
  });
});

describe('dependency-inversion — escapes vs. held (false-positive fix)', () => {
  // A constructed value that *escapes* (thrown or returned) is a value type,
  // not a collaborator the class depends on — it is not a DIP signal. A value
  // that is *held* (assigned to a field or captured as state) is a dependency.
  // The old predicate flagged ANY bare `new PascalCase()` in the class body,
  // including `throw new AppError(...)` and `return new Foo()` factory values.
  it('flags a collaborator assigned to a field (held — fires)', async () => {
    const code = `
class Database {
  connect() { return true; }
}

class Service {
  private db = new Database();
}
`;
    const violations = await solidViolations(code, 'held-field');
    expect(violations).toHaveLength(1);
  });

  it('does not flag an error value thrown from a method (escaped — near-miss)', async () => {
    // The reported false positive: a Durable Object whose only non-builtin
    // construction is an error type thrown from a method. `AppError` is a value
    // type, not a collaborator — throwing it is not "depending on a concretion".
    const code = `
class AppError extends Error {
  constructor(message) { super(message); }
}

class RateLimiter {
  async fetch(request) {
    if (!request) {
      throw new AppError('missing request');
    }
    return 'ok';
  }
}
`;
    const violations = await solidViolations(code, 'thrown-error');
    expect(violations).toHaveLength(0);
  });

  it('still flags a collaborator held via a local (guard against over-narrowing)', async () => {
    // The `new Database()` is not itself the thrown/returned operand — only the
    // derived reference is stored. It must still fire: the escapes filter clears
    // only constructions *directly* thrown or returned, not every `new` in a
    // method that happens to return something.
    const code = `
class Database {
  connect() { return true; }
}

class Service {
  constructor() {
    const db = new Database();
    this.db = db;
  }
}
`;
    const violations = await solidViolations(code, 'held-via-local');
    expect(violations).toHaveLength(1);
  });

  it('does not flag a parenthesized error value thrown (escaped through a wrapper)', async () => {
    // `throw (new AppError(...))` — the value still escapes; the parentheses are
    // transparent, not a place the class *holds* the error.
    const code = `
class AppError extends Error {
  constructor(message) { super(message); }
}

class Worker {
  run(input) {
    if (!input) {
      throw (new AppError('missing input'));
    }
    return 'ok';
  }
}
`;
    const violations = await solidViolations(code, 'parenthesized-throw');
    expect(violations).toHaveLength(0);
  });

  it('does not flag an as-asserted value returned (escaped through a cast)', async () => {
    const code = `
interface Shape {
  area(): number;
}

class Circle {
  area() { return 3; }
}

class ShapeFactory {
  build(): Shape {
    return new Circle() as Shape;
  }
}
`;
    const violations = await solidViolations(code, 'as-asserted-return');
    expect(violations).toHaveLength(0);
  });

  it('still flags an as-asserted collaborator held (a cast does not escape)', async () => {
    // The transparent walk-up must stop at the assignment, not climb past it:
    // `this.db = new Database() as Database` is held, cast or no cast.
    const code = `
class Database {
  connect() { return true; }
}

class Service {
  private db: Database;
  constructor() {
    this.db = new Database() as Database;
  }
}
`;
    const violations = await solidViolations(code, 'as-asserted-held');
    expect(violations).toHaveLength(1);
  });
});
