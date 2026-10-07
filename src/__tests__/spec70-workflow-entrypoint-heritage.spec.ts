/**
 * Spec 70 Q3 — `WorkflowEntrypoint<Env>` base-class heritage resolution.
 *
 * A `this.<field>` receiver (`this.env.DB.prepare(…)`) resolves to the enclosing
 * class's base-class field type (`extends WorkflowEntrypoint<Env>` → `this.env`
 * is `Env`), then through the member path by the same interface-field seam as B3
 * (`interface Env { DB: D1Database }` → `Env.DB` is `D1Database` → handle). The
 * rule is the same as B2: resolve the declaration or abstain — never infer a
 * handle from the class merely having a generic parameter.
 *
 * Three layers are pinned here:
 *   1. `resolveThisFieldType` — the heritage text → field-type mapping (pure).
 *   2. `classifyRootIdentifier` — the heritage arm resolves `Env` + `['DB']` to a
 *      handle and abstains (`unproven`) when there is no heritage contract.
 *   3. The extraction seam — `extractR3Sites` threads `thisFieldType` from the
 *      parsed AST, and `extractDataAccessCallCandidates` threads `handleThisFieldType`
 *      on a non-literal (dynamic-SQL) site, which re-folds to `handle`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import {
  classifyRootIdentifier,
  resolveThisFieldType,
  findEnclosingClassHeritage,
  extractInterfaceFields,
  buildBindingEnv,
  type RootResolutionEnv,
  type Binding,
} from '../analyzers/receiverRoot.js';
import { extractR3Sites } from '../analyzers/provenance.js';
import { extractDataAccessCallCandidates } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { identifyHandle, type HandleVerdict } from '../analyzers/handleIdentification.js';

let tsAdapter: LanguageAdapter;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
}, 30_000);

describe('Spec 70 Q3 — resolveThisFieldType (heritage text → field type)', () => {
  it('resolves `this.env` from `WorkflowEntrypoint<Env>`', () => {
    expect(resolveThisFieldType('env', 'WorkflowEntrypoint<Env>')).toBe('Env');
  });

  it('resolves `this.ctx` from `WorkflowEntrypoint<Env>`', () => {
    expect(resolveThisFieldType('ctx', 'WorkflowEntrypoint<Env>')).toBe('ExecutionContext');
  });

  it('resolves a non-default type argument under the same contract', () => {
    expect(resolveThisFieldType('env', 'WorkflowEntrypoint<MyBindings>')).toBe('MyBindings');
  });

  it('resolves the sibling worker base classes', () => {
    expect(resolveThisFieldType('env', 'WorkerEntrypoint<Env>')).toBe('Env');
    expect(resolveThisFieldType('env', 'Agent<Env>')).toBe('Env');
    expect(resolveThisFieldType('state', 'DurableObject<Env>')).toBe('DurableObjectState');
  });

  it('defaults to `Env` when the base class carries no type argument', () => {
    expect(resolveThisFieldType('env', 'WorkflowEntrypoint')).toBe('Env');
  });

  it('abstains (null) for an unknown base class — never a guess from a generic parameter', () => {
    expect(resolveThisFieldType('env', 'SomeBase<Env>')).toBeNull();
  });

  it('abstains (null) for a known base class with no such field', () => {
    expect(resolveThisFieldType('noSuchField', 'WorkflowEntrypoint<Env>')).toBeNull();
  });

  it('abstains (null) for a missing heritage', () => {
    expect(resolveThisFieldType('env', null)).toBeNull();
    expect(resolveThisFieldType('env', undefined)).toBeNull();
  });
});

describe('Spec 70 Q3 — classifyRootIdentifier heritage arm', () => {
  /** A resolution env carrying only the interface field map, no bindings/provenance. */
  function envWithFields(interfaceFields: ReadonlyMap<string, ReadonlyMap<string, string>>): RootResolutionEnv {
    return {
      provenance: new Map<string, never>(),
      bindings: new Map<string, Binding>(),
      interfaceFields,
      adapter: undefined,
      sourceCode: '',
    } as unknown as RootResolutionEnv;
  }

  const ifaceEnv = envWithFields(new Map([['Env', new Map([['DB', 'D1Database']])]]));

  function heritage(name: string, thisFieldType: string | null, memberPath: readonly string[] = ['DB']): string {
    return classifyRootIdentifier(name, ifaceEnv, 0, { thisField: true, thisFieldType, memberPath });
  }

  it('resolves `this.env` (Env) through `Env.DB → D1Database` to `handle`', () => {
    expect(heritage('env', 'Env')).toBe('handle');
  });

  it('resolves through a non-default type argument to `handle`', () => {
    const env = envWithFields(new Map([['MyBindings', new Map([['DB', 'D1Database']])]]));
    expect(classifyRootIdentifier('env', env, 0, { thisField: true, thisFieldType: 'MyBindings', memberPath: ['DB'] })).toBe('handle');
  });

  it('abstains (`unproven`) when there is no heritage contract', () => {
    // `thisFieldType` null — the class had no base class or an unknown one.
    expect(heritage('env', null)).toBe('unproven');
  });

  it('abstains (`unproven`) when the interface field is absent', () => {
    expect(heritage('env', 'Env', ['missing'])).toBe('unproven');
  });

  it('heritage is authoritative before a same-named local binding (shadow, not the field)', () => {
    const env = envWithFields(new Map([['Env', new Map([['DB', 'D1Database']])]]));
    const bindings = new Map<string, Binding>([['env', { kind: 'variable', typeText: 'string' }]]);
    const shadowed = { ...env, bindings } as RootResolutionEnv;
    // `env` is a `this.env` field: the local `string` variable is a shadow and must
    // not downgrade the heritage-resolved `Env` → handle.
    expect(classifyRootIdentifier('env', shadowed, 0, { thisField: true, thisFieldType: 'Env', memberPath: ['DB'] })).toBe('handle');
  });
});

describe('Spec 70 Q3 — extraction seam threads thisFieldType', () => {
  // Literal SQL → an R3 (sql-argument) site; `thisFieldType` is still threaded.
  const literalSrc = [
    "import { D1Database } from '@cloudflare/workers-types';",
    'interface Env { DB: D1Database }',
    'class Repo extends WorkflowEntrypoint<Env> {',
    '  query() { return this.env.DB.prepare("SELECT 1").all(); }',
    '}',
  ].join('\n');

  // Dynamic SQL (a `sql` parameter) → no R3 site; the data-access candidate is the
  // only path, and heritage is the only way it can reach `handle`.
  const dynamicSrc = [
    "import { D1Database } from '@cloudflare/workers-types';",
    'interface Env { DB: D1Database }',
    'class Repo extends WorkflowEntrypoint<Env> {',
    '  query(sql: string) { return this.env.DB.prepare(sql).all(); }',
    '}',
  ].join('\n');

  function run<R>(src: string, fn: (ast: ReturnType<typeof parseFile> & object, adapter: LanguageAdapter) => R): R {
    const ast = parseFile('/fixture/heritage.ts', src)!;
    try {
      return fn(ast, tsAdapter);
    } finally {
      ast.dispose?.();
    }
  }

  /** The `this.env.DB.prepare(…)` call node, found through the adapter's walk. */
  function prepareCall(ast: ReturnType<typeof parseFile> & object, src: string): import('../../languages/types.js').ASTNode | undefined {
    return tsAdapter.findNodes(ast, { custom: (n) => n.type === 'call_expression' }).find((n) => tsAdapter.getNodeText(n, src).includes('prepare'));
  }

  it('findEnclosingClassHeritage reads the `extends WorkflowEntrypoint<Env>` clause', () => {
    run(dynamicSrc, (ast) => {
      const call = prepareCall(ast, dynamicSrc);
      expect(call).toBeTruthy();
      const heritage = findEnclosingClassHeritage(ast, tsAdapter, call!, dynamicSrc);
      expect(heritage).toBe('WorkflowEntrypoint<Env>');
    });
  });

  it('extractR3Sites threads thisFieldType: `Env` for a literal `this.env.DB.prepare`', () => {
    run(literalSrc, (ast) => {
      const sites = extractR3Sites(ast, tsAdapter, literalSrc);
      const site = sites.find((s) => s.thisField);
      expect(site).toBeTruthy();
      expect(site!.thisFieldType).toBe('Env');
    });
  });

  it('extractDataAccessCallCandidates threads handleThisFieldType and re-folds to handle on a dynamic-SQL site', () => {
    run(dynamicSrc, (ast) => {
      const candidates = extractDataAccessCallCandidates(ast, tsAdapter, dynamicSrc);
      const cand = candidates.find((c) => c.handleThisField);
      expect(cand, 'expected a this-rooted candidate').toBeTruthy();
      expect(cand!.handleThisFieldType).toBe('Env');

      // Re-fold the provenance-dependent half exactly as the corpus producer's
      // member arm does (`reFoldHandleVerdict`), with the re-derived bindings +
      // interface fields. `sqlArg` is null (dynamic SQL), so the sql-argument
      // source abstains and heritage is the only path to `handle`.
      const bindings = buildBindingEnv(ast, tsAdapter, dynamicSrc);
      const interfaceFields = extractInterfaceFields(ast, tsAdapter, dynamicSrc);
      const env = {
        provenance: new Map<string, never>(),
        bindings,
        interfaceFields,
        adapter: undefined,
        sourceCode: '',
      } as unknown as RootResolutionEnv;
      const verdict: HandleVerdict = identifyHandle(
        {
          format: 'typescript',
          root: cand!.handleRoot!,
          receiver: cand!.handleReceiver!,
          method: cand!.handleMethod!,
          sqlArgument: cand!.handleSqlArg,
          thisField: cand!.handleThisField,
          thisFieldType: cand!.handleThisFieldType,
        },
        {
          imports: new Map(),
          typeAnnotations: new Map(),
          bindings: new Map(),
          withinFileProvenance: new Map(),
          sqlDialect: null,
          resolution: { dialect: 'ts', env },
        },
      );
      expect(verdict.kind).toBe('handle');
    });
  });
});
