/**
 * Honesty guards for the TS `solid/liskov-substitution` rule.
 *
 * The rule must fire only on a genuine LSP break: a subclass *override* that
 * throws where the same-named parent method does not. Each near-miss below is
 * the specific proxy the old check matched on — any subclass method containing
 * `throw`, regardless of whether it overrode anything or whether the parent
 * also threw.
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

async function lspViolations(code: string, name: string) {
  const ast = parseFile(`${name}.ts`, code)!;
  if (!ast) throw new Error(`Failed to parse ${name}.ts`);
  const violations = await (analyzer as any).analyzeAST(ast, adapter, DEFAULT_SOLID_CONFIG, code);
  return violations.filter((v: any) => v.rule === 'solid/liskov-substitution');
}

describe('solid/liskov-substitution — override-throws-where-parent-does-not', () => {
  it('flags an override that throws where the parent does not (true positive)', async () => {
    const code = `
class Bird {
  fly() { return "flying"; }
}
class Ostrich extends Bird {
  fly() { throw new Error("cannot fly"); }
}
`;
    const violations = await lspViolations(code, 'lsp-tp');
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('Ostrich.fly');
  });

  it('does NOT flag an override that does not throw (near-miss)', async () => {
    const code = `
class Bird {
  fly() { return "flying"; }
}
class Sparrow extends Bird {
  fly() { return "flying"; }
}
`;
    const violations = await lspViolations(code, 'lsp-nothrow');
    expect(violations).toHaveLength(0);
  });

  it('does NOT flag when the parent also throws (contract preserved)', async () => {
    const code = `
class Bird {
  fly() { throw new Error("abstract"); }
}
class Ostrich extends Bird {
  fly() { throw new Error("cannot fly"); }
}
`;
    const violations = await lspViolations(code, 'lsp-both-throw');
    expect(violations).toHaveLength(0);
  });

  it('does NOT flag when the parent cannot be resolved (cross-file parent)', async () => {
    // `Bird` is imported/undefined here — we cannot establish the contract, so
    // the rule claims nothing rather than accusing the method blindly.
    const code = `
class Ostrich extends Bird {
  fly() { throw new Error("cannot fly"); }
}
`;
    const violations = await lspViolations(code, 'lsp-unresolved');
    expect(violations).toHaveLength(0);
  });

  it('does NOT flag a throwing method that is not an override', async () => {
    const code = `
class Bird {
  fly() { return "flying"; }
}
class Ostrich extends Bird {
  swim() { throw new Error("cannot swim"); }
}
`;
    const violations = await lspViolations(code, 'lsp-new-method');
    expect(violations).toHaveLength(0);
  });

  it('does NOT flag a throwing method on a class with no parent', async () => {
    const code = `
class Greeter {
  greet() { throw new Error("unimplemented"); }
}
`;
    const violations = await lspViolations(code, 'lsp-no-parent');
    expect(violations).toHaveLength(0);
  });
});
