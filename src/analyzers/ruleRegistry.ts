import type { Resolution } from '../types.js';

/**
 * Rule Registry — canonical mapping of every emitted rule/violation-type ID
 * to its emitting analyzer and its consumer-facing contract.
 *
 * This is the ONE place that asserts "each rule ID has exactly one emitter."
 * If you add a new emitted ID to an analyzer, add it here. The enforcement
 * test (`registry enforces one emitter per rule ID`) fails the suite on
 * duplicate entries — preventing the `severityOverrides` collision class
 * where two analyzers emit the same string.
 *
 * Rider 2, Spec 19: the `type-mismatch` duplicate between
 * UniversalSchemaAnalyzer (rule) and SchemaValidator (violationType) was
 * discovered during ground-truth enumeration. SchemaValidator's copy was
 * renamed to `schema-field-mismatch`.
 *
 * NOTE: `contractType` is NOT in the buildFingerprintInput rule-ID chain.
 * APIContractAnalyzer violations currently resolve rule='' in fingerprints.
 * They are listed here for collision detection nonetheless, because
 * severityOverrides may use a different resolution path.
 *
 * NOTE: invariants analyzer rule IDs are user-defined and variable —
 * `config-error` and `engine-error` are the only fixed, internal ones.
 *
 * Spec 37 R2: every entry carries `resolvable`, `message`, `docs`, and
 * `thresholds`. Missing any field is a build failure (the interface makes
 * them required; the registry test re-asserts the contract at runtime).
 *
 * Spec 45 R1: there is no per-rule `gating` opt-in. Every registered rule
 * participates in the blocking gate; whether a finding blocks is decided by
 * severity (R2) at the gate, not by a flag on the rule.
 */

export interface RuleRegistryEntry {
  /** The analyzer that emits this rule ID. */
  analyzer: string;
  /** The field on the Violation object that holds this ID. */
  field: 'rule' | 'principle' | 'violationType' | 'type' | 'contractType' | 'ruleId' | 'special';
  /**
   * Optional dot-separated path to a config boolean within the analyzer's namespace.
   * When the config value is `false`, the rule is `notApplicable` (explicitly disabled).
   *
   * Example: `checkStructuralSimilarity` → looked up as config.config.dry.checkStructuralSimilarity.
   * The path is relative to the analyzer namespace (config.config[analyzer]).
   */
  configGate?: string;
  /**
   * Spec 33 Item 14 — the input sources this rule consumes, used to promote a
   * zero-violation rule from `unassessed` to `clean` (≥1 input present) or
   * `notApplicable` (all inputs absent). Each entry is one of:
   *   - `'files'` — the analyzer ran on ≥1 parsed source file (always present at
   *     the zero-violation branch, since earlier checks already excluded the
   *     empty-input cases);
   *   - a fact-key — a visitor/reducer name (e.g. `'schema-json'`, `'function-index'`)
   *     whose per-file facts were non-empty this run;
   *   - an index table — a table name (e.g. `'schema_usage'`, `'functions'`) that
   *     held ≥1 row at coverage-build time.
   *
   * Omitted for non-pipeline analyzers (schema-validator, api-contract,
   * dependency-graph), whose rules stay `unassessed`.
   */
  input?: string[];
  /**
   * Spec 37 R1 — whether this rule can produce a `resolution` (a specific next
   * action naming concrete symbols/files/lines) for every occurrence it emits.
   * A `resolvable` rule that emits without a resolution still gates (Spec 45
   * R1); the missing action is recorded as a gap, not grounds to skip
   * enforcement.
   */
  resolvable: boolean;
  /**
   * Spec 37 R2 — the rule's message as a template, not a string built at the
   * emit site. One place per rule where wording lives. Placeholders use
   * `{snake_case}` for concrete symbols the emit site substitutes.
   */
  message: string;
  /**
   * Spec 37 R2 — a stable identifier for the rule's explanation. Not a URL the
   * agent must fetch (guidance travels inline per R1); this is for humans
   * reading reports. The rule ID itself is the canonical slug.
   */
  docs: string;
  /**
   * Spec 37 R2 — the config keys (dot-separated paths within the analyzer's
   * namespace) that tune this rule, so Spec 36 R5's threshold reporting can
   * name them and Spec 38 R1's `--print-config` can resolve them. Empty for
   * rules with no tunable threshold.
   */
  thresholds: string[];
  /**
   * Spec 37 R3 — inline valid/invalid samples for this rule. At least one
   * valid sample must be a near-miss (syntactically close to an invalid case
   * but semantically different). Invalid samples on a resolvable rule must
   * assert the expected `resolution`.
   */
  samples: RuleSamples;
}

/**
 * A single valid or invalid sample for a rule (Spec 37 R3).
 *
 * `valid` samples are cases the rule must NOT flag; `invalid` samples are
 * cases it MUST flag. A `nearMiss` valid sample is syntactically close to an
 * invalid case but semantically different — the shape-matching false-positive
 * that the six historical regressions (pool.length, COUNT/WHERE receivers,
 * createTable-not-ORM, createElement(Button), escapeSql(x), class-in-CSS-comment)
 * all shared.
 */
export interface RuleSample {
  /** Source text (or other input) that the rule must flag (invalid) or must not flag (valid). */
  code: string;
  /** True when this valid sample is a near-miss. */
  nearMiss?: boolean;
  /** The resolution the rule must produce for this invalid sample (resolvable rules only). */
  resolution?: Resolution;
}

/** The set of inline samples a rule declares (Spec 37 R3). */
export interface RuleSamples {
  valid: RuleSample[];
  invalid: RuleSample[];
}

/**
 * Every known rule/violation-type ID → analyzer.
 *
 * Invariant IDs (user-defined from .codeauditor.json rules) are NOT
 * listed — they vary per project. The two fixed invariant IDs
 * (`config-error`, `engine-error`) are listed.
 */
export const RULE_REGISTRY: Record<string, Readonly<RuleRegistryEntry>> = {
  // ── solid (UniversalSOLIDAnalyzer) ──────────────────────────────────────
  'solid/class-size': {
    analyzer: 'solid',
    field: 'rule',
    input: ['files'],
    resolvable: true,
    message: 'Class "{name}" has {methods} methods, exceeding the maximum of {max}. Consider splitting into smaller classes.',
    docs: 'solid/class-size',
    thresholds: ['maxMethodsPerClass', 'classMethodsThreshold', 'classAggregateComplexity'],
    samples: {
      valid: [
        { code: 'class Small {\n  load() { return this.fetch(); }\n  save() { return this.persist(); }\n}', nearMiss: true },
      ],
      invalid: [
        {
          code: 'class Big {\n  m1() {} m2() {} m3() {} m4() {} m5() {} m6() {} m7() {} m8() {}\n  m9() {} m10() {} m11() {} m12() {} m13() {} m14() {} m15() {} m16() {}\n}',
          resolution: { action: 'extract-methods', summary: 'Extract the methods that touch only migration state into a separate class and delegate to it.', symbols: ['Big'] },
        },
      ],
    },
  },
  'solid/method-complexity': {
    analyzer: 'solid',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Method "{name}" has cyclomatic complexity {complexity}, exceeding the maximum of {max}.',
    docs: 'solid/method-complexity',
    thresholds: ['maxMethodComplexity'],
    samples: {
      valid: [
        { code: 'function simple(x) {\n  if (x > 0) return x;\n  return -x;\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'function complex(x) {\n  if (a && b) { if (c) { while (d) { if (e) return 1; } } }\n  if (f || g) { for (;;) { if (h) break; } }\n  return 0;\n}' },
      ],
    },
  },
  'solid/open-closed': {
    analyzer: 'solid',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Class "{name}" uses instanceof against a user-defined type.',
    docs: 'solid/open-closed',
    thresholds: [],
    samples: {
      valid: [
        { code: 'class Circle extends Shape {\n  area() { return Math.PI * this.r ** 2; }\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'class AreaCalculator {\n  compute(shape) {\n    if (shape instanceof Circle) return Math.PI * shape.r ** 2;\n    else if (shape instanceof Square) return shape.s ** 2;\n  }\n}' },
      ],
    },
  },
  'solid/single-responsibility': {
    analyzer: 'solid',
    field: 'rule',
    input: ['files'],
    resolvable: true,
    message: 'Function "{name}" mixes unrelated responsibilities. Split it into one function per concern.',
    docs: 'solid/single-responsibility',
    // #131: the mixed-concern check has no tunable threshold. The size proxies
    // (line count, parameter count) moved to function-length / parameter-count.
    thresholds: [],
    samples: {
      valid: [
        { code: 'function parse(input) {\n  return input.trim().split(",");\n}', nearMiss: true },
      ],
      invalid: [
        {
          code: 'function handler(req) {\n  const user = db.find(req.id);\n  sendEmail(user);\n  logEvent(req);\n  render(user);\n  audit(user);\n  notify(user);\n}',
          resolution: { action: 'split-function', summary: 'Split handler into one function per responsibility and compose them at the call site.', symbols: ['handler'] },
        },
      ],
    },
  },
  'function-length': {
    analyzer: 'solid',
    field: 'rule',
    input: ['files'],
    resolvable: true,
    message: 'Function "{name}" has {lines} lines, exceeding the maximum of {max}. Consider breaking it down.',
    docs: 'function-length',
    thresholds: ['maxLinesPerMethod'],
    samples: {
      valid: [
        { code: 'function short(x) {\n  const a = transform(x);\n  const b = validate(a);\n  return b;\n}', nearMiss: true },
      ],
      invalid: [
        {
          code: 'function long(input) {\n  let a = step1(input);\n  let b = step2(a);\n  let c = step3(b);\n  let d = step4(c);\n  let e = step5(d);\n  let f = step6(e);\n  let g = step7(f);\n  let h = step8(g);\n  let i = step9(h);\n  let j = step10(i);\n  let k = step11(j);\n  let l = step12(k);\n  let m = step13(l);\n  let n = step14(m);\n  let o = step15(n);\n  let p = step16(o);\n  let q = step17(p);\n  let r = step18(q);\n  let s = step19(r);\n  let t = step20(s);\n  let u = step21(t);\n  let v = step22(u);\n  let w = step23(v);\n  let x = step24(w);\n  let y = step25(x);\n  let z = step26(y);\n  let aa = step27(z);\n  let ab = step28(aa);\n  let ac = step29(ab);\n  let ad = step30(ac);\n  let ae = step31(ad);\n  let af = step32(ae);\n  let ag = step33(af);\n  let ah = step34(ag);\n  let ai = step35(ah);\n  let aj = step36(ai);\n  let ak = step37(aj);\n  let al = step38(ak);\n  let am = step39(al);\n  let an = step40(am);\n  let ao = step41(an);\n  let ap = step42(ao);\n  let aq = step43(ap);\n  let ar = step44(aq);\n  let as = step45(ar);\n  let at = step46(as);\n  let au = step47(at);\n  let av = step48(au);\n  let aw = step49(av);\n  let ax = step50(aw);\n  let ay = step51(ax);\n  return ay;\n}',
          resolution: { action: 'break-down-function', summary: 'Break "long" into smaller functions, extracting named helper blocks for each pipeline stage.', symbols: ['long'] },
        },
      ],
    },
  },
  'parameter-count': {
    analyzer: 'solid',
    field: 'rule',
    input: ['files'],
    resolvable: true,
    message: 'Function "{name}" has {params} parameters, exceeding the maximum of {max}. Consider using an options object.',
    docs: 'parameter-count',
    thresholds: ['maxParametersPerMethod'],
    samples: {
      valid: [
        { code: 'function combine(a, b, c, d) {\n  return a + b + c + d;\n}', nearMiss: true },
      ],
      invalid: [
        {
          code: 'function combine(a, b, c, d, e) {\n  return a + b + c + d + e;\n}',
          resolution: { action: 'bundle-params', summary: 'Bundle the 5 parameters of "combine" into an options object.', symbols: ['a', 'b', 'c', 'd', 'e'] },
        },
      ],
    },
  },
  'interface-size': {
    analyzer: 'solid',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Interface "{name}" has many members.',
    docs: 'interface-size',
    thresholds: [],
    samples: {
      valid: [
        { code: 'interface Printer {\n  print(doc) { return doc; }\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'interface Machine {\n  print() {}\n  scan() {}\n  fax() {}\n  staple() {}\n}' },
      ],
    },
  },
  'solid/liskov-substitution': {
    analyzer: 'solid',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Method "{name}" overrides a parent method and throws where the parent does not.',
    docs: 'solid/liskov-substitution',
    thresholds: [],
    samples: {
      valid: [
        { code: 'class Bird {\n  fly() { return "flying"; }\n}\nclass Sparrow extends Bird {\n  fly() { return "flying"; }\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'class Bird {\n  fly() { return "flying"; }\n}\nclass Ostrich extends Bird {\n  fly() { throw new Error("cannot fly"); }\n}' },
      ],
    },
  },
  'solid/dependency-inversion': {
    analyzer: 'solid',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Module "{name}" violates the Dependency Inversion Principle.',
    docs: 'solid/dependency-inversion',
    thresholds: [],
    samples: {
      valid: [
        { code: 'class Service {\n  constructor(repo) { this.repo = repo; }\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'class Service {\n  constructor() { this.repo = new PostgresRepo(); }\n}' },
      ],
    },
  },

  // ── dry (UniversalDRYAnalyzer) ──────────────────────────────────────────
  'dry/duplicate': {
    analyzer: 'dry',
    field: 'rule',
    input: ['files'],
    resolvable: true,
    message: 'Duplicate code block detected ({lines} lines). First occurrence at {file}:{line}.',
    docs: 'dry/duplicate',
    thresholds: ['minLineThreshold'],
    samples: {
      valid: [
        { code: 'function a() {\n  return foo();\n}\nfunction b() {\n  return bar();\n}', nearMiss: true },
      ],
      invalid: [
        {
          code: 'function a() {\n  const x = compute(1);\n  const y = compute(2);\n  return x + y;\n}\nfunction b() {\n  const x = compute(1);\n  const y = compute(2);\n  return x + y;\n}',
          resolution: { action: 'extract-shared', summary: 'Extract the duplicated block into a shared helper and call it from both sites.', symbols: ['a', 'b'] },
        },
      ],
    },
  },
  'dry/structural-similarity': {
    analyzer: 'dry',
    field: 'rule',
    configGate: 'checkStructuralSimilarity',
    input: ['files'],
    resolvable: false,
    message: 'Structurally similar code block detected ({similarity}% similar to {file}:{line}).',
    docs: 'dry/structural-similarity',
    thresholds: ['similarityThreshold'],
    samples: {
      valid: [
        { code: 'function a(x) {\n  return x + 1;\n}\nfunction b(x) {\n  return x * 2;\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'function a(x) {\n  return fetch(x).then((r) => r.json());\n}\nfunction b(y) {\n  return fetch(y).then((r) => r.json());\n}' },
      ],
    },
  },
  'dry/similar-expression': {
    analyzer: 'dry',
    field: 'rule',
    configGate: 'checkExpressionSimilarity',
    input: ['files'],
    resolvable: true,
    message: 'Near-identical expression detected ({shared} shared {unit}: {names}). First occurrence at {file}:{line}.',
    docs: 'dry/similar-expression',
    // #133: on by default. The floor (minShapeNames) counts the field/method
    // names two fragments must share. Fluent library/builder chains (query and
    // schema builders, Zod validators, commander, promises, DOM and stdlib
    // method chains) are excluded and object literals must target the same
    // identifier, so default-on stays quiet on idiomatic API surface and schema
    // literals while still firing on the `resultSummary` object built twice.
    thresholds: ['minShapeNames'],
    samples: {
      valid: [
        {
          // Same target assigned twice, but the field lists share nothing — a
          // "built twice" shape that is not actually near-identical.
          code: 'const state = {};\nstate.summary = { a: 1, b: 2, c: 3, d: 4 };\nstate.summary = { e: 5, f: 6, g: 7, h: 8 };',
          nearMiss: true,
        },
      ],
      invalid: [
        {
          code: 'const info = {};\ninfo.resultSummary = { completedAt: now, tables: t, tableCounts: tc, stagingCounts: sc, steps: st };\ninfo.resultSummary = { completedAt: now, tables: t, tableCounts: tc, stagingCounts: sc, steps: st, durationMs: d };',
          resolution: {
            action: 'extract-shared-expression',
            summary: 'Extract the shared field list (completedAt, tables, tableCounts, stagingCounts, steps) into a shared builder or constant both sites use.',
            symbols: ['info.resultSummary'],
          },
        },
      ],
    },
  },
  'duplicate-string-literal': {
    analyzer: 'dry',
    field: 'rule',
    configGate: 'checkStrings',
    input: ['files'],
    resolvable: false,
    message: 'String literal "{text}" is duplicated {count} times.',
    docs: 'duplicate-string-literal',
    thresholds: [],
    samples: {
      valid: [
        { code: 'const a = "one";\nconst b = "two";', nearMiss: true },
      ],
      invalid: [
        { code: 'const a = "connection-timeout";\nconst b = "connection-timeout";\nconst c = "connection-timeout";' },
      ],
    },
  },
  'duplicate-import': {
    analyzer: 'dry',
    field: 'rule',
    configGate: 'checkImports',
    input: ['files'],
    resolvable: false,
    message: 'Duplicate import of "{module}".',
    docs: 'duplicate-import',
    thresholds: [],
    samples: {
      valid: [
        { code: 'import { a } from "./mod";\nimport { b } from "./other";', nearMiss: true },
      ],
      invalid: [
        { code: 'import { a } from "./mod";\nimport { b } from "./mod";' },
      ],
    },
  },

  // ── data-access (UniversalDataAccessAnalyzer) ───────────────────────────
  'sql-injection-risk': {
    analyzer: 'data-access',
    field: 'rule',
    input: ['files'],
    resolvable: true,
    message: 'Potential SQL injection risk in {method}. Use parameterized queries.',
    docs: 'sql-injection-risk',
    thresholds: [],
    samples: {
      valid: [
        { code: 'db.query("SELECT * FROM users WHERE id = ?", [userId])', nearMiss: true },
      ],
      invalid: [
        {
          code: 'db.query("SELECT * FROM users WHERE id = " + userId)',
          resolution: { action: 'parameterize', summary: 'Replace the string-concatenated SQL with a parameterized query using the driver\'s placeholder form.', symbols: ['query'] },
        },
      ],
    },
  },
  'missing-org-filter': {
    analyzer: 'data-access',
    field: 'rule',
    input: ['schema'],
    resolvable: false,
    message: 'Query on {tables} is missing an organization/tenant filter.',
    docs: 'missing-org-filter',
    thresholds: [],
    samples: {
      valid: [
        { code: 'db.query("SELECT * FROM projects WHERE org_id = ?", [orgId])', nearMiss: true },
      ],
      invalid: [
        { code: 'db.query("SELECT * FROM projects WHERE id = ?", [id])' },
      ],
    },
  },
  'complex-query': {
    analyzer: 'data-access',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Query is complex: it contains a subquery or references many tables.',
    docs: 'complex-query',
    thresholds: ['performanceThresholds.joinedTableCount'],
    samples: {
      valid: [
        { code: 'db.query("SELECT COUNT(*) FROM users")', nearMiss: true },
      ],
      invalid: [
        { code: 'db.query("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)")' },
        { code: 'db.query("SELECT * FROM a JOIN b JOIN c JOIN d JOIN e JOIN f JOIN g JOIN h JOIN i")' },
      ],
    },
  },
  'unfiltered-query': {
    analyzer: 'data-access',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Query on {tables} has no filter.',
    docs: 'unfiltered-query',
    thresholds: [],
    samples: {
      valid: [
        { code: 'db.query("SELECT * FROM users WHERE id = ?", [id])', nearMiss: true },
      ],
      invalid: [
        { code: 'db.query("SELECT * FROM users")' },
      ],
    },
  },
  'hardcoded-connection': {
    analyzer: 'data-access',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Hardcoded database connection string detected.',
    docs: 'hardcoded-connection',
    thresholds: [],
    samples: {
      valid: [
        { code: 'const conn = connect(process.env.DATABASE_URL)', nearMiss: true },
      ],
      invalid: [
        { code: 'const conn = connect("postgres://user:pass@localhost:5432/db")' },
      ],
    },
  },
  'loop-query': {
    analyzer: 'data-access',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Database query inside a loop detected in {method}.',
    docs: 'loop-query',
    thresholds: [],
    samples: {
      valid: [
        { code: 'for (const id of ids) {\n  cache.set(id, lookup(id));\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'for (const id of ids) {\n  db.query("SELECT * FROM users WHERE id = ?", [id]);\n}' },
      ],
    },
  },

  // ── secrets (UniversalSecretsAnalyzer) ──────────────────────────────────
  'hardcoded-secret': {
    analyzer: 'secrets',
    field: 'rule',
    configGate: 'checkHardcodedSecrets',
    input: ['files'],
    resolvable: true,
    message: 'Hardcoded secret detected: a credential value is embedded in source. Move it to an environment variable or secret store.',
    docs: 'hardcoded-secret',
    thresholds: [],
    samples: {
      valid: [
        // Placeholder value — named like a secret, but the value is a known placeholder.
        { code: "const apiKey = 'your-api-key';", nearMiss: true },
        // Env var reference — not a string literal, so never a candidate.
        { code: 'const apiKey = process.env.API_KEY;', nearMiss: true },
      ],
      invalid: [
        {
          code: "const password = 'hunter2Secret9';",
          resolution: {
            action: 'remove-hardcoded-secret',
            summary: 'Replace the hardcoded "password" credential with a reference to an environment variable or secret store (e.g. process.env.PASSWORD).',
            symbols: ['password'],
          },
        },
        {
          code: "await page.type('#password', 'vyy8AUVvish34Fq');",
          resolution: {
            action: 'remove-hardcoded-secret',
            summary: 'Replace the hardcoded credential with a reference to an environment variable or secret store (e.g. process.env.SECRET).',
          },
        },
      ],
    },
  },

  // ── documentation (UniversalDocumentationAnalyzer) ─────────────────────
  'file-documentation': {
    analyzer: 'documentation',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'File is missing a leading documentation comment.',
    docs: 'file-documentation',
    thresholds: ['minDescriptionLength'],
    samples: {
      valid: [
        { code: '/** @fileoverview Core utilities for this module. */\nexport const a = 1;', nearMiss: true },
      ],
      invalid: [
        { code: 'export const a = 1;' },
      ],
    },
  },
  'function-documentation': {
    analyzer: 'documentation',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Function "{name}" is missing a doc comment.',
    docs: 'function-documentation',
    thresholds: ['minDescriptionLength'],
    samples: {
      valid: [
        { code: '/** Does the thing. */\nfunction foo() {}', nearMiss: true },
      ],
      invalid: [
        { code: 'function foo() {}' },
      ],
    },
  },
  'parameter-documentation': {
    analyzer: 'documentation',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Parameter "{name}" in function "{func}" is missing a @param tag.',
    docs: 'parameter-documentation',
    thresholds: [],
    samples: {
      valid: [
        { code: '/**\n * Greets.\n * @param name the name\n */\nfunction greet(name) {}', nearMiss: true },
      ],
      invalid: [
        { code: '/** Greets. */\nfunction greet(name) {}' },
      ],
    },
  },
  'return-documentation': {
    analyzer: 'documentation',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Function "{name}" is missing a @returns tag.',
    docs: 'return-documentation',
    thresholds: [],
    samples: {
      valid: [
        { code: '/**\n * Computes.\n * @returns the result\n */\nfunction compute() {}', nearMiss: true },
      ],
      invalid: [
        { code: '/** Computes. */\nfunction compute() {}' },
      ],
    },
  },
  'class-documentation': {
    analyzer: 'documentation',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Class "{name}" is missing a doc comment.',
    docs: 'class-documentation',
    thresholds: ['minDescriptionLength', 'docsMinLines'],
    samples: {
      valid: [
        { code: '/** A widget. */\nclass Widget {}', nearMiss: true },
      ],
      invalid: [
        { code: 'class Widget {}' },
      ],
    },
  },
  'method-documentation': {
    analyzer: 'documentation',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Method "{name}" is missing a doc comment.',
    docs: 'method-documentation',
    thresholds: ['minDescriptionLength'],
    samples: {
      valid: [
        { code: 'class W {\n  /** Renders. */\n  render() {}\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'class W {\n  render() {}\n}' },
      ],
    },
  },

  // ── schema (UniversalSchemaAnalyzer) ────────────────────────────────────
  // JSON validation rules → emitted by the schema-json visitor path.
  'invalid-json': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Invalid JSON: {error}.',
    docs: 'invalid-json',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"a": 1}', nearMiss: true },
      ],
      invalid: [
        { code: '{"a": }' },
      ],
    },
  },
  'missing-schema-declaration': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Missing JSON schema declaration.',
    docs: 'missing-schema-declaration',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"$schema": "http://json-schema.org/draft-07/schema#"}', nearMiss: true },
      ],
      invalid: [
        { code: '{"type": "object"}' },
      ],
    },
  },
  'undefined-required-field': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Undefined required field "{field}".',
    docs: 'undefined-required-field',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"field": "id"}', nearMiss: true },
      ],
      invalid: [
        { code: '{"field": "unknown_col"}' },
      ],
    },
  },
  'invalid-type': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Invalid type for field "{field}".',
    docs: 'invalid-type',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"field": "age", "type": "integer"}', nearMiss: true },
      ],
      invalid: [
        { code: '{"field": "age", "type": "intger"}' },
      ],
    },
  },
  'invalid-range': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Invalid range for field "{field}".',
    docs: 'invalid-range',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"field": "age", "minimum": 0, "maximum": 120}', nearMiss: true },
      ],
      invalid: [
        { code: '{"field": "age", "minimum": 200, "maximum": 100}' },
      ],
    },
  },
  'file-error': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Error processing schema file: {error}.',
    docs: 'file-error',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"valid": true}', nearMiss: true },
      ],
      invalid: [
        { code: 'not a readable schema' },
      ],
    },
  },
  'type-mismatch': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Type mismatch for field "{field}".',
    docs: 'type-mismatch',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"age": 30}', nearMiss: true },
      ],
      invalid: [
        { code: '{"age": "thirty"}' },
      ],
    },
  },
  'string-too-short': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'String value too short for field "{field}".',
    docs: 'string-too-short',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"name": "ab"}', nearMiss: true },
      ],
      invalid: [
        { code: '{"name": "a"}' },
      ],
    },
  },
  'string-too-long': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'String value too long for field "{field}".',
    docs: 'string-too-long',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"name": "ab"}', nearMiss: true },
      ],
      invalid: [
        { code: '{"name": "abcdefghij"}' },
      ],
    },
  },
  'pattern-mismatch': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Value does not match pattern for field "{field}".',
    docs: 'pattern-mismatch',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"email": "a@b.com"}', nearMiss: true },
      ],
      invalid: [
        { code: '{"email": "not-an-email"}' },
      ],
    },
  },
  'invalid-format': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Invalid format for field "{field}".',
    docs: 'invalid-format',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"date": "2026-01-01"}', nearMiss: true },
      ],
      invalid: [
        { code: '{"date": "not-a-date"}' },
      ],
    },
  },
  'below-minimum': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Value below minimum for field "{field}".',
    docs: 'below-minimum',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"count": 5}', nearMiss: true },
      ],
      invalid: [
        { code: '{"count": 0}' },
      ],
    },
  },
  'above-maximum': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Value above maximum for field "{field}".',
    docs: 'above-maximum',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"count": 5}', nearMiss: true },
      ],
      invalid: [
        { code: '{"count": 100}' },
      ],
    },
  },
  'too-few-items': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Too few items for field "{field}".',
    docs: 'too-few-items',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"tags": ["a", "b"]}', nearMiss: true },
      ],
      invalid: [
        { code: '{"tags": []}' },
      ],
    },
  },
  'too-many-items': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Too many items for field "{field}".',
    docs: 'too-many-items',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"tags": ["a"]}', nearMiss: true },
      ],
      invalid: [
        { code: '{"tags": ["a", "b", "c", "d"]}' },
      ],
    },
  },
  'missing-required-field': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Missing required field "{field}".',
    docs: 'missing-required-field',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"id": 1}', nearMiss: true },
      ],
      invalid: [
        { code: '{}' },
      ],
    },
  },
  'unexpected-property': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Unexpected property "{property}".',
    docs: 'unexpected-property',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"id": 1}', nearMiss: true },
      ],
      invalid: [
        { code: '{"id": 1, "extra": true}' },
      ],
    },
  },
  'enum-mismatch': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-json'],
    resolvable: false,
    message: 'Value does not match any enum value for field "{field}".',
    docs: 'enum-mismatch',
    thresholds: [],
    samples: {
      valid: [
        { code: '{"status": "active"}', nearMiss: true },
      ],
      invalid: [
        { code: '{"status": "actiev"}' },
      ],
    },
  },
  // SQL-injection → emitted by the schema-code visitor over TS/JS source.
  'dynamic-sql-construction': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-code'],
    resolvable: false,
    message: 'SQL query built via string interpolation or concatenation in {method}; use parameterized queries.',
    docs: 'dynamic-sql-construction',
    thresholds: [],
    samples: {
      valid: [
        { code: 'db.query("SELECT * FROM t WHERE id = ?", [id])', nearMiss: true },
      ],
      invalid: [
        { code: 'db.query("SELECT * FROM t WHERE id = " + id)' },
      ],
    },
  },
  // Table naming-convention check → emitted by the schema-code visitor.
  // Spec 38 R5: renamed from `naming-convention` (see src/ruleAliases.ts).
  'table-naming-convention': {
    analyzer: 'schema',
    field: 'rule',
    configGate: 'checkNamingConventions',
    input: ['schema-code'],
    resolvable: false,
    message: 'Table name "{table}" should use snake_case convention.',
    docs: 'table-naming-convention',
    thresholds: [],
    samples: {
      valid: [
        { code: 'const t = sql`SELECT * FROM user_profiles`', nearMiss: true },
      ],
      invalid: [
        { code: 'const t = sql`SELECT * FROM UserProfiles`' },
      ],
    },
  },
  // Cross-file unknown-table detection → emitted by the schema Stage 3 reducer.
  'unknown-table': {
    analyzer: 'schema',
    field: 'rule',
    input: ['schema-code'],
    resolvable: true,
    message: 'Reference to unknown table "{table}" ({type}). Did you mean: {suggestions}?',
    docs: 'unknown-table',
    thresholds: [],
    samples: {
      valid: [
        { code: 'db.query("SELECT * FROM users")', nearMiss: true },
      ],
      invalid: [
        {
          code: 'db.query("SELECT * FROM user")',
          resolution: { action: 'use-known-table', summary: 'Rename the table reference "user" to the nearest known table "users".', symbols: ['users'] },
        },
      ],
    },
  },

  // ── react (reactAnalyzer) ───────────────────────────────────────────────
  'hooks-naming': {
    analyzer: 'react',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'React hook "{name}" does not follow the "use*" naming convention.',
    docs: 'hooks-naming',
    thresholds: [],
    samples: {
      valid: [
        { code: 'function useFetch() {\n  return useState(null);\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'function fetchData() {\n  return useState(null);\n}' },
      ],
    },
  },
  'complexity': {
    analyzer: 'react',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'React component "{name}" has complexity {complexity}, exceeding the maximum.',
    docs: 'complexity',
    thresholds: [],
    samples: {
      valid: [
        { code: 'function Simple({ x }) {\n  return <div>{x}</div>;\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'function Complex(props) {\n  if (a) { if (b) { if (c) { if (d) { return <X/>; } } } }\n  if (e) { if (f) { return <Y/>; } }\n  return <Z/>;\n}' },
      ],
    },
  },
  'missing-props': {
    analyzer: 'react',
    field: 'rule',
    configGate: 'requirePropTypes',
    input: ['files'],
    resolvable: false,
    message: 'React component "{name}" is missing prop-types.',
    docs: 'missing-props',
    thresholds: [],
    samples: {
      valid: [
        { code: 'function P({ x }) {\n  return <div>{x}</div>;\n}\nP.propTypes = { x: PropTypes.number };', nearMiss: true },
      ],
      invalid: [
        { code: 'function P({ x }) {\n  return <div>{x}</div>;\n}' },
      ],
    },
  },
  'no-error-boundary': {
    analyzer: 'react',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'React component tree is missing an error boundary.',
    docs: 'no-error-boundary',
    thresholds: [],
    samples: {
      valid: [
        { code: '<ErrorBoundary>\n  <App />\n</ErrorBoundary>', nearMiss: true },
      ],
      invalid: [
        { code: '<App />' },
      ],
    },
  },
  'performance': {
    analyzer: 'react',
    field: 'rule',
    configGate: 'requireMemoization',
    input: ['files'],
    resolvable: false,
    message: 'React component "{name}" is missing memoization.',
    docs: 'performance',
    thresholds: [],
    samples: {
      valid: [
        { code: 'const List = memo(function List({ items }) {\n  return <ul>{items}</ul>;\n});', nearMiss: true },
      ],
      invalid: [
        { code: 'function List({ items }) {\n  return <ul>{items}</ul>;\n}' },
      ],
    },
  },
  'accessibility': {
    analyzer: 'react',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Accessibility issue in component "{name}": {issue}.',
    docs: 'accessibility',
    thresholds: [],
    samples: {
      valid: [
        { code: '<img src="x.png" alt="description" />', nearMiss: true },
      ],
      invalid: [
        { code: '<img src="x.png" />' },
      ],
    },
  },
  'raw-element': {
    analyzer: 'react',
    field: 'rule',
    input: ['files'],
    resolvable: true,
    message: 'raw `<{element}>` — this project uses `<{wrapper}>` ({file}).',
    docs: 'raw-element',
    thresholds: [],
    samples: {
      valid: [
        { code: 'return <Button onClick={fn}>Save</Button>;', nearMiss: true },
        { code: 'return React.createElement(Button, null, "Save");', nearMiss: true },
      ],
      invalid: [
        {
          code: 'return <button onClick={fn}>Save</button>;',
          resolution: { action: 'use-wrapper', summary: 'Replace the raw <button> with the project\'s <Button> component.', symbols: ['Button'] },
        },
      ],
    },
  },

  // ── invariants (invariantsAnalyzer) — fixed internal IDs only ──────────
  'config-error': {
    analyzer: 'invariants',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Invalid invariant config: {error}.',
    docs: 'config-error',
    thresholds: [],
    samples: {
      valid: [
        { code: 'export default { rules: [] };', nearMiss: true },
      ],
      invalid: [
        { code: 'export default { rules: [{ kind: "not-a-kind" }] };' },
      ],
    },
  },
  'engine-error': {
    analyzer: 'invariants',
    field: 'rule',
    input: ['files'],
    resolvable: false,
    message: 'Invariant rule engine error: {error}.',
    docs: 'engine-error',
    thresholds: [],
    samples: {
      valid: [
        { code: 'runRules([], { rules: [] });', nearMiss: true },
      ],
      invalid: [
        { code: 'runRules(null, { rules: [] });' },
      ],
    },
  },

  // ── schema-validator (SchemaValidator) ──────────────────────────────────
  'field-mismatch': {
    analyzer: 'schema-validator',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Field mismatch: {detail}.',
    docs: 'field-mismatch',
    thresholds: [],
    samples: {
      valid: [
        { code: 'model User { id Int @id }', nearMiss: true },
      ],
      invalid: [
        { code: 'model User { id String @id }' },
      ],
    },
  },
  'schema-field-mismatch': {
    analyzer: 'schema-validator',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Schema field type-name strings differ: {detail}.',
    docs: 'schema-field-mismatch',
    thresholds: [],
    samples: {
      valid: [
        { code: 'CREATE TABLE users (id INTEGER);', nearMiss: true },
      ],
      invalid: [
        { code: 'CREATE TABLE users (id INTEGER);\nINSERT INTO users (id, name) VALUES (1, "x");' },
      ],
    },
  },
  'missing-field': {
    analyzer: 'schema-validator',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Missing field: {field}.',
    docs: 'missing-field',
    thresholds: [],
    samples: {
      valid: [
        { code: 'INSERT INTO users (id, name) VALUES (?, ?);', nearMiss: true },
      ],
      invalid: [
        { code: 'INSERT INTO users (id) VALUES (?);' },
      ],
    },
  },
  'extra-field': {
    analyzer: 'schema-validator',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Extra field: {field}.',
    docs: 'extra-field',
    thresholds: [],
    samples: {
      valid: [
        { code: 'SELECT id, name FROM users;', nearMiss: true },
      ],
      invalid: [
        { code: 'SELECT id, name, bogus FROM users;' },
      ],
    },
  },
  'constraint-mismatch': {
    analyzer: 'schema-validator',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Constraint mismatch: {detail}.',
    docs: 'constraint-mismatch',
    thresholds: [],
    samples: {
      valid: [
        { code: 'model User { id Int @id @default(autoincrement()) }', nearMiss: true },
      ],
      invalid: [
        { code: 'model User { id Int @id }' },
      ],
    },
  },
  'version-mismatch': {
    analyzer: 'schema-validator',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Version mismatch: {detail}.',
    docs: 'version-mismatch',
    thresholds: [],
    samples: {
      valid: [
        { code: 'export const version = "1.2.3";', nearMiss: true },
      ],
      invalid: [
        { code: 'export const version = "0.0.1";' },
      ],
    },
  },

  // ── api-contract (APIContractAnalyzer) ──────────────────────────────────
  'api-type-mismatch': {
    analyzer: 'api-contract',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'API type mismatch: {detail}.',
    docs: 'api-type-mismatch',
    thresholds: [],
    samples: {
      valid: [
        { code: 'function getUser(id: number): User { return {} as User; }', nearMiss: true },
      ],
      invalid: [
        { code: 'function getUser(id: number): string { return ""; }' },
      ],
    },
  },
  'missing-endpoint': {
    analyzer: 'api-contract',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Missing API endpoint: {endpoint}.',
    docs: 'missing-endpoint',
    thresholds: [],
    samples: {
      valid: [
        { code: 'app.get("/users", handler);', nearMiss: true },
      ],
      invalid: [
        { code: 'app.get("/unlisted", handler);' },
      ],
    },
  },
  'api-extra-field': {
    analyzer: 'api-contract',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Extra field in API response: {field}.',
    docs: 'api-extra-field',
    thresholds: [],
    samples: {
      valid: [
        { code: 'return res.json({ id, name });', nearMiss: true },
      ],
      invalid: [
        { code: 'return res.json({ id, name, internal });' },
      ],
    },
  },
  'api-missing-field': {
    analyzer: 'api-contract',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Missing field in API response: {field}.',
    docs: 'api-missing-field',
    thresholds: [],
    samples: {
      valid: [
        { code: 'return res.json({ id, name });', nearMiss: true },
      ],
      invalid: [
        { code: 'return res.json({ id });' },
      ],
    },
  },
  'method-mismatch': {
    analyzer: 'api-contract',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'HTTP method mismatch: {detail}.',
    docs: 'method-mismatch',
    thresholds: [],
    samples: {
      valid: [
        { code: 'app.post("/users", createUser);', nearMiss: true },
      ],
      invalid: [
        { code: 'app.get("/users", createUser);' },
      ],
    },
  },
  'auth-mismatch': {
    analyzer: 'api-contract',
    field: 'rule',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Authentication mismatch: {detail}.',
    docs: 'auth-mismatch',
    thresholds: [],
    samples: {
      valid: [
        { code: 'app.get("/users", auth, handler);', nearMiss: true },
      ],
      invalid: [
        { code: 'app.get("/users", handler);' },
      ],
    },
  },

  // ── dependency-graph (DependencyGraphBuilder) ───────────────────────────
  'circular-dependency': {
    analyzer: 'dependency-graph',
    field: 'type',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Circular dependency detected: {cycle}.',
    docs: 'circular-dependency',
    thresholds: [],
    samples: {
      valid: [
        { code: 'import { b } from "./b";\n// a.ts imports b.ts only', nearMiss: true },
      ],
      invalid: [
        { code: 'import { b } from "./b";\n// b.ts also imports a.ts' },
      ],
    },
  },
  'break-cycles': {
    analyzer: 'dependency-graph',
    field: 'type',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Break dependency cycle: {cycle}.',
    docs: 'break-cycles',
    thresholds: [],
    samples: {
      valid: [
        { code: '// a.ts -> b.ts -> c.ts (no back edge)', nearMiss: true },
      ],
      invalid: [
        { code: '// a.ts -> b.ts -> a.ts' },
      ],
    },
  },
  'tight-coupling': {
    analyzer: 'dependency-graph',
    field: 'type',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Tight coupling detected between {a} and {b}.',
    docs: 'tight-coupling',
    thresholds: [],
    samples: {
      valid: [
        { code: 'import { one } from "./m";', nearMiss: true },
      ],
      invalid: [
        { code: 'import * as m from "./m";\nm.a(); m.b(); m.c(); m.d(); m.e();' },
      ],
    },
  },
  'reduce-coupling': {
    analyzer: 'dependency-graph',
    field: 'type',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Reduce coupling between {a} and {b}.',
    docs: 'reduce-coupling',
    thresholds: [],
    samples: {
      valid: [
        { code: 'import { f } from "./u";', nearMiss: true },
      ],
      invalid: [
        { code: 'import { a, b, c, d, e, f, g, h } from "./u";' },
      ],
    },
  },
  'hub-nodes': {
    analyzer: 'dependency-graph',
    field: 'type',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Hub node "{node}" has {count} dependencies.',
    docs: 'hub-nodes',
    thresholds: [],
    samples: {
      valid: [
        { code: 'export function small() {}', nearMiss: true },
      ],
      invalid: [
        { code: 'export function hub() {\n  a(); b(); c(); d(); e(); f(); g(); h(); i(); j();\n}' },
      ],
    },
  },
  'split-responsibilities': {
    analyzer: 'dependency-graph',
    field: 'type',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Split responsibilities of node "{node}".',
    docs: 'split-responsibilities',
    thresholds: [],
    samples: {
      valid: [
        { code: 'export function focused() { return a(); }', nearMiss: true },
      ],
      invalid: [
        { code: 'export function multi() {\n  readDb(); writeLog(); renderUi(); sendMail();\n}' },
      ],
    },
  },
  'orphaned-nodes': {
    analyzer: 'dependency-graph',
    field: 'type',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Orphaned node "{node}" has no connections.',
    docs: 'orphaned-nodes',
    thresholds: [],
    samples: {
      valid: [
        { code: 'export function used() {}', nearMiss: true },
      ],
      invalid: [
        { code: 'export function neverImported() {}' },
      ],
    },
  },
  'review-orphans': {
    analyzer: 'dependency-graph',
    field: 'type',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Review orphaned nodes: {nodes}.',
    docs: 'review-orphans',
    thresholds: [],
    samples: {
      valid: [
        { code: '// all exports are imported elsewhere', nearMiss: true },
      ],
      invalid: [
        { code: 'export const dead = 1;' },
      ],
    },
  },
  'unreferenced-module': {
    analyzer: 'dependency-graph',
    field: 'type',
    input: ['cross-language-entities'],
    resolvable: false,
    message: 'Module is not imported by any other file and is not a framework entry point — dead code candidate.',
    docs: 'unreferenced-module',
    thresholds: [],
    samples: {
      valid: [
        { code: 'export function used() {}', nearMiss: true },
      ],
      invalid: [
        { code: '// file exports symbols but nothing imports it' },
      ],
    },
  },

  // ── styles (UniversalStylesAnalyzer) ─────────────────────────────────────
  'styles/value-drift': {
    analyzer: 'styles',
    field: 'rule',
    input: ['styles-css'],
    resolvable: false,
    message: 'Color value "{value}" drifts from the dominant token.',
    docs: 'styles/value-drift',
    thresholds: ['colorDeltaE', 'outlierMaxShare'],
    samples: {
      valid: [
        { code: '.btn { color: var(--brand); }', nearMiss: true },
      ],
      invalid: [
        { code: '.btn { color: #123456; }' },
      ],
    },
  },
  'styles/off-scale': {
    analyzer: 'styles',
    field: 'rule',
    input: ['styles-css'],
    resolvable: false,
    message: 'Value "{value}" is off the Tailwind spacing scale.',
    docs: 'styles/off-scale',
    thresholds: ['minCorpus'],
    samples: {
      valid: [
        { code: '.x { padding: 8px; }', nearMiss: true },
      ],
      invalid: [
        { code: '.x { padding: 13px; }' },
      ],
    },
  },
  'styles/undefined-class': {
    analyzer: 'styles',
    field: 'rule',
    input: ['styles-css'],
    resolvable: true,
    message: 'Undefined CSS class: "{class}" has no matching definition.',
    docs: 'styles/undefined-class',
    thresholds: [],
    samples: {
      valid: [
        { code: '.card { display: flex; }\n// used in markup: <div class="card">', nearMiss: true },
      ],
      invalid: [
        {
          code: '// markup uses <div class="missing">\n.card { display: flex; }',
          resolution: { action: 'define-class', summary: 'Define the .missing class in the stylesheet that this markup imports.', symbols: ['missing'] },
        },
      ],
    },
  },
  'styles/undefined-class-disabled': {
    analyzer: 'styles',
    field: 'rule',
    input: ['styles-css'],
    resolvable: false,
    message: 'Undefined-class detection skipped: {reason}.',
    docs: 'styles/undefined-class-disabled',
    thresholds: [],
    samples: {
      valid: [
        { code: '// detection enabled, corpus present', nearMiss: true },
      ],
      invalid: [
        { code: '// no stylesheet corpus available' },
      ],
    },
  },
  'styles/token-bypass': {
    analyzer: 'styles',
    field: 'rule',
    input: ['styles-css'],
    resolvable: false,
    message: 'Token bypass: raw value "{value}" used instead of a design token.',
    docs: 'styles/token-bypass',
    thresholds: [],
    samples: {
      valid: [
        { code: '.btn { background: var(--color-bg); }', nearMiss: true },
      ],
      invalid: [
        { code: '.btn { background: #fff; }' },
      ],
    },
  },
  'styles/mechanism-fragmentation': {
    analyzer: 'styles',
    field: 'rule',
    input: ['styles-css'],
    resolvable: false,
    message: 'Styling mechanism fragmented across {count} mechanisms.',
    docs: 'styles/mechanism-fragmentation',
    thresholds: ['mechanismFragmentationMinMechanisms'],
    samples: {
      valid: [
        { code: '// one mechanism: css-modules only', nearMiss: true },
      ],
      invalid: [
        { code: '// inline styles + css-modules + tailwind + styled-components' },
      ],
    },
  },
  'styles/mechanism-mixing': {
    analyzer: 'styles',
    field: 'rule',
    input: ['styles-css'],
    resolvable: false,
    message: 'Mixing styling mechanisms in one file.',
    docs: 'styles/mechanism-mixing',
    thresholds: [],
    samples: {
      valid: [
        { code: '.x { color: var(--brand); }', nearMiss: true },
      ],
      invalid: [
        { code: 'const s = { color: "#fff" };\n<div style={s} className="x" />' },
      ],
    },
  },
  'styles/declaration-set-similarity': {
    analyzer: 'styles',
    field: 'rule',
    input: ['styles-css'],
    resolvable: false,
    message: 'Declaration set similar to another block ({similarity}%).',
    docs: 'styles/declaration-set-similarity',
    thresholds: ['declarationSetMinDeclarations', 'declarationSetSimilarityThreshold'],
    samples: {
      valid: [
        { code: '.a { color: red; margin: 0; padding: 1px; border: 0; }', nearMiss: true },
      ],
      invalid: [
        { code: '.a { color: red; margin: 0; padding: 1px; border: 0; }\n.b { color: red; margin: 0; padding: 1px; border: 0; }' },
      ],
    },
  },
  'styles/z-index-sprawl': {
    analyzer: 'styles',
    field: 'rule',
    input: ['styles-css'],
    resolvable: false,
    message: 'Z-index sprawl: {count} distinct z-index values.',
    docs: 'styles/z-index-sprawl',
    thresholds: ['zIndexMaxDistinct'],
    samples: {
      valid: [
        { code: '.m { z-index: 1; }', nearMiss: true },
      ],
      invalid: [
        { code: '.a { z-index: 1; } .b { z-index: 2; } .c { z-index: 3; } .d { z-index: 4; } .e { z-index: 5; }' },
      ],
    },
  },
  'styles/z-index-singleton': {
    analyzer: 'styles',
    field: 'rule',
    input: ['styles-css'],
    resolvable: false,
    message: 'Z-index value "{value}" appears only once.',
    docs: 'styles/z-index-singleton',
    thresholds: [],
    samples: {
      valid: [
        { code: '.m { z-index: 2; } .n { z-index: 2; }', nearMiss: true },
      ],
      invalid: [
        { code: '.m { z-index: 99; }' },
      ],
    },
  },

  // ── conventions (UniversalConventionsAnalyzer) ───────────────────────────
  'conventions/usage-pair': {
    analyzer: 'conventions',
    field: 'rule',
    input: ['function-index'],
    resolvable: true,
    message: '{pct}% of `{antecedent}` callers also call `{consequent}`.',
    docs: 'conventions/usage-pair',
    thresholds: ['pairConfidence'],
    samples: {
      valid: [
        { code: '// calls to openDb are independently distributed', nearMiss: true },
      ],
      invalid: [
        {
          code: 'function a() { openDb(); closeDb(); }\nfunction b() { openDb(); }\nfunction c() { openDb(); }\nfunction d() { openDb(); }\nfunction e() { openDb(); }',
          resolution: { action: 'pair-call', summary: 'Add the companion call to closeDb() wherever openDb() is called, matching the dominant usage pair.', symbols: ['closeDb', 'openDb'] },
        },
      ],
    },
  },
  'conventions/import-form': {
    analyzer: 'conventions',
    field: 'rule',
    input: ['function-index'],
    resolvable: false,
    message: 'Import form mismatch: use {form} for "{source}".',
    docs: 'conventions/import-form',
    thresholds: ['modeShare', 'minCorpus'],
    samples: {
      valid: [
        { code: 'import { x } from "./m";', nearMiss: true },
      ],
      invalid: [
        { code: 'import * as x from "./m";' },
      ],
    },
  },
  'conventions/error-handling': {
    analyzer: 'conventions',
    field: 'rule',
    input: ['function-index'],
    resolvable: false,
    message: 'Error-handling convention mismatch: {detail}.',
    docs: 'conventions/error-handling',
    thresholds: ['modeShare', 'minCorpus'],
    samples: {
      valid: [
        { code: 'const [v, err] = await tryRead();', nearMiss: true },
      ],
      invalid: [
        { code: 'const v = await tryRead();' },
      ],
    },
  },
  'conventions/export-shape': {
    analyzer: 'conventions',
    field: 'rule',
    input: ['function-index'],
    resolvable: false,
    message: 'Export shape mismatch: {detail}.',
    docs: 'conventions/export-shape',
    thresholds: ['modeShare', 'minCorpus'],
    samples: {
      valid: [
        { code: 'export default function f() {}', nearMiss: true },
      ],
      invalid: [
        { code: 'module.exports = { f };' },
      ],
    },
  },
  'conventions/naming': {
    analyzer: 'conventions',
    field: 'rule',
    input: ['function-index'],
    resolvable: false,
    message: 'Naming convention mismatch: {detail}.',
    docs: 'conventions/naming',
    thresholds: ['modeShare', 'minCorpus'],
    samples: {
      valid: [
        { code: 'function fetchUser() {}', nearMiss: true },
      ],
      invalid: [
        { code: 'function getData() {}' },
      ],
    },
  },

  // ── cross-domain (CrossDomainAnalyzer) ────────────────────────────────────
  'cross-domain/written-never-read': {
    analyzer: 'cross-domain',
    field: 'rule',
    input: ['schema_usage', 'functions'],
    resolvable: false,
    message: 'Table "{table}" is written but never read.',
    docs: 'cross-domain/written-never-read',
    thresholds: [],
    samples: {
      valid: [
        { code: 'INSERT INTO logs ...;\nSELECT * FROM logs ...;', nearMiss: true },
      ],
      invalid: [
        { code: 'INSERT INTO logs ...;' },
      ],
    },
  },
  'cross-domain/read-never-written': {
    analyzer: 'cross-domain',
    field: 'rule',
    input: ['schema_usage', 'functions'],
    resolvable: false,
    message: 'Table "{table}" is read but never written.',
    docs: 'cross-domain/read-never-written',
    thresholds: [],
    samples: {
      valid: [
        { code: 'INSERT INTO cfg ...;\nSELECT * FROM cfg ...;', nearMiss: true },
      ],
      invalid: [
        { code: 'SELECT * FROM cfg ...;' },
      ],
    },
  },
  'cross-domain/multi-table-write': {
    analyzer: 'cross-domain',
    field: 'rule',
    input: ['schema_usage', 'functions'],
    resolvable: false,
    message: 'Function writes to {count} distinct tables.',
    docs: 'cross-domain/multi-table-write',
    thresholds: ['schemaLifecycle.txnTableMax'],
    samples: {
      valid: [
        { code: 'UPDATE users SET ...;\nINSERT INTO audit_log ...;', nearMiss: true },
      ],
      invalid: [
        { code: 'UPDATE a SET ...;\nUPDATE b SET ...;\nUPDATE c SET ...;\nUPDATE d SET ...;' },
      ],
    },
  },
  'cross-domain/no-validator-reachable': {
    analyzer: 'cross-domain',
    field: 'rule',
    input: ['schema_usage', 'functions'],
    resolvable: false,
    message: 'No validator reachable within BFS depth: {detail}.',
    docs: 'cross-domain/no-validator-reachable',
    thresholds: [],
    samples: {
      valid: [
        { code: 'const v = validate(input);\nuse(v);', nearMiss: true },
      ],
      invalid: [
        { code: 'use(input);' },
      ],
    },
  },
  'cross-domain/uncovered-risk': {
    analyzer: 'cross-domain',
    field: 'rule',
    input: ['schema_usage', 'functions'],
    resolvable: false,
    message: 'Uncovered risk: {detail}.',
    docs: 'cross-domain/uncovered-risk',
    thresholds: [],
    samples: {
      valid: [
        { code: '// risk mitigated by guard', nearMiss: true },
      ],
      invalid: [
        { code: '// risk present with no mitigation' },
      ],
    },
  },
};

/**
 * Canonical set of every analyzer ID that emits at least one rule in
 * {@link RULE_REGISTRY}, derived from the registry itself. An analyzer "exists"
 * iff it emits a rule, so this is the single source of truth for analyzer
 * identity.
 *
 * Every other analyzer list — the audit-runner registry, config validation,
 * default-enabled analyzers, the detached runner, and the MCP default set —
 * must derive from this rather than re-type names. Adding an analyzer is then a
 * registry edit plus an enable decision, never a hunt across hand-maintained
 * arrays that drift out of sync (the historical failure: four lists at 13, 10,
 * 10, and 7).
 */
export const ALL_ANALYZERS: readonly string[] = [
  ...new Set(Object.values(RULE_REGISTRY).map((e) => e.analyzer)),
].sort();

/**
 * The reduced analyzer set the MCP `audit.run` surface enables by default —
 * a deliberate subset of {@link ALL_ANALYZERS} (the MCP path favors a lighter,
 * latency-sensitive audit). The full CLI `audit` default is {@link ALL_ANALYZERS}.
 * Referenced here so mcp.ts and mcp-tools-shared.ts don't each re-type the list.
 */
export const MCP_DEFAULT_ANALYZERS: readonly string[] = [
  'solid',
  'dry',
  'documentation',
  'react',
  'data-access',
];

/**
 * A violation in the loose shape the gate and baseline code handle (a Violation
 * with the transitional analyzer/type/violationType/etc. fields still present).
 */
interface ViolationLike {
  analyzer?: string;
  rule?: string;
  type?: string;
  violationType?: string;
  principle?: string;
  contractType?: string;
  ruleId?: string;
}

/**
 * Resolve a violation to its canonical {@link RuleRegistryEntry}, if any.
 *
 * The registry records which field on the Violation carries the rule ID
 * (`field` — `rule` for almost every analyzer, `type` for dependency-graph).
 * This helper reads that field off the violation and matches it against the
 * registry key, so the gate's resolution-gap detection (Spec 45 R1) never
 * hard-codes a field.
 *
 * Invariant violations (user-defined rule IDs) have no registry entry and
 * return `undefined`. They still gate (Spec 45 R1) — the gate blocks on every
 * finding at a blocking severity; the registry only determines whether a
 * missing resolution is a recorded gap.
 */
export function getViolationRuleEntry(v: ViolationLike): Readonly<RuleRegistryEntry> | undefined {
  if (!v.analyzer) return undefined;
  for (const [ruleId, entry] of Object.entries(RULE_REGISTRY)) {
    if (entry.analyzer !== v.analyzer) continue;
    const value = (v as Record<string, unknown>)[entry.field];
    if (value === ruleId) return entry;
  }
  return undefined;
}
