import type { Resolution } from '../types.js';
import type { Needs } from '../phase/types.js';

/**
 * Rule Registry — canonical mapping of every emitted rule/violation-type ID
 * to its emitting analyzer and its consumer-facing contract.
 *
 * This is the ONE place that asserts "each rule ID has exactly one emitter."
 * If you add a new emitted ID to an analyzer, add it here. The enforcement
 * test (`registry enforces one emitter per rule ID`) fails the suite on
 * duplicate entries — preventing the collision class where two analyzers
 * emit the same string.
 *
 * Rider 2, Spec 19: the `type-mismatch` duplicate between
 * UniversalSchemaAnalyzer (rule) and SchemaValidator (violationType) was
 * discovered during ground-truth enumeration. SchemaValidator's copy was
 * renamed to `schema-field-mismatch`.
 *
 * NOTE: `contractType` is NOT in the buildFingerprintInput rule-ID chain.
 * APIContractAnalyzer violations currently resolve rule='' in fingerprints.
 * They are listed here for collision detection nonetheless.
 *
 * NOTE: invariants analyzer rule IDs are user-defined and variable —
 * `config-error` and `engine-error` are diagnostics (not violations), see
 * `CoverageDiagnostic.kind`; they no longer have registry entries.
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
   * Spec 68 §2 — the rule's declaration: the file formats it can evaluate and
   * the fact kinds it reads. Required, no optional form, no default — a rule
   * that does not declare `needs` fails to compile. This is the load-bearing
   * replacement for `input`/`handledLanguages`: coverage is derived from it
   * (§8), the schedule is built from it (§5), and a rule that reaches a fact
   * it did not declare cannot even be written (AnalysisContext exposes only
   * declared facts).
   */
  needs: Needs;
  /**
   * Optional dot-separated path to a config boolean within the analyzer's namespace.
   * When the config value is `false`, the rule is `notApplicable` (explicitly disabled).
   *
   * Example: `checkStructuralSimilarity` → looked up as config.config.dry.checkStructuralSimilarity.
   * The path is relative to the analyzer namespace (config.config[analyzer]).
   */
  configGate?: string;
  /**
   * Spec 66 follow-up — when true, this rule's {@link configGate} defaults to
   * `false` in the tool's own defaults (the rule ships off and must be opted
   * into). A false gate then reads `off-by-default` (a named, discoverable
   * fourth state) rather than `disabled by config` — the latter describes a rule
   * the user turned off, the former a rule the tool ships off. The distinction
   * keeps the zero-firing sweep from misclassifying a healthy opt-in rule as a
   * broken one. Only meaningful alongside `configGate`.
   */
  offByDefault?: boolean;
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
   * Why the thresholds are set where they are. Required whenever a rule carries a
   * tunable size threshold — a number must never be an unexplained magic value.
   * For a re-calibration, record the "old → new → why" so the decision is auditable
   * (the Spec 33 failure: 50→100 / 4→6 silently dropped 660 single-responsibility
   * findings because the change was a side effect, not a reasoned decision).
   */
  thresholdRationale?: string;
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
 * listed — they vary per project. The fixed invariant IDs (`config-error`,
 * `engine-error`) are diagnostics (see `CoverageDiagnostic.kind`), not
 * violation rules, so they have no registry entry.
 */
const _RULE_REGISTRY = {
  // ── solid (UniversalSOLIDAnalyzer) ──────────────────────────────────────
  'solid/class-size': {
    analyzer: 'solid',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: true,
    message: 'Class "{name}" has {methods} methods, exceeding the maximum of {max}. Consider splitting into smaller classes.',
    docs: 'solid/class-size',
    thresholds: ['maxMethodsPerClass', 'classMethodsThreshold', 'classAggregateComplexity'],
    thresholdRationale: 'A class is a god-object boundary, not a style nit. 20 methods / 150 aggregate cyclomatic complexity are where a class unambiguously holds too much. The old 15/100 flagged ordinary domain models and controllers (31 findings on knex).',
    samples: {
      valid: [
        { code: 'class Small {\n  load() { return this.fetch(); }\n  save() { return this.persist(); }\n}', nearMiss: true },
      ],
      invalid: [
        {
          code: 'class Big {\n  m1() {} m2() {} m3() {} m4() {} m5() {} m6() {} m7() {}\n  m8() {} m9() {} m10() {} m11() {} m12() {} m13() {} m14() {}\n  m15() {} m16() {} m17() {} m18() {} m19() {} m20() {} m21() {}\n}',
          resolution: { action: 'extract-methods', summary: 'Extract the methods that touch only migration state into a separate class and delegate to it.', symbols: ['Big'] },
        },
      ],
    },
  },
  'solid/method-complexity': {
    analyzer: 'solid',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: false,
    message: 'Method "{name}" has cyclomatic complexity {complexity}, exceeding the maximum of {max}.',
    docs: 'solid/method-complexity',
    thresholds: ['maxMethodComplexity'],
    thresholdRationale: 'McCC 50 is already a genuinely large function, not idiomatic code (33 findings on recall-protocol, all real outliers). Kept at 50 — the cyclomatic-complexity ceiling where a function cannot be held in working memory; no raise needed.',
    samples: {
      valid: [
        { code: 'function simple(x) {\n  if (x > 0) return x;\n  return -x;\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'function complex(x) {\n  if (x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x && x) return 1;\n  return 0;\n}' },
      ],
    },
  },
  'solid/open-closed': {
    analyzer: 'solid',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: true,
    message: 'Function "{name}" has {lines} lines, exceeding the maximum of {max}. Consider breaking it down.',
    docs: 'function-length',
    thresholds: ['maxLinesPerMethod'],
    thresholdRationale: '50 flagged any function over ~one screen; idiomatic handlers/setup/config builders run 50–150 lines (23 findings on a small React project with every correctness rule at zero). 200 is the working-memory ceiling where a function is unambiguously too long.',
    samples: {
      valid: [
        { code: 'function short(x) {\n  const a = transform(x);\n  const b = validate(a);\n  return b;\n}', nearMiss: true },
      ],
      invalid: [
        {
          code: 'function long(input) {\n  let v1 = step1(input);\n  let v2 = step2(v1);\n  let v3 = step3(v2);\n  let v4 = step4(v3);\n  let v5 = step5(v4);\n  let v6 = step6(v5);\n  let v7 = step7(v6);\n  let v8 = step8(v7);\n  let v9 = step9(v8);\n  let v10 = step10(v9);\n  let v11 = step11(v10);\n  let v12 = step12(v11);\n  let v13 = step13(v12);\n  let v14 = step14(v13);\n  let v15 = step15(v14);\n  let v16 = step16(v15);\n  let v17 = step17(v16);\n  let v18 = step18(v17);\n  let v19 = step19(v18);\n  let v20 = step20(v19);\n  let v21 = step21(v20);\n  let v22 = step22(v21);\n  let v23 = step23(v22);\n  let v24 = step24(v23);\n  let v25 = step25(v24);\n  let v26 = step26(v25);\n  let v27 = step27(v26);\n  let v28 = step28(v27);\n  let v29 = step29(v28);\n  let v30 = step30(v29);\n  let v31 = step31(v30);\n  let v32 = step32(v31);\n  let v33 = step33(v32);\n  let v34 = step34(v33);\n  let v35 = step35(v34);\n  let v36 = step36(v35);\n  let v37 = step37(v36);\n  let v38 = step38(v37);\n  let v39 = step39(v38);\n  let v40 = step40(v39);\n  let v41 = step41(v40);\n  let v42 = step42(v41);\n  let v43 = step43(v42);\n  let v44 = step44(v43);\n  let v45 = step45(v44);\n  let v46 = step46(v45);\n  let v47 = step47(v46);\n  let v48 = step48(v47);\n  let v49 = step49(v48);\n  let v50 = step50(v49);\n  let v51 = step51(v50);\n  let v52 = step52(v51);\n  let v53 = step53(v52);\n  let v54 = step54(v53);\n  let v55 = step55(v54);\n  let v56 = step56(v55);\n  let v57 = step57(v56);\n  let v58 = step58(v57);\n  let v59 = step59(v58);\n  let v60 = step60(v59);\n  let v61 = step61(v60);\n  let v62 = step62(v61);\n  let v63 = step63(v62);\n  let v64 = step64(v63);\n  let v65 = step65(v64);\n  let v66 = step66(v65);\n  let v67 = step67(v66);\n  let v68 = step68(v67);\n  let v69 = step69(v68);\n  let v70 = step70(v69);\n  let v71 = step71(v70);\n  let v72 = step72(v71);\n  let v73 = step73(v72);\n  let v74 = step74(v73);\n  let v75 = step75(v74);\n  let v76 = step76(v75);\n  let v77 = step77(v76);\n  let v78 = step78(v77);\n  let v79 = step79(v78);\n  let v80 = step80(v79);\n  let v81 = step81(v80);\n  let v82 = step82(v81);\n  let v83 = step83(v82);\n  let v84 = step84(v83);\n  let v85 = step85(v84);\n  let v86 = step86(v85);\n  let v87 = step87(v86);\n  let v88 = step88(v87);\n  let v89 = step89(v88);\n  let v90 = step90(v89);\n  let v91 = step91(v90);\n  let v92 = step92(v91);\n  let v93 = step93(v92);\n  let v94 = step94(v93);\n  let v95 = step95(v94);\n  let v96 = step96(v95);\n  let v97 = step97(v96);\n  let v98 = step98(v97);\n  let v99 = step99(v98);\n  let v100 = step100(v99);\n  let v101 = step101(v100);\n  let v102 = step102(v101);\n  let v103 = step103(v102);\n  let v104 = step104(v103);\n  let v105 = step105(v104);\n  let v106 = step106(v105);\n  let v107 = step107(v106);\n  let v108 = step108(v107);\n  let v109 = step109(v108);\n  let v110 = step110(v109);\n  let v111 = step111(v110);\n  let v112 = step112(v111);\n  let v113 = step113(v112);\n  let v114 = step114(v113);\n  let v115 = step115(v114);\n  let v116 = step116(v115);\n  let v117 = step117(v116);\n  let v118 = step118(v117);\n  let v119 = step119(v118);\n  let v120 = step120(v119);\n  let v121 = step121(v120);\n  let v122 = step122(v121);\n  let v123 = step123(v122);\n  let v124 = step124(v123);\n  let v125 = step125(v124);\n  let v126 = step126(v125);\n  let v127 = step127(v126);\n  let v128 = step128(v127);\n  let v129 = step129(v128);\n  let v130 = step130(v129);\n  let v131 = step131(v130);\n  let v132 = step132(v131);\n  let v133 = step133(v132);\n  let v134 = step134(v133);\n  let v135 = step135(v134);\n  let v136 = step136(v135);\n  let v137 = step137(v136);\n  let v138 = step138(v137);\n  let v139 = step139(v138);\n  let v140 = step140(v139);\n  let v141 = step141(v140);\n  let v142 = step142(v141);\n  let v143 = step143(v142);\n  let v144 = step144(v143);\n  let v145 = step145(v144);\n  let v146 = step146(v145);\n  let v147 = step147(v146);\n  let v148 = step148(v147);\n  let v149 = step149(v148);\n  let v150 = step150(v149);\n  let v151 = step151(v150);\n  let v152 = step152(v151);\n  let v153 = step153(v152);\n  let v154 = step154(v153);\n  let v155 = step155(v154);\n  let v156 = step156(v155);\n  let v157 = step157(v156);\n  let v158 = step158(v157);\n  let v159 = step159(v158);\n  let v160 = step160(v159);\n  let v161 = step161(v160);\n  let v162 = step162(v161);\n  let v163 = step163(v162);\n  let v164 = step164(v163);\n  let v165 = step165(v164);\n  let v166 = step166(v165);\n  let v167 = step167(v166);\n  let v168 = step168(v167);\n  let v169 = step169(v168);\n  let v170 = step170(v169);\n  let v171 = step171(v170);\n  let v172 = step172(v171);\n  let v173 = step173(v172);\n  let v174 = step174(v173);\n  let v175 = step175(v174);\n  let v176 = step176(v175);\n  let v177 = step177(v176);\n  let v178 = step178(v177);\n  let v179 = step179(v178);\n  let v180 = step180(v179);\n  let v181 = step181(v180);\n  let v182 = step182(v181);\n  let v183 = step183(v182);\n  let v184 = step184(v183);\n  let v185 = step185(v184);\n  let v186 = step186(v185);\n  let v187 = step187(v186);\n  let v188 = step188(v187);\n  let v189 = step189(v188);\n  let v190 = step190(v189);\n  let v191 = step191(v190);\n  let v192 = step192(v191);\n  let v193 = step193(v192);\n  let v194 = step194(v193);\n  let v195 = step195(v194);\n  let v196 = step196(v195);\n  let v197 = step197(v196);\n  let v198 = step198(v197);\n  let v199 = step199(v198);\n  let v200 = step200(v199);\n  let v201 = step201(v200);\n  let v202 = step202(v201);\n  let v203 = step203(v202);\n  let v204 = step204(v203);\n  let v205 = step205(v204);\n  return v205;\n}',
          resolution: { action: 'break-down-function', summary: 'Break "long" into smaller functions, extracting named helper blocks for each pipeline stage.', symbols: ['long'] },
        },
      ],
    },
  },
  'parameter-count': {
    analyzer: 'solid',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: true,
    message: 'Function "{name}" has {params} parameters, exceeding the maximum of {max}. Consider using an options object.',
    docs: 'parameter-count',
    thresholds: ['maxParametersPerMethod'],
    thresholdRationale: '4 flagged ordinary dependency-injected constructors and config functions. 6 is where an options object is clearly warranted.',
    samples: {
      valid: [
        { code: 'function combine(a, b, c, d) {\n  return a + b + c + d;\n}', nearMiss: true },
      ],
      invalid: [
        {
          code: 'function combine(a, b, c, d, e, f, g) {\n  return a + b + c + d + e + f + g;\n}',
          resolution: { action: 'bundle-params', summary: 'Bundle the 7 parameters of "combine" into an options object.', symbols: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
        },
      ],
    },
  },
  'interface-size': {
    analyzer: 'solid',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['file-symbols'] as const },
    resolvable: false,
    message: 'Interface "{name}" has many members.',
    docs: 'interface-size',
    thresholds: ['maxInterfaceMembers'],
    thresholdRationale: '20 flagged a legitimate service/repository interface; 25 method-bearing members is where splitting into smaller, more focused interfaces is warranted.',
    samples: {
      valid: [
        { code: 'interface Printer {\n  print(doc) { return doc; }\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'interface Machine {\n  op1(): void;\n  op2(): void;\n  op3(): void;\n  op4(): void;\n  op5(): void;\n  op6(): void;\n  op7(): void;\n  op8(): void;\n  op9(): void;\n  op10(): void;\n  op11(): void;\n  op12(): void;\n  op13(): void;\n  op14(): void;\n  op15(): void;\n  op16(): void;\n  op17(): void;\n  op18(): void;\n  op19(): void;\n  op20(): void;\n  op21(): void;\n  op22(): void;\n  op23(): void;\n  op24(): void;\n  op25(): void;\n  op26(): void;\n}' },
      ],
    },
  },
  // ── Go successor rules (Spec-49) ────────────────────────────────────────
  // The Go analyzer emits these *bare* IDs (Analyzer: 'solid') for the honest
  // size readings that replaced the retired Go `single-responsibility` /
  // `open-closed` proxies, plus the Go `liskov-substitution` (method calls
  // panic()) rule. They were missing from the registry, so Go findings were
  // invisible to coverage and `describeRuleId` reported them `unknown`.
  'switch-size': {
    analyzer: 'solid',
    field: 'rule',
    needs: { formats: ['go'] as const, facts: ['file-symbols'] as const },
    resolvable: false,
    message: 'Switch or type switch has many case clauses.',
    docs: 'switch-size',
    thresholds: [],
    thresholdRationale: 'Go analyzer: 5 flagged idiomatic dispatch switches (HTTP status / command maps). 8 cases suggests a table-driven lookup. Hardcoded in the Go analyzer (not a TS config key).',
    samples: {
      valid: [
        {
          code: 'package main\n\nfunc small(x int) int {\n\tswitch x {\n\tcase 1:\n\t\treturn 1\n\tcase 2:\n\t\treturn 2\n\tcase 3:\n\t\treturn 3\n\t}\n\treturn 0\n}',
          nearMiss: true,
        },
      ],
      invalid: [
        { code: 'package main\n\nfunc dispatch(x int) int {\n\tswitch x {\n\tcase 1:\n\t\treturn 1\n\tcase 2:\n\t\treturn 2\n\tcase 3:\n\t\treturn 3\n\tcase 4:\n\t\treturn 4\n\tcase 5:\n\t\treturn 5\n\tcase 6:\n\t\treturn 6\n\tcase 7:\n\t\treturn 7\n\tcase 8:\n\t\treturn 8\n\tcase 9:\n\t\treturn 9\n\t}\n\treturn 0\n}' },
      ],
    },
  },
  'function-size': {
    analyzer: 'solid',
    field: 'rule',
    needs: { formats: ['go'] as const, facts: ['file-symbols'] as const },
    resolvable: false,
    message: 'Function has many parameters, multiple returns, and high complexity.',
    docs: 'function-size',
    thresholds: [],
    thresholdRationale: 'Go analyzer: AND-combined (complexity > 20 && returns > 2 && params > 6) — a function large in every dimension. Complexity raised 10→20 and params 5→6 to align with the TS ceilings while staying conservative (all three must exceed).',
    samples: {
      valid: [
        {
          code: 'package main\n\nfunc deep(x int) int {\n\tif x > 0 { x++ }\n\tif x > 1 { x++ }\n\tif x > 2 { x++ }\n\tif x > 3 { x++ }\n\tif x > 4 { x++ }\n\tif x > 5 { x++ }\n\tif x > 6 { x++ }\n\tif x > 7 { x++ }\n\tif x > 8 { x++ }\n\tif x > 9 { x++ }\n\tif x > 10 { x++ }\n\treturn x\n}',
          nearMiss: true,
        },
      ],
      invalid: [
        { code: 'package main\n\nfunc doEverything(a int, b int, c int, d int, e int, f int, g int) (int, string, bool) {\n\tx := 0\n\tif b > 1 { x++ }\n\tif c > 2 { x++ }\n\tif d > 3 { x++ }\n\tif e > 4 { x++ }\n\tif f > 5 { x++ }\n\tif g > 6 { x++ }\n\tif a > 7 { x++ }\n\tif b > 8 { x++ }\n\tif c > 9 { x++ }\n\tif d > 10 { x++ }\n\tif e > 11 { x++ }\n\tif f > 12 { x++ }\n\tif g > 13 { x++ }\n\tif a > 14 { x++ }\n\tif b > 15 { x++ }\n\tif c > 16 { x++ }\n\tif d > 17 { x++ }\n\tif e > 18 { x++ }\n\tif f > 19 { x++ }\n\tif g > 20 { x++ }\n\treturn x, "ok", true\n}' },
      ],
    },
  },
  'struct-size': {
    analyzer: 'solid',
    field: 'rule',
    needs: { formats: ['go'] as const, facts: ['file-symbols'] as const },
    resolvable: false,
    message: 'Struct has many fields.',
    docs: 'struct-size',
    thresholds: [],
    thresholdRationale: 'Go analyzer: 10 flagged ordinary config/model structs; 15 fields is a god-struct. Hardcoded in the Go analyzer (not a TS config key).',
    samples: {
      valid: [
        {
          code: 'package main\n\ntype Small struct {\n\tValue  string\n\tCount  int\n\tNext   *Point\n\tPrior  *Point\n\tLabel  string\n}',
          nearMiss: true,
        },
      ],
      invalid: [
        { code: 'package main\n\ntype Everything struct {\n\tField1  string\n\tField2  string\n\tField3  string\n\tField4  int\n\tField5  int\n\tField6  int\n\tField7  string\n\tField8  string\n\tField9  int\n\tField10 string\n\tField11 string\n\tField12 int\n\tField13 int\n\tField14 string\n\tField15 string\n\tField16 int\n}' },
      ],
    },
  },
  'liskov-substitution': {
    analyzer: 'solid',
    field: 'rule',
    needs: { formats: ['go'] as const, facts: ['file-symbols'] as const },
    resolvable: false,
    message: 'Method calls panic().',
    docs: 'liskov-substitution',
    thresholds: [],
    samples: {
      valid: [
        {
          code: 'package main\n\ntype Parser struct{}\n\nfunc (p *Parser) panicRecovery() error {\n\treturn nil\n}',
          nearMiss: true,
        },
      ],
      invalid: [
        { code: 'package main\n\ntype Parser struct{}\n\nfunc (p *Parser) parse() {\n\tpanic("unexpected token")\n}' },
      ],
    },
  },
  // ── Go non-SOLID rules (Spec-54 severity) ──────────────────────────────
  // The Go subprocess emits these under a single `go` analyzer namespace: the
  // subprocess's internal `imports`/`errors`/`goroutines`/`channels` dispatch is
  // collapsed to `go` at emit time so its structure does not surface as four
  // analyzer names a user has to learn. Registered here so coverage and
  // describeRuleId see them, and so their severities carry a registry entry.
  'solid/liskov-substitution': {
    analyzer: 'solid',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
          // Two IDENTICAL ≥15-line for-loops — `dry/duplicate` is an *exact*
          // token match (normalizeCode keeps identifiers), so the two blocks must
          // be byte-identical, not merely same-shape. The old sample (`function a`
          // / `function b` with identical bodies) was doubly dead: its names differ
          // (no exact hash match) and it was under minLineThreshold.
          code: 'function process(rows) {\n  for (const row of rows) {\n    const id = row.id;\n    const name = row.name;\n    const value = row.value;\n    const category = row.category;\n    const tags = row.tags;\n    const meta = row.meta;\n    const score = computeScore(row);\n    const rank = computeRank(score);\n    const label = formatLabel(name);\n    const bucket = assignBucket(rank);\n    const flags = extractFlags(row);\n    const audit = buildAudit(flags);\n    const record = { id, name, value, category, tags, meta, score, rank, label, bucket, audit };\n    push(record);\n    notify(record.id);\n  }\n  for (const row of rows) {\n    const id = row.id;\n    const name = row.name;\n    const value = row.value;\n    const category = row.category;\n    const tags = row.tags;\n    const meta = row.meta;\n    const score = computeScore(row);\n    const rank = computeRank(score);\n    const label = formatLabel(name);\n    const bucket = assignBucket(rank);\n    const flags = extractFlags(row);\n    const audit = buildAudit(flags);\n    const record = { id, name, value, category, tags, meta, score, rank, label, bucket, audit };\n    push(record);\n    notify(record.id);\n  }\n}',
          resolution: { action: 'extract-shared', summary: 'Extract the duplicated block into a shared helper and call it from both sites.', symbols: ['process'] },
        },
      ],
    },
  },
  'dry/structural-similarity': {
    analyzer: 'dry',
    field: 'rule',
    configGate: 'checkStructuralSimilarity',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: false,
    message: 'Structurally similar code block detected ({similarity}% similar to {file}:{line}).',
    docs: 'dry/structural-similarity',
    thresholds: ['similarityThreshold'],
    samples: {
      valid: [
        { code: 'function a(x) {\n  return x + 1;\n}\nfunction b(x) {\n  return x * 2;\n}', nearMiss: true },
      ],
      invalid: [
        {
          // Two structurally-identical ≥15-line functions with different
          // identifiers/literals. `dry/structural-similarity` compares the
          // token-kind skeleton (normalizeCodeForStructure), so the two must share
          // structure but differ in names — the old two-line `fetch().then()`
          // pair was under minLineThreshold and never emitted.
          code: 'function computeA(rows) {\n  for (const item of rows) {\n    const id = item.id;\n    const name = item.name;\n    const value = item.value;\n    const category = item.category;\n    const tags = item.tags;\n    const meta = item.meta;\n    const score = scoreA(item);\n    const rank = rankA(score);\n    const label = labelA(name);\n    const bucket = bucketA(rank);\n    const flags = flagsA(item);\n    const audit = auditA(flags);\n    const record = { id, name, value, category, tags, meta, score, rank, label, bucket, audit };\n    appendA(record);\n    emitA(record.id);\n  }\n}\nfunction computeB(rows) {\n  for (const entry of rows) {\n    const id = entry.id;\n    const name = entry.name;\n    const value = entry.value;\n    const category = entry.category;\n    const tags = entry.tags;\n    const meta = entry.meta;\n    const score = scoreB(entry);\n    const rank = rankB(score);\n    const label = labelB(name);\n    const bucket = bucketB(rank);\n    const flags = flagsB(entry);\n    const audit = auditB(flags);\n    const record = { id, name, value, category, tags, meta, score, rank, label, bucket, audit };\n    appendB(record);\n    emitB(record.id);\n  }\n}',
        },
      ],
    },
  },
  'dry/similar-expression': {
    analyzer: 'dry',
    field: 'rule',
    configGate: 'checkExpressionSimilarity',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
  // Spec 13 R5 — a previously-identical clone pair whose similarity has fallen
  // across consecutive runs (copy-paste then edit one side). Cross-run: emitted
  // by the divergence-tracking pass in auditRunner, not the per-file DRY visitor.
  'dry/diverging-clone': {
    analyzer: 'dry',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: false,
    message: 'Clone pair has diverged: similarity dropped {drop} (from {previous} to {current}) across {runs} consecutive runs. Review {file1}:{line1} and {file2}:{line2} for diverged logic.',
    docs: 'dry/diverging-clone',
    // No thresholds: the divergence knobs (divergenceThreshold, divergenceRuns,
    // minPairSimilarity) live in DivergenceConfig (types.ts), read by auditRunner's
    // cross-run pass — not keys the dry analyzer's own DEFAULT_DRY_CONFIG reads.
    thresholds: [],
    samples: {
      valid: [
        { code: '// pair similarity 0.82 → 0.81 → 0.80 (below the 0.05 drop over 2 runs)', nearMiss: true },
      ],
      invalid: [
        { code: '// pair similarity 0.82 → 0.70 → 0.58: a ≥0.05 drop for 2 consecutive runs' },
      ],
    },
  },
  'duplicate-string-literal': {
    analyzer: 'dry',
    field: 'rule',
    configGate: 'checkStrings',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['data-access-calls'] as const },
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
    analyzer: 'data-access-org-filter',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['data-access-calls', 'table-catalog'] as const },
    resolvable: true,
    // The claim is "no organization/tenant *predicate*", NOT "no filter". A
    // query scoped by primary key (`WHERE id = $1`) still fires, because it is
    // scoped by id but not by tenant — an IDOR surface if the id is
    // request-reachable. The fix is to add the tenant column to the predicate,
    // not to add a filter (one already exists in the PK-scoped case).
    message: 'Query on {tables} has no organization/tenant predicate.',
    docs: 'missing-org-filter',
    thresholds: [],
    samples: {
      valid: [
        { code: 'db.query("SELECT * FROM projects WHERE org_id = ?", [orgId])', nearMiss: true },
      ],
      invalid: [
        {
          code: 'db.query("SELECT * FROM projects WHERE id = ?", [id])',
          resolution: {
            action: 'add-tenant-predicate',
            summary: 'Add the tenant column (organization_id / org_id) to the WHERE predicate so the query is scoped to the current organization, not just by primary key.',
            symbols: ['db', 'query'],
          },
        },
      ],
    },
  },
  'complex-query': {
    analyzer: 'data-access',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['data-access-calls'] as const },
    resolvable: false,
    message: 'Query references many tables (join-heavy).',
    docs: 'complex-query',
    thresholds: ['performanceThresholds.joinedTableCount'],
    samples: {
      valid: [
        { code: 'db.query("SELECT COUNT(*) FROM users")', nearMiss: true },
        { code: 'db.query("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders)")', nearMiss: true },
      ],
      invalid: [
        { code: 'db.query("SELECT * FROM a JOIN b JOIN c JOIN d JOIN e JOIN f JOIN g JOIN h JOIN i")' },
      ],
    },
  },
  'unfiltered-query': {
    analyzer: 'data-access',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['data-access-calls'] as const },
    resolvable: false,
    message: 'Unfiltered write or tenant-scoped read on {tables} has no WHERE/HAVING/LIMIT.',
    docs: 'unfiltered-query',
    thresholds: [],
    samples: {
      valid: [
        { code: 'db.query("SELECT * FROM users")', nearMiss: true },
        { code: 'db.query("DELETE FROM users WHERE id = ?", [id])', nearMiss: true },
      ],
      invalid: [
        { code: 'db.query("DELETE FROM users")' },
      ],
    },
  },
  'hardcoded-connection': {
    analyzer: 'data-access',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['data-access-calls'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['data-access-calls'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: false,
    configGate: 'requireParamDocs',
    offByDefault: true,
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: false,
    configGate: 'requireReturnDocs',
    offByDefault: true,
    message: 'Function "{name}" is missing a @returns tag.',
    docs: 'return-documentation',
    thresholds: [],
    samples: {
      valid: [
        {
          // return-documentation only applies to a typed, non-void return
          // (`func.returnType && !== 'void'`). The old sample returned nothing,
          // so the guard was vacuous; this one returns `number` and documents it.
          code: '/**\n * Computes the result.\n * @returns the result.\n */\nfunction compute(): number { return 1; }',
          nearMiss: true,
        },
      ],
      invalid: [
        {
          // Missing @returns on a typed, non-void function. The old sample
          // (`function compute() {}`) had no return type, so the return-doc guard
          // never applied.
          code: '/** Computes the result. */\nfunction compute(): number { return 1; }',
        },
      ],
    },
  },
  'class-documentation': {
    analyzer: 'documentation',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
  // SQL-injection → emitted by the schema-code visitor over TS/JS source.
  'dynamic-sql-construction': {
    analyzer: 'schema',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['ddl-declarations'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['ddl-declarations'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['ddl-declarations'] as const },
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
  // Cross-file stale-table-reference detection → emitted by the schema Stage 3
  // reducer. Distinguishes "never existed" (unknown-table) from "existed and was
  // dropped in a migration" (stale-table-reference): the latter is a stale code
  // reference, not a typo, so the message names the dropping migration and the
  // tables it created in its place.
  'stale-table-reference': {
    analyzer: 'schema',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['ddl-declarations'] as const },
    resolvable: true,
    message: 'Reference to dropped table "{table}" — dropped in {migration}.',
    docs: 'stale-table-reference',
    thresholds: [],
    samples: {
      valid: [
        { code: 'db.query("SELECT * FROM users")', nearMiss: true },
      ],
      invalid: [
        {
          code: 'db.query("SELECT * FROM legacy_orders")',
          resolution: { action: 'update-stale-reference', summary: 'The table "legacy_orders" was dropped in 002_drop_legacy.sql. That migration introduces "orders" — review this reference and update or remove it.', symbols: ['orders'] },
        },
      ],
    },
  },
  // Per-function query-count ceiling → emitted by the schema-code visitor.
  // Tunable via maxQueriesPerFunction (default 5); listed under `schema`, which
  // (like the other schema rules) has no config shape in the threshold-validation
  // test, so the knob is documented here rather than declared in `thresholds`.
  'too-many-queries': {
    analyzer: 'schema',
    field: 'rule',
    configGate: 'validateQueryPatterns',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['ddl-declarations'] as const },
    resolvable: false,
    message: 'Function "{name}" has {count} queries, exceeding the maximum of {max}.',
    docs: 'too-many-queries',
    thresholds: [],
    samples: {
      valid: [
        { code: 'function getUser(id) {\n  return db.query("SELECT * FROM users WHERE id = ?", [id]);\n}', nearMiss: true },
      ],
      invalid: [
        { code: 'function loadDashboard() {\n  db.query("SELECT * FROM users");\n  db.query("SELECT * FROM orders");\n  db.query("SELECT * FROM products");\n  db.query("SELECT * FROM reviews");\n  db.query("SELECT * FROM events");\n  db.query("SELECT * FROM alerts");\n}' },
      ],
    },
  },
  // Spec 58 R1 — DB-call SQL held in an unresolvable identifier (imported
  // constant, computed/concatenated expression, call result) is no longer a
  // violation rule. It moved to the coverage-diagnostics channel
  // (`CoverageDiagnostic`, kind `unresolved-query`) — surfaced in the report
  // with file+line, never blocking. The registry entry is removed so
  // `buildCoverageReport` doesn't classify it `clean` (which would assert the
  // tool checked something it no longer checks as a finding).

  // ── react (reactAnalyzer) ───────────────────────────────────────────────
  'hooks-naming': {
    analyzer: 'react',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: false,
    message: 'React component "{name}" has complexity {complexity}, exceeding the maximum.',
    docs: 'complexity',
    thresholds: ['maxComponentComplexity'],
    thresholdRationale: '10 flagged ordinary components with a few conditionals (66 findings on recall-protocol). ESLint\'s own `complexity` default is 20; a component with 20 branches is genuinely complex.',
    samples: {
      valid: [
        { code: 'function Simple({ x }) {\n  return <div>{x}</div>;\n}', nearMiss: true },
      ],
      invalid: [
        {
          // 22 `if` statements — component complexity (base 1 + one per branch)
          // must exceed maxComponentComplexity (20). The old sample had 6
          // branches (complexity 7), under the recalibrated ceiling, so it never
          // fired.
          code: 'function Complex(props) {\n  if (props.x === 1) return <C1 />;\n  if (props.x === 2) return <C2 />;\n  if (props.x === 3) return <C3 />;\n  if (props.x === 4) return <C4 />;\n  if (props.x === 5) return <C5 />;\n  if (props.x === 6) return <C6 />;\n  if (props.x === 7) return <C7 />;\n  if (props.x === 8) return <C8 />;\n  if (props.x === 9) return <C9 />;\n  if (props.x === 10) return <C10 />;\n  if (props.x === 11) return <C11 />;\n  if (props.x === 12) return <C12 />;\n  if (props.x === 13) return <C13 />;\n  if (props.x === 14) return <C14 />;\n  if (props.x === 15) return <C15 />;\n  if (props.x === 16) return <C16 />;\n  if (props.x === 17) return <C17 />;\n  if (props.x === 18) return <C18 />;\n  if (props.x === 19) return <C19 />;\n  if (props.x === 20) return <C20 />;\n  if (props.x === 21) return <C21 />;\n  if (props.x === 22) return <C22 />;\n  return <Z />;\n}',
        },
      ],
    },
  },
  'missing-props': {
    analyzer: 'react',
    field: 'rule',
    configGate: 'requirePropTypes',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
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

  // ── invariants (invariantsAnalyzer) — no fixed violation IDs ────────────
  // Spec 59 — `config-error` / `engine-error` moved off the severity ladder to
  // the coverage-diagnostics channel (`CoverageDiagnostic`, kinds `config-error`
  // / `engine-error`). A bad `.codeauditor.json` or a rule-engine failure is a
  // tool-side "couldn't do its job", not a defect in the audited code. The
  // registry entries are removed so `buildCoverageReport` doesn't classify them
  // `clean` (which would assert the tool checked something it no longer checks
  // as a finding).

  // ── schema-validator (SchemaValidator) ──────────────────────────────────
  'schema-field-mismatch': {
    analyzer: 'schema-validator',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
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
  // ── dependency-graph (DependencyGraphBuilder) ───────────────────────────
  'circular-dependency': {
    analyzer: 'dependency-graph',
    field: 'type',
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
    resolvable: false,
    message: 'Tight coupling detected between {a} and {b}.',
    docs: 'tight-coupling',
    thresholds: [],
    thresholdRationale: 'Cohesion (internal edges / incident edges) > 0.7 — 70% of a cluster\'s edges staying internal is genuinely tight. A density ratio, not a "size" number; fires once per corpus. Kept at 0.7.',
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript', 'go'] as const, facts: ['cross-language-entities'] as const },
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
  // Spec 58 R2 — a dynamic import()/require() with a computed (non-static)
  // specifier is no longer a violation rule. It moved to the coverage-
  // diagnostics channel (`CoverageDiagnostic`, kind `unresolved-dynamic-import`)
  // — surfaced with file+line, never blocking. Removed from the registry so
  // `buildCoverageReport` doesn't flip it to a false `clean`.

  // ── styles (UniversalStylesAnalyzer) ─────────────────────────────────────
  'styles/value-drift': {
    analyzer: 'styles',
    field: 'rule',
    needs: { formats: ['css', 'scss'] as const, facts: ['style-declarations'] as const },
    resolvable: false,
    message: 'Color drift in "{property}": "{value}" is near-identical to "{canonical}" (ΔE = {d}). Consider using "{canonical}".',
    docs: 'styles/value-drift',
    thresholds: ['colorDeltaE'],
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
    needs: { formats: ['css', 'scss'] as const, facts: ['style-declarations'] as const },
    resolvable: false,
    message: 'Value "{value}" is off the Tailwind spacing scale.',
    docs: 'styles/off-scale',
    thresholds: ['offScaleMinDeclarations'],
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
    needs: { formats: ['css', 'scss'] as const, facts: ['style-declarations'] as const },
    resolvable: true,
    message: 'Class "{class}" was not found in any read stylesheet or utility set.',
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
  // Spec 59 — `styles/undefined-class-disabled` moved off the severity ladder
  // to the coverage-diagnostics channel (`CoverageDiagnostic`, kind
  // `undefined-class-disabled`). A Tailwind probe failure (with a Tailwind
  // config present) disables undefined-class detection — a tool-side "couldn't
  // do its job", not a defect. The registry entry is removed so coverage never
  // asserts the tool checked something it no longer checks as a finding.
  'styles/token-bypass': {
    analyzer: 'styles',
    field: 'rule',
    needs: { formats: ['css', 'scss'] as const, facts: ['style-declarations'] as const },
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
    needs: { formats: ['css', 'scss'] as const, facts: ['style-declarations'] as const },
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
    needs: { formats: ['css', 'scss'] as const, facts: ['style-declarations'] as const },
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
    needs: { formats: ['css', 'scss'] as const, facts: ['style-declarations'] as const },
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
    needs: { formats: ['css', 'scss'] as const, facts: ['style-declarations'] as const },
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
    needs: { formats: ['css', 'scss'] as const, facts: ['style-declarations'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['function-index'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['function-index'] as const },
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
    needs: { formats: ['typescript', 'javascript'] as const, facts: ['function-index'] as const },
    // The detector wraps each body as `async function __ca() {…}` and parses it
    // with the TypeScript grammar (`detectErrorHandlingShape`), so only
    // TypeScript/JavaScript bodies are classifiable. A Go (or other-language)
    // function row makes the rule report `cannot-fire`, not `clean`.
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['function-index'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['function-index'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['schema-usage', 'function-index'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['schema-usage', 'function-index'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['schema-usage', 'function-index'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['schema-usage', 'function-index'] as const },
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
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['schema-usage', 'function-index'] as const },
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

  // ── security (UniversalSecurityAnalyzer) — Spec 61 R6 ─────────────────────
  'command-injection-risk': {
    analyzer: 'security',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: true,
    message: 'Unsafe process invocation: {method} is passed a command built by interpolation/concatenation.',
    docs: 'command-injection-risk',
    thresholds: [],
    samples: {
      valid: [
        { code: "execFileSync('git', ['diff', '--name-only', ref])", nearMiss: true },
      ],
      invalid: [
        { code: "execSync(`git diff --name-only ${ref}`)", resolution: { action: 'use-argv-array', summary: 'Replace execSync with execFileSync/spawn whose command is a string literal and whose arguments are separate array elements, so no shell interprets them.', symbols: ['execSync'] } },
      ],
    },
  },
  'dynamic-require-of-project-path': {
    analyzer: 'security',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: true,
    message: 'Dynamic require/import of a project config path: {path}.',
    docs: 'dynamic-require-of-project-path',
    thresholds: [],
    samples: {
      valid: [
        { code: "import('./builtin-helper.js')", nearMiss: true },
        { code: "require('tailwindcss')", nearMiss: true },
      ],
      invalid: [
        { code: "require(configPath)", resolution: { action: 'static-config-extraction', summary: 'Read the config without executing it (static extraction) rather than require()/import() a path discovered from the project tree.', symbols: ['require'] } },
      ],
    },
  },
  'unescaped-html-interpolation': {
    analyzer: 'security',
    field: 'rule',
    needs: { formats: ['typescript', 'tsx', 'javascript'] as const, facts: ['file-symbols'] as const },
    resolvable: true,
    message: 'Unescaped HTML interpolation: {field} is inserted into an HTML template without an escaping call.',
    docs: 'unescaped-html-interpolation',
    thresholds: [],
    samples: {
      valid: [
        {
          // Same sink (`.innerHTML`) + same member-access interpolation, but the
          // value is escape-wrapped — the fix, not the finding. The old near-miss
          // (`const html = ...` with no sink) "passed" only because there was no
          // sink to read.
          code: 'el.innerHTML = `<p>${escapeHtml(user.name)}</p>`;',
          nearMiss: true,
        },
      ],
      invalid: [
        {
          // Needs BOTH a sink (`.innerHTML` assignment) and a member-expression
          // interpolation (`user.name`, not a bare identifier). The old sample
          // (`const html = `${userName}``) had neither, so it never emitted.
          code: 'el.innerHTML = `<p>${user.name}</p>`;',
          resolution: { action: 'escape-html-interpolation', summary: 'Wrap the interpolation in an escaping call (e.g. ${escapeHtml(user.name)}) before it reaches the HTML template.', symbols: ['user.name'] },
        },
      ],
    },
  },
} satisfies Record<string, RuleRegistryEntry>;

export const RULE_REGISTRY: Record<string, Readonly<RuleRegistryEntry>> = _RULE_REGISTRY;
export type RegistryLiteral = typeof _RULE_REGISTRY;

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
  'data-access-org-filter',
];

/**
 * Analyzers the pipeline can run that emit *no* registry rule. Their rules come
 * from a runtime source other than {@link RULE_REGISTRY}: `invariants` reads its
 * rules from the `.codeauditor.json` `rules` array (the seven invariant rule
 * kinds), not from registry rows, so it is absent from {@link ALL_ANALYZERS}.
 */
export const PIPELINE_ONLY_ANALYZERS: readonly string[] = ['invariants'];

/**
 * Every analyzer `enabledAnalyzers` may legitimately name — {@link ALL_ANALYZERS}
 * (registry rule emitters) plus {@link PIPELINE_ONLY_ANALYZERS}. This is the
 * single source of truth for "can this analyzer actually run?" — used by config
 * validation, which must not reject `invariants` (a valid pipeline analyzer that
 * happens to carry no registry rule).
 */
export const RUNNABLE_ANALYZERS: readonly string[] = [
  ...new Set([...ALL_ANALYZERS, ...PIPELINE_ONLY_ANALYZERS]),
].sort();

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
