/**
 * Near-miss executor (Spec 44 — Rule Authenticity Audit, bucket 8).
 *
 * This is the falsification harness that makes every future rule change
 * testable: it runs every `nearMiss: true` sample declared in
 * {@link RULE_REGISTRY} through its **real analyzer** and asserts that the
 * sample produces zero findings for its own rule ID. A near-miss is a valid
 * input that is syntactically close to a violation but semantically not one; if
 * a rule is rewritten to match on shape instead of semantics, the near-miss
 * flips to a false positive and this test fails.
 *
 * Two kinds of sample exist in the registry:
 *
 *  1. **Self-contained single-file source** — the sample is a complete file
 *     (or the fragment a single file analysis needs) that the analyzer consumes
 *     directly through its in-process entry point. These are wired to a
 *     `Runner` below and executed for real.
 *
 *  2. **Multi-input / illustrative fragments** — the sample needs a second
 *     artifact the single string cannot supply (a cross-language schema pair, a
 *     seeded index corpus, a schema↔data file pair, a hook *called* inside a
 *     component, or a JSX/return fragment that `scanFile` won't detect as a
 *     component). Running these through the real analyzer with only the sample
 *     string would either fail to parse or trivially emit zero without
 *     exercising the guard — a dishonest near-miss check. These are classified
 *     below with the precise missing input, and are `it.skip`ped so the gap is
 *     visible and auditable rather than silently faked.
 *
 * The self-audit test at the bottom fails if any near-miss sample in the
 * registry is neither wired nor classified — the registry and this harness
 * cannot drift apart without a test failure.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RULE_REGISTRY } from '../analyzers/ruleRegistry.js';
import { initializeLanguages, initParsers, LanguageRegistry } from '../languages/index.js';
import { parseFile } from '../languages/adapterBridge.js';
import type { LanguageAdapter } from '../languages/types.js';
import { UniversalSOLIDAnalyzer, DEFAULT_SOLID_CONFIG } from '../analyzers/universal/UniversalSOLIDAnalyzer.js';
import { UniversalDRYAnalyzer, DEFAULT_DRY_CONFIG } from '../analyzers/universal/UniversalDRYAnalyzer.js';
import { UniversalDataAccessAnalyzer, DEFAULT_DATA_ACCESS_CONFIG } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { analyzeDocumentation } from '../analyzers/documentationAnalyzer.js';
import { UniversalSchemaAnalyzer, DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/UniversalSchemaAnalyzer.js';
import { scanFile } from '../componentScanner.js';
import { analyzeComponent, DEFAULT_REACT_CONFIG } from '../analyzers/reactAnalyzer.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tsAdapter: LanguageAdapter;
let solid: UniversalSOLIDAnalyzer;
let dry: UniversalDRYAnalyzer;
let dataAccess: UniversalDataAccessAnalyzer;
let schema: UniversalSchemaAnalyzer;
let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
  solid = new UniversalSOLIDAnalyzer();
  dry = new UniversalDRYAnalyzer();
  dataAccess = new UniversalDataAccessAnalyzer();
  schema = new UniversalSchemaAnalyzer();
  tmpDir = await mkdtemp(join(tmpdir(), 'ca-nearmiss-exec-'));
}, 30_000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

let seq = 0;
async function writeTemp(code: string, ext: string): Promise<string> {
  const p = join(tmpDir, `s${seq++}.${ext}`);
  await writeFile(p, code, 'utf-8');
  return p;
}

/** A runner executes one near-miss sample and returns the rule IDs it emitted. */
type Runner = (code: string, ruleId: string) => Promise<string[]>;

const ruleIds = (vs: { rule?: string }[]): string[] =>
  vs.map((v) => v.rule).filter((r): r is string => typeof r === 'string');

/** SOLID — single-file AST analysis. All seven near-misses are complete source. */
const runSolid: Runner = async (code) => {
  const ast = parseFile('solid-nearmiss.ts', code)!;
  if (!ast) throw new Error('failed to parse solid near-miss');
  const vs = await (solid as any).analyzeAST(ast, tsAdapter, DEFAULT_SOLID_CONFIG, code);
  return ruleIds(vs);
};

/** DRY — sub-rules (strings/imports/structural) are opt-in; enable them so the
 *  near-miss actually exercises each guard rather than tripping a disabled gate. */
const DRY_FULL_CONFIG = {
  ...DEFAULT_DRY_CONFIG,
  checkStrings: true,
  checkImports: true,
  checkStructuralSimilarity: true,
  checkExpressionSimilarity: true,
};
const runDry: Runner = async (code) => {
  const ast = parseFile('dry-nearmiss.ts', code)!;
  if (!ast) throw new Error('failed to parse dry near-miss');
  const vs = await (dry as any).analyzeAST(ast, tsAdapter, DRY_FULL_CONFIG, code);
  return ruleIds(vs);
};

/** Data-access — SQL injection / org-filter / query-shape guards. */
const runDataAccess: Runner = async (code) => {
  const ast = parseFile('data-access-nearmiss.ts', code)!;
  if (!ast) throw new Error('failed to parse data-access near-miss');
  const vs = await (dataAccess as any).analyzeAST(ast, tsAdapter, DEFAULT_DATA_ACCESS_CONFIG, code);
  return ruleIds(vs);
};

/** Documentation — full-file analysis over a written .ts file. */
const runDocumentation: Runner = async (code) => {
  const p = await writeTemp(code, 'ts');
  const result = await analyzeDocumentation([p], {});
  return ruleIds(result.violations);
};

/** Schema *code* path — sql-injection / table-naming / unknown-table over a .ts
 *  file, with a known-table catalog so `unknown-table` near-misses are checked
 *  against a real catalog rather than failing open on an empty one. */
const SCHEMA_CODE_CONFIG = {
  ...DEFAULT_SCHEMA_CONFIG,
  schemas: [
    {
      name: 'public',
      tables: [
        { name: 'users', columns: [] },
        { name: 'projects', columns: [] },
        { name: 'user_profiles', columns: [] },
        { name: 't', columns: [] },
      ],
    },
  ],
};
const runSchemaCode: Runner = async (code) => {
  const p = await writeTemp(code, 'ts');
  const result = await schema.analyze([p], SCHEMA_CODE_CONFIG);
  return ruleIds(result.violations);
};

/** React — per-component rules whose near-miss is a complete component the
 *  scanner detects. Fragment near-misses (JSX/return) are classified below. */
const runReactComponent: Runner = async (code) => {
  const p = await writeTemp(code, 'tsx');
  const scan = await scanFile(p);
  const component = scan.components.find((c) => c.name !== 'AnonymousComponent');
  if (!component) return [];
  return ruleIds(analyzeComponent(component, DEFAULT_REACT_CONFIG, scan));
};

/** React `accessibility` — the near-miss is a bare JSX element (`<img alt=…>`);
 *  wrap it in a functional component so `scanFile` detects it and
 *  `checkAccessibility` runs `hasImgWithoutAlt` against real source. */
const runReactAccessibility: Runner = async (code) => {
  const wrapped = `function Img() {\n  return ${code};\n}`;
  const p = await writeTemp(wrapped, 'tsx');
  const scan = await scanFile(p);
  const component = scan.components.find((c) => c.name !== 'AnonymousComponent');
  if (!component) return [];
  return ruleIds(analyzeComponent(component, DEFAULT_REACT_CONFIG, scan));
};

/**
 * Wired runners, keyed by rule ID. Only rules whose near-miss is a
 * self-contained single-file input appear here.
 */
const RUNNERS: Record<string, Runner> = {
  // solid
  'solid/class-size': runSolid,
  'solid/method-complexity': runSolid,
  'solid/open-closed': runSolid,
  'solid/single-responsibility': runSolid,
  'function-length': runSolid,
  'parameter-count': runSolid,
  'solid/interface-segregation': runSolid,
  'solid/liskov-substitution': runSolid,
  'solid/dependency-inversion': runSolid,
  // dry
  'dry/duplicate': runDry,
  'dry/structural-similarity': runDry,
  'dry/similar-expression': runDry,
  'duplicate-string-literal': runDry,
  'duplicate-import': runDry,
  // data-access
  'sql-injection-risk': runDataAccess,
  'missing-org-filter': runDataAccess,
  'complex-query': runDataAccess,
  'unfiltered-query': runDataAccess,
  'hardcoded-connection': runDataAccess,
  'loop-query': runDataAccess,
  // documentation
  'file-documentation': runDocumentation,
  'function-documentation': runDocumentation,
  'parameter-documentation': runDocumentation,
  'return-documentation': runDocumentation,
  'class-documentation': runDocumentation,
  'method-documentation': runDocumentation,
  // schema — code path only (JSON path classified below)
  'sql-injection': runSchemaCode,
  'table-naming-convention': runSchemaCode,
  'unknown-table': runSchemaCode,
  // react — the per-component near-misses that are a complete component, plus
  // `accessibility` whose bare-JSX near-miss is wrapped into one.
  complexity: runReactComponent,
  accessibility: runReactAccessibility,
};

/**
 * Rules whose near-miss sample cannot be run through its analyzer with only the
 * sample string. Each reason names the missing input. These stay skipped rather
 * than faked; wiring any of them is a follow-up that builds the missing harness.
 */
const SKIP_RULES: Record<string, string> = {
  // schema JSON path — the samples are data *instances* (or bare schema
  // fragments) validated against a separate schema file; the analyzer pairs
  // them via schemaDataPairs / filename matching (`*.schema.json` ↔ `*.data.json`).
  'invalid-json': 'schema JSON — sample is a data/schema fragment needing a schema↔data file pair',
  'missing-schema-declaration': 'schema JSON — needs a `*.schema.json` file + jsonSchemaVersion config',
  'undefined-required-field': 'schema JSON — needs a full object schema with `required`',
  'invalid-type': 'schema JSON — needs a schema file exercising `type` validation',
  'invalid-range': 'schema JSON — needs an integer/number schema with minimum/maximum',
  'file-error': 'schema JSON — needs a schema file that errors during read',
  'type-mismatch': 'schema JSON — needs a schema↔data pair for `{"age":30}`',
  'string-too-short': 'schema JSON — needs a string schema with minLength',
  'string-too-long': 'schema JSON — needs a string schema with maxLength',
  'pattern-mismatch': 'schema JSON — needs a string schema with pattern',
  'invalid-format': 'schema JSON — needs a string schema with format',
  'below-minimum': 'schema JSON — needs a number schema with minimum',
  'above-maximum': 'schema JSON — needs a number schema with maximum',
  'too-few-items': 'schema JSON — needs an array schema with minItems',
  'too-many-items': 'schema JSON — needs an array schema with maxItems',
  'missing-required-field': 'schema JSON — needs an object schema with required fields',
  'unexpected-property': 'schema JSON — needs an object schema with additionalProperties:false',
  'enum-mismatch': 'schema JSON — needs an enum schema',
  // react — fragment/non-component near-misses that scanFile won't surface as a
  // standalone component; each names the specific shape it needs.
  'hooks-naming': 'react — sample is a hook *definition* (`useFetch`), not a hook called inside a scannable component',
  'missing-props': 'react — `hasPropsValidation` treats destructured params as validation, so the near-miss (propTypes) and invalid (none) are indistinguishable; needs a non-destructured-prop fixture',
  'no-error-boundary': 'react — sample is a JSX fragment (`<ErrorBoundary><App/></ErrorBoundary>`) needing a multi-file scan tree',
  performance: 'react — sample is a `memo(...)` statement needing requireMemoization config + a detected memo component',
  'raw-element': 'react — sample is a `return <Button …>` fragment needing a wrapper-component scan to classify `Button` as non-raw',
};

/** Analyzers whose near-miss samples are all cross-file/pair/index inputs. */
const SKIP_ANALYZERS: Record<string, string> = {
  'schema-validator': 'schema-validator — near-misses are single Prisma/SQL/TS snippets; validateSchemas requires ≥2 same-name schemas in ≥2 languages',
  'api-contract': 'api-contract — near-misses need an endpoint definition paired with its response/call site',
  'dependency-graph': 'dependency-graph — near-misses need an entity/import graph built from multiple files',
  styles: 'styles — near-misses need a seeded CSS corpus (value drift, z-index distribution) in the DB',
  conventions: 'conventions — near-misses need a populated function-usage index (usage pairs, import forms)',
  'cross-domain': 'cross-domain — near-misses need schema_usage + function facts across files',
  invariants: 'invariants — config-error/engine-error are about the invariant rule engine loading a config, not a source snippet',
};

/** Collect every near-miss sample, tagged with its rule ID and analyzer. */
interface NearMissCase {
  ruleId: string;
  analyzer: string;
  code: string;
}

function allNearMisses(): NearMissCase[] {
  const out: NearMissCase[] = [];
  for (const [ruleId, entry] of Object.entries(RULE_REGISTRY)) {
    for (const sample of entry.samples.valid) {
      if (sample.nearMiss) {
        out.push({ ruleId, analyzer: entry.analyzer, code: sample.code });
      }
    }
  }
  return out;
}

describe('near-miss executor — every declared near-miss runs through its real analyzer', () => {
  const cases = allNearMisses();

  for (const c of cases) {
    const runner = RUNNERS[c.ruleId];
    const skipReason = SKIP_RULES[c.ruleId] ?? SKIP_ANALYZERS[c.analyzer];

    if (runner) {
      it(`${c.ruleId} near-miss produces zero findings`, async () => {
        const emitted = await runner(c.code, c.ruleId);
        expect(
          emitted,
          `near-miss for ${c.ruleId} was flagged: ${JSON.stringify(emitted)}`
        ).not.toContain(c.ruleId);
      });
    } else if (skipReason) {
      it.skip(`${c.ruleId} near-miss [SKIPPED: ${skipReason}]`, () => {});
    } else {
      // Covered by the self-audit below, but fail loudly here too.
      it(`${c.ruleId} near-miss [UNWIRED — no runner and no skip reason]`, () => {
        throw new Error(`near-miss for ${c.ruleId} is neither wired nor classified`);
      });
    }
  }

  it('accounts for every near-miss sample (wired ∪ classified)', () => {
    const cases = allNearMisses();
    const unwired = cases.filter(
      (c) => !RUNNERS[c.ruleId] && !SKIP_RULES[c.ruleId] && !SKIP_ANALYZERS[c.analyzer]
    );
    expect(unwired).toEqual([]);
    // And the registry itself must still declare near-misses — a silent empty
    // registry would trivially pass the loop above.
    expect(cases.length).toBeGreaterThan(0);
  });
});
