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
  return violations.filter((v: any) => v.rule === 'dependency-inversion');
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
