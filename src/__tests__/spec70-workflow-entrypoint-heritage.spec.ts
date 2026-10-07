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
 * The base class's declared field type is read from the project's *declared
 * dependencies'* `.d.ts` (`makeHeritageResolver` → `resolveVendorSpecifier` →
 * `readClassFieldTypes`), never a bundled name map. When those declarations are
 * absent — which is every pinned clone, none of which carries `node_modules` —
 * the resolver abstains and the heritage arm leaves the site `unproven`. This is
 * fixture-tested against a synthetic `node_modules/@cloudflare/workers-types`
 * `.d.ts`, not corpus-measured.
 *
 * Three layers are pinned here:
 *   1. `makeHeritageResolver` — the declared-`.d.ts` field-type resolver (fixture).
 *   2. `classifyRootIdentifier` — the heritage arm resolves `Env` + `['DB']` to a
 *      handle and abstains (`unproven`) when there is no heritage contract or no
 *      resolver.
 *   3. The extraction seam — `extractR3Sites` threads `thisHeritage` from the
 *      parsed AST, and `extractDataAccessCallCandidates` threads `handleThisHeritage`
 *      on a non-literal (dynamic-SQL) site, which re-folds to `handle`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import {
  classifyRootIdentifier,
  findEnclosingClassHeritage,
  extractInterfaceFields,
  buildBindingEnv,
  type RootResolutionEnv,
  type Binding,
  type HeritageFieldResolver,
} from '../analyzers/receiverRoot.js';
import { makeHeritageResolver } from '../analyzers/receiverResolution.js';
import { extractR3Sites } from '../analyzers/provenance.js';
import { extractDataAccessCallCandidates } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { identifyHandle, type HandleVerdict } from '../analyzers/handleIdentification.js';

let tsAdapter: LanguageAdapter;
let projectRoot: string;
let heritageResolver: HeritageFieldResolver;

/** The synthetic workers-types `.d.ts`, standing in for the declared dependency's
 *  shipped types. Field declarations carry the base class's *declared* type-parameter
 *  names and their defaults — the source of truth the resolver substitutes against. */
const WORKERS_TYPES_DTS = `
abstract class WorkerEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;
}
abstract class WorkflowEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;
}
abstract class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;
  protected state: DurableObjectState;
}
class Agent<Env = unknown> {
  ctx: DurableObjectState;
  env: Env;
}
abstract class NoDefault<T> {
  protected env: T;
}
`;

/** Build a throwaway project whose `node_modules` declares `@cloudflare/workers-types`.
 *  Returns the project root — the resolver walks up from a synthetic importer at the
 *  root to `node_modules/@cloudflare/workers-types/package.json`. */
function buildWorkersTypesFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'code-auditor-heritage-'));
  const pkgDir = path.join(root, 'node_modules', '@cloudflare', 'workers-types');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@cloudflare/workers-types', types: 'index.d.ts' }),
  );
  writeFileSync(path.join(pkgDir, 'index.d.ts'), WORKERS_TYPES_DTS);
  return root;
}

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
  projectRoot = buildWorkersTypesFixture();
  heritageResolver = makeHeritageResolver(projectRoot, new Set(['@cloudflare/workers-types']))!;
}, 30_000);

afterAll(() => {
  if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
});

describe('Spec 70 Q3 — makeHeritageResolver (declared `.d.ts` → field type)', () => {
  it('resolves `this.env` from `WorkflowEntrypoint<Env>` to `Env`', () => {
    expect(heritageResolver('WorkflowEntrypoint', 'env', ['Env'])).toBe('Env');
  });

  it('resolves `this.ctx` from `WorkflowEntrypoint<Env>` to `ExecutionContext`', () => {
    expect(heritageResolver('WorkflowEntrypoint', 'ctx', ['Env'])).toBe('ExecutionContext');
  });

  it('substitutes a non-default type argument under the same contract', () => {
    expect(heritageResolver('WorkflowEntrypoint', 'env', ['MyBindings'])).toBe('MyBindings');
  });

  it('resolves the sibling worker base classes', () => {
    expect(heritageResolver('WorkerEntrypoint', 'env', ['Env'])).toBe('Env');
    expect(heritageResolver('Agent', 'env', ['Env'])).toBe('Env');
    expect(heritageResolver('DurableObject', 'state', ['Env'])).toBe('DurableObjectState');
  });

  it('substitutes the declared default (`Env = unknown`) when no type argument is carried', () => {
    expect(heritageResolver('WorkflowEntrypoint', 'env', [])).toBe('unknown');
  });

  it('substitutes a supplied argument even when the declaration has no default', () => {
    expect(heritageResolver('NoDefault', 'env', ['Env'])).toBe('Env');
  });

  it('abstains (null) for a type parameter with no argument and no default', () => {
    expect(heritageResolver('NoDefault', 'env', [])).toBeNull();
  });

  it('abstains (null) for an unknown base class — never a guess from a generic parameter', () => {
    expect(heritageResolver('SomeBase', 'env', ['Env'])).toBeNull();
  });

  it('abstains (null) for a known base class with no such field', () => {
    expect(heritageResolver('WorkflowEntrypoint', 'noSuchField', ['Env'])).toBeNull();
  });
});

describe('Spec 70 Q3 — makeHeritageResolver abstains without a declared `.d.ts`', () => {
  it('returns null with no project root', () => {
    expect(makeHeritageResolver(undefined, new Set(['@cloudflare/workers-types']))).toBeNull();
  });

  it('returns null with no declared type packages', () => {
    expect(makeHeritageResolver(projectRoot, undefined)).toBeNull();
  });

  it('returns null with an empty declared-package set', () => {
    expect(makeHeritageResolver(projectRoot, new Set())).toBeNull();
  });

  it('returns a resolver that abstains when no declared dependency ships the class', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'code-auditor-heritage-bare-'));
    try {
      const resolver = makeHeritageResolver(bare, new Set(['@cloudflare/workers-types']))!;
      expect(resolver).toBeTruthy();
      expect(resolver('WorkflowEntrypoint', 'env', ['Env'])).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('Spec 70 Q3 — classifyRootIdentifier heritage arm', () => {
  /** A resolution env carrying the interface field map plus the `D1Database`
   *  import the fixture declares (`import { D1Database } from
   *  '@cloudflare/workers-types'`), so the heritage arm's final `D1Database`
   *  classification resolves by origin rather than the ambient gate. */
  function envWithFields(
    interfaceFields: ReadonlyMap<string, ReadonlyMap<string, string>>,
    resolveHeritageField: HeritageFieldResolver | undefined,
  ): RootResolutionEnv {
    return {
      provenance: new Map<string, never>(),
      bindings: new Map<string, Binding>([
        ['D1Database', { kind: 'import', source: '@cloudflare/workers-types' }],
      ]),
      interfaceFields,
      resolveHeritageField,
      adapter: undefined,
      sourceCode: '',
    } as unknown as RootResolutionEnv;
  }

  // Built lazily inside `heritage` — `heritageResolver` is assigned in `beforeAll`,
  // which runs after the `describe` body executes, so a top-level `const` here
  // would capture `undefined`.
  function ifaceEnv(): RootResolutionEnv {
    return envWithFields(new Map([['Env', new Map([['DB', 'D1Database']])]]), heritageResolver);
  }

  function heritage(name: string, thisHeritage: string | null, memberPath: readonly string[] = ['DB']): string {
    return classifyRootIdentifier(name, ifaceEnv(), 0, { thisField: true, thisHeritage, memberPath });
  }

  it('resolves `this.env` (Env) through `Env.DB → D1Database` to `handle`', () => {
    expect(heritage('env', 'WorkflowEntrypoint<Env>')).toBe('handle');
  });

  it('resolves through a non-default type argument to `handle`', () => {
    const env = envWithFields(new Map([['MyBindings', new Map([['DB', 'D1Database']])]]), heritageResolver);
    expect(classifyRootIdentifier('env', env, 0, { thisField: true, thisHeritage: 'WorkflowEntrypoint<MyBindings>', memberPath: ['DB'] })).toBe('handle');
  });

  it('abstains (`unproven`) when there is no heritage contract', () => {
    // `thisHeritage` null — the class had no base class or an unknown one.
    expect(heritage('env', null)).toBe('unproven');
  });

  it('abstains (`unproven`) when no `resolveHeritageField` is threaded', () => {
    const env = envWithFields(new Map([['Env', new Map([['DB', 'D1Database']])]]), undefined);
    expect(classifyRootIdentifier('env', env, 0, { thisField: true, thisHeritage: 'WorkflowEntrypoint<Env>', memberPath: ['DB'] })).toBe('unproven');
  });

  it('abstains (`unproven`) when the resolver cannot resolve the base class', () => {
    expect(heritage('env', 'SomeBase<Env>')).toBe('unproven');
  });

  it('abstains (`unproven`) when the interface field is absent', () => {
    expect(heritage('env', 'WorkflowEntrypoint<Env>', ['missing'])).toBe('unproven');
  });

  it('heritage is authoritative before a same-named local binding (shadow, not the field)', () => {
    const env = envWithFields(new Map([['Env', new Map([['DB', 'D1Database']])]]), heritageResolver);
    const bindings = new Map<string, Binding>([
      ['D1Database', { kind: 'import', source: '@cloudflare/workers-types' }],
      ['env', { kind: 'variable', typeText: 'string' }],
    ]);
    const shadowed = { ...env, bindings } as RootResolutionEnv;
    // `env` is a `this.env` field: the local `string` variable is a shadow and must
    // not downgrade the heritage-resolved `Env` → handle.
    expect(classifyRootIdentifier('env', shadowed, 0, { thisField: true, thisHeritage: 'WorkflowEntrypoint<Env>', memberPath: ['DB'] })).toBe('handle');
  });
});

describe('Spec 70 Q3 — extraction seam threads thisHeritage', () => {
  // Literal SQL → an R3 (sql-argument) site; `thisHeritage` is still threaded.
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

  it('extractR3Sites threads thisHeritage: `WorkflowEntrypoint<Env>` for a literal `this.env.DB.prepare`', () => {
    run(literalSrc, (ast) => {
      const sites = extractR3Sites(ast, tsAdapter, literalSrc);
      const site = sites.find((s) => s.thisField);
      expect(site).toBeTruthy();
      expect(site!.thisHeritage).toBe('WorkflowEntrypoint<Env>');
    });
  });

  it('extractDataAccessCallCandidates threads handleThisHeritage and re-folds to handle on a dynamic-SQL site', () => {
    run(dynamicSrc, (ast) => {
      const candidates = extractDataAccessCallCandidates(ast, tsAdapter, dynamicSrc);
      const cand = candidates.find((c) => c.handleThisField);
      expect(cand, 'expected a this-rooted candidate').toBeTruthy();
      expect(cand!.handleThisHeritage).toBe('WorkflowEntrypoint<Env>');

      // Re-fold the provenance-dependent half exactly as the corpus producer's
      // member arm does (`reFoldHandleVerdict`), with the re-derived bindings +
      // interface fields + the declared-`.d.ts` heritage resolver. `sqlArg` is null
      // (dynamic SQL), so the sql-argument source abstains and heritage is the only
      // path to `handle`.
      const bindings = buildBindingEnv(ast, tsAdapter, dynamicSrc);
      const interfaceFields = extractInterfaceFields(ast, tsAdapter, dynamicSrc);
      const env = {
        provenance: new Map<string, never>(),
        bindings,
        interfaceFields,
        resolveHeritageField: heritageResolver,
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
          thisHeritage: cand!.handleThisHeritage,
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
