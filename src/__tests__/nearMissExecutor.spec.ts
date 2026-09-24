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
import { UniversalSecretsAnalyzer, DEFAULT_SECRETS_CONFIG } from '../analyzers/universal/UniversalSecretsAnalyzer.js';
import { UniversalSecurityAnalyzer, DEFAULT_SECURITY_CONFIG } from '../analyzers/universal/UniversalSecurityAnalyzer.js';
import { UniversalDocumentationAnalyzer, DEFAULT_DOCUMENTATION_CONFIG } from '../analyzers/universal/UniversalDocumentationAnalyzer.js';
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
let secrets: UniversalSecretsAnalyzer;
let security: UniversalSecurityAnalyzer;
let schema: UniversalSchemaAnalyzer;
let docAnalyzer: UniversalDocumentationAnalyzer;
let tmpDir: string;

beforeAll(async () => {
  initializeLanguages();
  await initParsers();
  tsAdapter = LanguageRegistry.getInstance().getAdapterForFile('test.ts')!;
  if (!tsAdapter) throw new Error('TypeScript adapter not registered');
  solid = new UniversalSOLIDAnalyzer();
  dry = new UniversalDRYAnalyzer();
  dataAccess = new UniversalDataAccessAnalyzer();
  secrets = new UniversalSecretsAnalyzer();
  security = new UniversalSecurityAnalyzer();
  schema = new UniversalSchemaAnalyzer();
  docAnalyzer = new UniversalDocumentationAnalyzer();
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

/** Secrets — hardcoded-secret guard. Placeholder/env-var near-misses are
 *  self-contained single-file source (the test-fixture near-miss needs a
 *  test-file path and is exercised in UniversalSecretsAnalyzer.spec.ts). */
const runSecrets: Runner = async (code) => {
  const ast = parseFile('secrets-nearmiss.ts', code)!;
  if (!ast) throw new Error('failed to parse secrets near-miss');
  const vs = await (secrets as any).analyzeAST(ast, tsAdapter, DEFAULT_SECRETS_CONFIG, code);
  return ruleIds(vs);
};

/** Security — command-injection / dynamic-require / unescaped-HTML guards. */
const runSecurity: Runner = async (code) => {
  const ast = parseFile('security-nearmiss.ts', code)!;
  if (!ast) throw new Error('failed to parse security near-miss');
  const vs = await (security as any).analyzeAST(ast, tsAdapter, DEFAULT_SECURITY_CONFIG, code);
  return ruleIds(vs);
};

/** Documentation — the pipeline emits documentation rules from the
 *  UniversalDocumentationAnalyzer (Spec 17 R1), NOT the legacy
 *  `analyzeDocumentation`. A runner wired to the legacy analyzer reports
 *  near-misses against a surface that no longer emits `method-documentation` /
 *  `class-documentation` (the missing-org-filter shape). Sub-rules that are
 *  opt-in by default (param/return tags) are enabled here so their guards are
 *  actually exercised, like DRY_FULL_CONFIG does for the DRY sub-rules. */
const DOC_FULL_CONFIG = {
  ...DEFAULT_DOCUMENTATION_CONFIG,
  requireParamDocs: true,
  requireReturnDocs: true,
  scope: 'all' as const,      // samples are unexported fragments, not public API
  docsMinLines: 0,            // samples are short; the size gate would skip them
  fileHeaders: true,          // file-documentation is off by default (R1.5)
};
const runDocumentation: Runner = async (code) => {
  const ast = parseFile('doc-nearmiss.ts', code)!;
  if (!ast) throw new Error('failed to parse doc near-miss');
  const vs = await (docAnalyzer as any).analyzeAST(ast, tsAdapter, DOC_FULL_CONFIG, code);
  return ruleIds(vs);
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
 *  `checkAccessibility` reads its AST-derived `jsxElementDetails`. */
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
  'interface-size': runSolid,
  'solid/liskov-substitution': runSolid,
  'solid/dependency-inversion': runSolid,
  // dry
  // dry/diverging-clone is cross-run (dry_pair_history) — classified in SKIP_RULES below.
  'dry/duplicate': runDry,
  'dry/structural-similarity': runDry,
  'dry/similar-expression': runDry,
  'duplicate-string-literal': runDry,
  'duplicate-import': runDry,
  // data-access
  'sql-injection-risk': runDataAccess,
  // `missing-org-filter` was moved to the Stage-4 derived reducer (Spec 62
  // Amendment B); the per-file analyzer `runDataAccess` no longer emits it, so
  // wiring it here would be a vacuous "no finding" assertion. It is classified
  // in SKIP_RULES instead, pointing at the real end-to-end guard test.
  'complex-query': runDataAccess,
  'unfiltered-query': runDataAccess,
  'hardcoded-connection': runDataAccess,
  'loop-query': runDataAccess,
  // secrets
  'hardcoded-secret': runSecrets,
  // security (Spec 61 R6)
  'command-injection-risk': runSecurity,
  'dynamic-require-of-project-path': runSecurity,
  'unescaped-html-interpolation': runSecurity,
  // documentation
  'file-documentation': runDocumentation,
  'function-documentation': runDocumentation,
  'parameter-documentation': runDocumentation,
  'return-documentation': runDocumentation,
  'class-documentation': runDocumentation,
  'method-documentation': runDocumentation,
  // schema — code path only (JSON path classified below)
  'dynamic-sql-construction': runSchemaCode,
  'table-naming-convention': runSchemaCode,
  'unknown-table': runSchemaCode,
  'too-many-queries': runSchemaCode,
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
  // dry — diverging-clone is emitted by auditRunner's cross-run pass over the
  // dry_pair_history table (≥2 runs of declining similarity), not the per-file
  // AST visitor; a single source string can't seed that history.
  'dry/diverging-clone': 'dry — needs a seeded dry_pair_history across ≥2 consecutive runs; cross-run pass, not single-file AST',
  // data-access — missing-org-filter is emitted by the Stage-4 derived reducer
  // (Spec 62 Amendment B), not the per-file analyzer; `runDataAccess` no longer
  // emits it, so a single snippet cannot exercise the guard here. The near-miss
  // (org_id predicate present → no fire) and the true-positive (no org_id → fire)
  // are exercised end-to-end in integration/fixture-data-access-rules.test.ts.
  'missing-org-filter': 'data-access — emitted by the Stage-4 reducer, not the per-file analyzer; near-miss guard exercised in integration/fixture-data-access-rules.test.ts',
  // schema JSON path — the samples are data *instances* (or bare schema
  // fragments) validated against a separate schema file; the analyzer pairs
  // them via schemaDataPairs / filename matching (`*.schema.json` ↔ `*.data.json`).
  'invalid-json': 'schema JSON — sample is a data/schema fragment needing a schema↔data file pair',
  'missing-schema-declaration': 'schema JSON — needs a `*.schema.json` file + jsonSchemaVersion config',
  'undefined-required-field': 'schema JSON — needs a full object schema with `required`',
  'invalid-type': 'schema JSON — needs a schema file exercising `type` validation',
  'invalid-range': 'schema JSON — needs an integer/number schema with minimum/maximum',
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
  // schema reducer — a dropped-table finding needs a migration that drops the
  // table plus a code file referencing it; the catalog is built cross-file in
  // the Stage 3 reducer, not from a single snippet.
  'stale-table-reference': 'schema — needs a migration (CREATE then DROP) plus a code reference to the dropped table',
  // react — fragment/non-component near-misses that scanFile won't surface as a
  // standalone component; each names the specific shape it needs.
  'hooks-naming': 'react — sample is a hook *definition* (`useFetch`), not a hook called inside a scannable component',
  'missing-props': 'react — `hasPropsValidation` treats destructured params as validation, so the near-miss (propTypes) and invalid (none) are indistinguishable; needs a non-destructured-prop fixture',
  'no-error-boundary': 'react — sample is a JSX fragment (`<ErrorBoundary><App/></ErrorBoundary>`) needing a multi-file scan tree',
  // Go rules — near-misses are Go snippets exercised through the real Go
  // analyzer binary (the same boundary the production pipeline uses), not the
  // TS single-file runner here.
  'switch-size': 'Go — near-miss exercised in goSwitchSize.spec.ts via the Go analyzer binary',
  'function-size': 'Go — near-miss exercised in goSingleResponsibilitySplit.spec.ts via the Go analyzer binary',
  'struct-size': 'Go — near-miss exercised in goSingleResponsibilitySplit.spec.ts via the Go analyzer binary',
  'liskov-substitution': 'Go — near-miss exercised in goDishonestRules.spec.ts via the Go analyzer binary',
  'channel-deadlock': 'Go — near-miss exercised in goChannelDeadlock.spec.ts via the Go analyzer binary',
  'error-handling': 'Go — near-miss exercised in goDishonestRules.spec.ts via the Go analyzer binary',
  'concurrency': 'Go — near-miss exercised in goDishonestRules.spec.ts via the Go analyzer binary',
  'import-organization': 'Go — near-miss exercised in goImportOrganization.spec.ts via the Go analyzer binary',
  'import-style': 'Go — near-miss exercised in goImportOrganization.spec.ts via the Go analyzer binary',
  performance: 'react — sample is a `memo(...)` statement needing requireMemoization config + a detected memo component',
  'raw-element': 'react — sample is a `return <Button …>` fragment needing a wrapper-component scan to classify `Button` as non-raw',
};

/** Analyzers whose near-miss samples are all cross-file/pair/index inputs. */
const SKIP_ANALYZERS: Record<string, string> = {
  'schema-validator': 'schema-validator — near-misses are single Prisma/SQL/TS snippets; validateSchemas requires ≥2 same-name schemas in ≥2 languages',
  'dependency-graph': 'dependency-graph — near-misses need an entity/import graph built from multiple files',
  styles: 'styles — near-misses need a seeded CSS corpus (value drift, z-index distribution) in the DB',
  conventions: 'conventions — near-misses need a populated function-usage index (usage pairs, import forms)',
  'cross-domain': 'cross-domain — near-misses need schema_usage + function facts across files',
  invariants: 'invariants — config-error/engine-error are about the invariant rule engine loading a config, not a source snippet',
};

/**
 * Liveness pointers — for every rule whose **invalid** (true-positive) sample
 * cannot run through a single-file `RUNNERS` entry, this names where that true
 * positive IS exercised (the test that asserts the rule actually fires), or
 * records the rule as `UNCOVERED` (emitted but no test asserts it fires) or
 * `CANNOT-FIRE` (structurally unreachable — see `CANNOT_FIRE_RULES` in
 * applicability.ts).
 *
 * The self-audit at the bottom of the liveness block fails if a rule skipped
 * there has no entry here, so a rule cannot drift into the skip block with a
 * silent, unverified "no runner" and lose its true-positive trace without a test
 * failure. This is the symmetric twin of the near-miss self-audit above:
 * wired ∪ pointed, never silently skipped.
 */
const LIVENESS_POINTERS: Record<string, string> = {
  // ── Go (10) — true positive asserted through the Go analyzer binary. ──────
  //   Nine are pointer-covered here; `interface-size` (the 10th Go rule) is
  //   wired via `runSolid` above because its registry entry carries TS samples —
  //   its *Go* emission is asserted in goDependencyInversionBlock.spec.ts and
  //   goRegistryIds.spec.ts. The old "Go (9)" under-counted: the Go subprocess
  //   emits five solid rules (function/struct/switch-size, liskov-substitution,
  //   interface-size) + five `go` rules = ten.
  'switch-size': 'goSwitchSize.spec.ts — flags a large switch/type-switch under switch-size',
  'function-size': 'goSingleResponsibilitySplit.spec.ts — flags a big function under function-size',
  'struct-size': 'goSingleResponsibilitySplit.spec.ts — flags a 16-field struct under struct-size',
  'liskov-substitution': 'goDishonestRules.spec.ts — flags a method that calls panic() under an innocent name',
  'channel-deadlock': 'goChannelDeadlock.spec.ts — flags an unbuffered send+receive with no goroutine',
  'error-handling': 'goDishonestRules.spec.ts — flags an innocently-named function that drops an assigned error',
  'concurrency': 'goDishonestRules.spec.ts — flags an innocently-named function that launches a goroutine without sync',
  'import-organization': 'goImportOrganization.spec.ts — flags mis-grouped imports (positive)',
  'import-style': 'goImportOrganization.spec.ts — flags dot imports',

  // ── dry (1) ────────────────────────────────────────────────────────────────
  'dry/diverging-clone': 'UNCOVERED — cross-run (dry_pair_history) pass; no test seeds ≥2 declining-similarity runs',

  // ── data-access (1) ────────────────────────────────────────────────────────
  'missing-org-filter': 'integration/fixture-data-access-rules.test.ts — true positive fires (line 12), near-misses stay quiet',

  // ── schema JSON path (17) — data instances validated against a schema↔data
  //    pair; only invalid-format has a real harness.
  'invalid-format': 'schema/jsonSchema.spec.ts — invalid email/date fire through analyzeJsonSchemas',
  'invalid-json': 'UNCOVERED — no schema↔data harness asserts it fires',
  'missing-schema-declaration': 'UNCOVERED — no schema↔data harness asserts it fires',
  'undefined-required-field': 'UNCOVERED — no schema↔data harness asserts it fires',
  'invalid-type': 'UNCOVERED — no schema↔data harness asserts it fires',
  'invalid-range': 'UNCOVERED — no schema↔data harness asserts it fires',
  'type-mismatch': 'UNCOVERED — no schema↔data harness asserts it fires',
  'string-too-short': 'UNCOVERED — no schema↔data harness asserts it fires',
  'string-too-long': 'UNCOVERED — no schema↔data harness asserts it fires',
  'pattern-mismatch': 'UNCOVERED — no schema↔data harness asserts it fires',
  'below-minimum': 'UNCOVERED — no schema↔data harness asserts it fires',
  'above-maximum': 'UNCOVERED — no schema↔data harness asserts it fires',
  'too-few-items': 'UNCOVERED — no schema↔data harness asserts it fires',
  'too-many-items': 'UNCOVERED — no schema↔data harness asserts it fires',
  'missing-required-field': 'UNCOVERED — no schema↔data harness asserts it fires',
  'unexpected-property': 'UNCOVERED — no schema↔data harness asserts it fires',
  'enum-mismatch': 'UNCOVERED — no schema↔data harness asserts it fires',

  // ── schema reducer (1) ─────────────────────────────────────────────────────
  'stale-table-reference': 'dbWrapperEndToEnd.spec.ts — migration-drop surfaces as stale-table-reference',

  // ── react (5) ──────────────────────────────────────────────────────────────
  'no-error-boundary': 'reactErrorBoundary.spec.ts — flags a boundary-less app (app-level, Spec 55 R4)',
  'performance': 'reactAnalyzer.spec.ts — flags an inline arrow prop (true positive)',
  'raw-element': 'nearMissGuards.spec.ts — flags real <button> JSX, not createElement(Button)',
  'hooks-naming': 'UNCOVERED — emitted by reactAnalyzer (hooks-naming) but no test asserts it fires',
  'missing-props': 'UNCOVERED — emitted by reactAnalyzer (missing-props) but no test asserts it fires',

  // ── schema-validator (3) ───────────────────────────────────────────────────
  'schema-field-mismatch': 'cross-language/fieldMismatch.spec.ts — genuine primitive mismatch fires',
  'missing-field': 'cross-language/missingField.spec.ts — required value-type field absent fires',
  'extra-field': 'cross-language/SchemaValidator.spec.ts — extra field fires',

  // ── dependency-graph (9) ───────────────────────────────────────────────────
  'circular-dependency': 'DependencyGraphBuilder.spec.ts — renders a 2-cycle path',
  'tight-coupling': 'DependencyGraphBuilder.spec.ts — flags a 3-node mutually-calling cluster',
  'hub-nodes': 'DependencyGraphBuilder.spec.ts — flags a 12-out-degree hub',
  'orphaned-nodes': 'DependencyGraphBuilder.spec.ts + pipelineAdapters.reachability.spec.ts — flags a private unreferenced node',
  'unreferenced-module': 'pipelineAdapters.reachability.spec.ts — flags an exported-but-unimported file',
  'break-cycles': 'UNCOVERED — emitted as advisory suggestionType, not a gating violation; no test asserts it',
  'reduce-coupling': 'UNCOVERED — emitted as advisory suggestionType, not a gating violation; no test asserts it',
  'split-responsibilities': 'UNCOVERED — emitted as advisory suggestionType, not a gating violation; no test asserts it',
  'review-orphans': 'UNCOVERED — emitted as advisory suggestionType, not a gating violation; no test asserts it',

  // ── styles (9) ─────────────────────────────────────────────────────────────
  'styles/value-drift': 'UniversalStylesAnalyzer.spec.ts — Detector 1 flags a rare color among a dominant cluster',
  'styles/off-scale': 'UniversalStylesAnalyzer.spec.ts — Detector 2 flags a value off the declared scale',
  'styles/undefined-class': 'UniversalStylesAnalyzer.spec.ts — Detector 3 flags a near-miss typo class',
  'styles/token-bypass': 'UniversalStylesAnalyzer.spec.ts — Detector 4 flags a raw value matching a token',
  'styles/mechanism-fragmentation': 'UniversalStylesAnalyzer.spec.ts — Detector 5 flags same (property,value) via ≥3 mechanisms',
  'styles/mechanism-mixing': 'UniversalStylesAnalyzer.spec.ts — Detector 5 (part B) flags a file mixing ≥3 mechanisms',
  'styles/declaration-set-similarity': 'UniversalStylesAnalyzer.spec.ts — Detector 6 flags ≥threshold Jaccard similarity',
  'styles/z-index-sprawl': 'UniversalStylesAnalyzer.spec.ts — Detector 7 flags distinct z-index values exceeding max',
  'styles/z-index-singleton': 'UniversalStylesAnalyzer.spec.ts — Detector 7 flags a singleton z-index value',

  // ── conventions (5) ────────────────────────────────────────────────────────
  'conventions/export-shape': 'integration/fixture-conventions.test.ts — default export in named-majority dir fires',
  'conventions/naming': 'integration/fixture-conventions.test.ts — PascalCase in camelCase dir fires',
  'conventions/usage-pair': 'UNCOVERED — emitted by UniversalConventionsAnalyzer; no test asserts it fires',
  'conventions/import-form': 'UNCOVERED — emitted by UniversalConventionsAnalyzer; no test asserts it fires',
  'conventions/error-handling': 'UNCOVERED — emitted by UniversalConventionsAnalyzer; no test asserts it fires',

  // ── cross-domain (5) ───────────────────────────────────────────────────────
  'cross-domain/written-never-read': 'CrossDomainAnalyzer.test.ts — flags a table inserted but never selected',
  'cross-domain/read-never-written': 'CrossDomainAnalyzer.test.ts — flags a table selected but never written',
  'cross-domain/multi-table-write': 'CrossDomainAnalyzer.test.ts — flags a function writing ≥threshold tables',
  'cross-domain/no-validator-reachable': 'CrossDomainAnalyzer.test.ts — flags a writer with no path to a validator',
  'cross-domain/uncovered-risk': 'UNCOVERED — emitted by CrossDomainAnalyzer; no test asserts it fires',
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

/** Collect every invalid (true-positive) sample, tagged with rule + analyzer. */
function allInvalidSamples(): NearMissCase[] {
  const out: NearMissCase[] = [];
  for (const [ruleId, entry] of Object.entries(RULE_REGISTRY)) {
    for (const sample of entry.samples.invalid ?? []) {
      out.push({ ruleId, analyzer: entry.analyzer, code: sample.code });
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

  // Spec 58 follow-up — `unresolved-query` is no longer a violation rule, so its
  // near-miss (a literal SQL string) has nothing to falsify. The guard that used
  // to live here is replaced by a diagnostic-emission assertion: the SAME
  // unresolvable sample that used to produce a finding must now produce a
  // `unresolved-query` coverage diagnostic (file + line) and ZERO violations —
  // same test, different channel. This is what keeps the reclassification honest:
  // dropping the registry entry must not also drop the only guard on the
  // unresolved-SQL detection path.
  it('unresolved-query: unresolvable SQL emits a coverage diagnostic, not a violation', async () => {
    const p = await writeTemp('import { UPSERT_SQL } from "./queries";\ndb.prepare(UPSERT_SQL)', 'ts');
    const result = await schema.analyze([p], SCHEMA_CODE_CONFIG);

    // No finding — the rule is gone from the violation channel.
    expect(ruleIds(result.violations)).not.toContain('unresolved-query');

    // The diagnostic fires on the new channel, with file + line.
    const diags = (result.diagnostics ?? []).filter((d) => d.kind === 'unresolved-query');
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].file).toBe(p);
    expect(typeof diags[0].line).toBe('number');
  });
});

describe('near-miss executor — liveness: every wired rule actually emits (Spec 62 sixth dead gate)', () => {
  // A near-miss "produces zero findings" is only meaningful if the rule actually
  // fires on its true-positive sample through the SAME runner. When a rule's
  // emission moved (e.g. missing-org-filter → the Stage-4 reducer), the per-file
  // runner keeps returning [] and the near-miss test passes vacuously — a clean
  // result from a rule that isn't there. This block makes that an error: a wired
  // rule whose invalid sample does NOT fire fails here, so vacuous coverage
  // cannot slip through as a pass.
  for (const c of allInvalidSamples()) {
    const runner = RUNNERS[c.ruleId];
    if (!runner) {
      // A rule without a single-file runner must carry a LIVENESS_POINTER naming
      // the test that DOES exercise its true positive — or recording it as
      // `UNCOVERED` / `CANNOT-FIRE`. The pointer is the skip reason, so the skip
      // is no longer silent: it names where the rule's liveness is (or isn't)
      // proven. If a rule has no runner AND no pointer, the `it` below fails.
      const pointer = LIVENESS_POINTERS[c.ruleId];
      if (pointer) {
        it.skip(`${c.ruleId} invalid sample [liveness: ${pointer}]`, () => {});
      } else {
        it(`${c.ruleId} invalid sample [UNWIRED — no runner and no liveness pointer]`, () => {
          throw new Error(
            `invalid sample for ${c.ruleId} is neither wired nor classified — add a runner or a LIVENESS_POINTERS entry`
          );
        });
      }
      continue;
    }
    it(`${c.ruleId} invalid sample fires through its wired runner`, async () => {
      const emitted = await runner(c.code, c.ruleId);
      expect(
        emitted,
        `${c.ruleId} invalid sample did not fire — the wired runner reads a surface that no longer emits this rule (vacuous near-miss coverage)`
      ).toContain(c.ruleId);
    });
  }

  // Self-audit — the transitive guarantee, re-asserted for liveness. Every rule
  // whose invalid sample is NOT wired must be pointed at (a covering test, or
  // explicitly UNCOVERED / CANNOT-FIRE). The same reasoning that caught the
  // near-miss asymmetry applies here: a rule drifting into the skip block with
  // no pointer silently drops its true-positive trace, and this project's whole
  // history is transitive guarantees that stopped holding.
  it('accounts for every invalid sample (wired ∪ pointed)', () => {
    const cases = allInvalidSamples();
    const unpointed = cases.filter(
      (c) => !RUNNERS[c.ruleId] && !LIVENESS_POINTERS[c.ruleId]
    );
    expect(unpointed).toEqual([]);
    // The registry itself must still declare invalid samples — a silent empty
    // registry would trivially pass the loop above.
    expect(cases.length).toBeGreaterThan(0);
  });
});
