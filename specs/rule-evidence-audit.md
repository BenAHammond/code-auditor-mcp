# Rule Evidence Audit

**Scope.** One section per rule in `RULE_REGISTRY` (`src/analyzers/ruleRegistry.ts`), in registry order, followed by two cross-cutting capstone sections — **A** (rules whose firing condition is a pattern over a *source region* rather than a relation over *located facts*) and **B** (rules consulting a hardcoded *name/suffix/receiver list*). A and B are the point of this document; the per-rule sections are the evidence that makes them exhaustive.

**Status.** Research and enumeration only. No code changes, no rule changes, no deletions. Where a name cited in the request no longer exists in source, the current equivalent is named and the rename is flagged rather than silently mapped.

**Method.** For each rule the six fields are:
1. **Claim** — the registry `message` (and, where it diverges, the message the rule actually emits; the two are often different after the Spec 68 migration).
2. **Actual firing condition** — the real predicate at the real symbol/line, quoting the code and any regex.
3. **Input position** — which fact kind → which field → which source region / AST node.
4. **Grammar checklist** — every tree-sitter production that can legally appear at that position, enumerated from the loaded grammars' `node-types.json`, not from memory.
5. **Coverage** — against that checklist: handled correctly / mishandled / never-seen.
6. **Existing evidence** — where it lives: registry `samples`, parity test, fixture, corpus baseline, ledger row — each named by file (and line), with the kinds that are *absent* called out.

**Loaded grammars.** `dist/grammars/` ships five WASM grammars and five are loaded: `typescript`, `tsx`, `go`, `css`, `scss`. **There is no `javascript` grammar loaded** — `.js`/`.jsx`/`.mjs`/`.cjs` parse through the `typescript` grammar (a strict superset); `tree-sitter-javascript.wasm` ships but is dead weight. Consequently every grammar checklist for a TS/JS position is drawn from the `typescript` node-types, and "javascript" appears only as a *format* label, never as a distinct grammar. Pinned node-types sources (matching `package.json`): typescript/tsx → `node_modules/.pnpm/tree-sitter-typescript@0.23.2/...`; go → `tree-sitter-go@0.25.0`; css → `tree-sitter-css@0.25.0`; scss → `tree-sitter-scss@1.0.0`.

**The two-phase fact model.** Migrated rules (`src/phase/rules/*.ts`) declare `needs: {formats, facts}` and an `analyze(ctx)` that reads facts, never an AST or a source string. Firing conditions therefore live in two places: the rule body (relation over located facts) and, crucially for section A, the *producer* that projects source text into a fact (a regex over raw text in the producer is still a source-region pattern — it just moved one layer down). The audit reads both.

**Evidence surface (canonical locations).** registry `samples` (`src/analyzers/ruleRegistry.ts`); parity tests (`src/__tests__/spec68-*-parity.spec.ts`); fixtures (`src/__tests__/fixtures/`, `src/analyzers/__tests__/fixtures/`, `bench/corpus/*/src/`); corpus baselines (`specs/corpus-baselines.md`, `bench/baselines/baseline.json`); ledgers (`specs/rule-authenticity-ledger.md`, `specs/rule-replacement-ledger.md`, `specs/severity-assignment-ledger.md`).

---

## Registry order

Rule groups (97 total), with completion markers:

| # | Rules | Status |
|---|-------|--------|
| 1–7 | `solid/*` + `function-length` + `parameter-count` + `interface-size` | ✓ |
| 8–16 | Go metrics (`switch-size` … `import-style`) | ✓ |
| 17 | `solid/liskov-substitution` | ✓ |
| 18–23 | `dry/*`, `duplicate-string-literal`, `duplicate-import` | ✓ |
| 24–29 | data-access (`sql-injection-risk` … `loop-query`) | ✓ |
| 30 | `hardcoded-secret` | ✓ |
| 31–36 | documentation | ✓ |
| 37–53 | schema-json (17) | ✓ |
| 54–58 | schema-code (1 of 2: `dynamic-sql-construction`, `table-naming-convention`, `unknown-table`, `stale-table-reference`, `too-many-queries`) | ✓ |
| 59–65 | react (7) | ✓ |
| 66–68 | schema-validator (`schema-field-mismatch`, `missing-field`, `extra-field`) | ✓ |
| 69–75 | dependency-graph | ✓ |
| 76–84 | styles (9) | ✓ |
| 85–89 | conventions (5) | ✓ |
| 90–94 | cross-domain (5) | ✓ |
| 95–97 | `command-injection-risk`, `dynamic-require-of-project-path`, `unescaped-html-interpolation` | ✓ |

---

## Per-rule sections

## solid (1–7, 17)

Rules 1–4 and 17 live in `src/phase/rules/solid.ts` (Spec-68 `analyze(ctx)` definitions); 5–7 are the size/count rules in the same file. All read facts produced by `src/phase/fileSymbols.ts`, which re-homes metrics from `src/analyzers/universal/UniversalSOLIDAnalyzer.ts` and the concern classifier from `src/analyzers/universal/functionConcerns.ts`. Canonical messages/thresholds/samples live in `RULE_REGISTRY` (`META = RULE_REGISTRY`, solid.ts:215). Seven rules declare `{formats:['typescript','tsx','javascript'], facts:['file-symbols']}`; `interface-size` adds `'go'` + `'type-declarations'`. `visibleSymbols` drops test files (`skipTestFiles`, solid.ts:100-103).

### `solid/class-size` (1)

- **Claim** (registry): `Class "{name}" has {methods} methods, exceeding the maximum of {max}. Consider splitting into smaller classes.` (`ruleRegistry.ts:128`). The emitted message at solid.ts:243 inlines the same prose with `cls.methodCount`; a **second** emitted variant (aggregate complexity) at solid.ts:258 has **no registry equivalent**.
- **Firing condition**: `if (cls.methodCount > methodsThreshold)` (solid.ts:240) and `if (cls.aggregateComplexity > maxAggregate)` (solid.ts:255). `methodsThreshold = num(thresholds,'classMethodsThreshold', num(thresholds,'maxMethodsPerClass',20))` (:231); `maxAggregate = num(thresholds,'classAggregateComplexity',150)` (:232). Iterates `s.kind === 'class'` (:235) only.
- **Input position**: `file-symbols` → `FileClassSymbol.methodCount` (fileSymbols.ts:119) / `.aggregateComplexity` (:109) → `adapter.extractClasses` → `class_declaration`/`abstract_class_declaration`; `methodCount = cls.methods.length`, methods from `buildClassMembers` counting **only `method_definition`** (TreeSitterTypeScriptAdapter.ts:602-626). `aggregateComplexity = Σ method complexity`.
- **Grammar checklist** (`class_body` children): `abstract_method_signature`, `class_static_block`, `index_signature`, `method_definition`, `method_signature`, `public_field_definition`.
- **Coverage**: handled = `method_definition`. mishandled = `abstract_method_signature`/`method_signature` **never counted** (abstract/interface-like class under-reports). correctly-excluded = `public_field_definition` (property), `class_static_block`, `index_signature`.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:125-143`); parity = `spec68-solid-parity.spec.ts:85-103`; fixture = `src/analyzers/__tests__/fixtures/spec-17/twenty-methods-vs-complex.ts`; baseline = `corpus-baselines.md` `solid::solid/class-size` (479, 928, 970); ledger = `rule-authenticity-ledger.md:39`, `rule-replacement-ledger.md` Session 6 (505-570), `severity-assignment-ledger.md:80`.

### `solid/method-complexity` (2)

- **Claim** (registry): `Method "{name}" has cyclomatic complexity {complexity}, exceeding the maximum of {max}.` (`ruleRegistry.ts:147`). Two emitted forms: standalone function (solid.ts:296, name = bare `f.name`) and class method (solid.ts:306, `cls.name + '.' + m.name`).
- **Firing condition**: `max = num(thresholds,'maxMethodComplexity',50)` (:288); `if (f.complexity > max)` for `kind==='function'` (:293); `if (m.complexity > max)` per class method (:303).
- **Input position**: `file-symbols` → `FileFunctionSymbol.complexity`/`FileMethodSymbol.complexity` → `adapter.getComplexity` = `calculateCyclomaticComplexity` (base 1, +1 per if/for/for_in/while/do/switch_case/ternary/catch, +1 per `&&`/`||`).
- **Grammar checklist** (`extractFunctions`, TreeSitterTypeScriptAdapter.ts:920-941): `function_declaration`, `generator_function_declaration`, `function_expression`, `arrow_function`, `method_definition`.
- **Coverage**: handled = `function_declaration`, `method_definition` (+ generator/expression/arrow as standalone). never-seen = `generator_function_expression` (missing from `extractFunctions` list); `method_signature`/`abstract_method_signature` correctly excluded (no body).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:144-159`); parity = `spec68-solid-parity.spec.ts:105-113`; fixture = `twenty-methods-vs-complex.ts`; baseline = `solid::solid/method-complexity` (249, 492, 905, 951, 1025); ledger = `rule-authenticity-ledger.md:40`, `severity-assignment-ledger.md:81`.

### `solid/open-closed` (3)

- **Claim** (registry): `Class "{name}" uses instanceof against a user-defined type.` (`ruleRegistry.ts:163`). Emitted message (solid.ts:374) appends "Consider composition or inheritance for extension."
- **Firing condition**: producer regex `/\binstanceof\s+([A-Za-z_$][\w$]*)/` over each `binary_expression` node text; `if (m && !BUILTIN_TYPES.has(m[1])) targets.add(m[1])` (fileSymbols.ts:327-331). Rule side: `domainTargets = cls.instanceofTargets.filter(t => !isErrorSubclass(t, classes))` (solid.ts:370); fire when non-empty. `isErrorSubclass` walks `extends` chain against `BUILTIN_ERRORS`.
- **Input position**: `file-symbols` → `FileClassSymbol.instanceofTargets` (fileSymbols.ts:121) → `extractInstanceofTargets` walking the class node for `binary_expression` operator `instanceof`. Source region = **raw text of the `binary_expression` node** (regex over `adapter.getNodeText`, not the operator field) — a List-A pattern.
- **Grammar checklist** (`binary_expression` operator field enum): `!= !== % & && * ** + - / < << <= == === > >= >> >>> ?? ^ in instanceof | ||`.
- **Coverage**: handled = plain `x instanceof Identifier`. mishandled = `x instanceof Foo.Bar` captures only `Foo` (regex stops at `.`); parenthesized target `(Foo)` not matched; text containing `instanceof` further right (`a && b instanceof C`) still matches (whole-node scan). never-seen = none (no non-binary `instanceof` position).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:160-174`); parity = `spec68-solid-parity.spec.ts:115-123`; fixture = `spec-17/node-type-regression.ts` (R8 guard); baseline = `solid::solid/open-closed` (972, 1018); ledger = `rule-authenticity-ledger.md:41`, `rule-replacement-ledger.md` Session 10 (834-911), `severity-assignment-ledger.md:82`.

### `solid/single-responsibility` (4)

- **Claim** (registry): `Function "{name}" mixes unrelated responsibilities. Split it into one function per concern.` (`ruleRegistry.ts:178`). Emitted message (solid.ts:401) instead reads `Function "{fn.name}" mixes ${groups.length} unrelated concerns (${labels})…`.
- **Firing condition**: `groups = fn.concernGroups; if (groups.length < 2) continue;` (solid.ts:396-397). `concernGroups = votingConcerns(detectFunctionConcerns(...))` restricted to `VOTING_CONCERNS` (functionConcerns.ts:59-68). `detectFunctionConcerns` walks `call_expression`, skips `NESTED_FUNCTION_TYPES`, classifies each callee by name: messaging → logging (or receiver `logger`) → rendering → `BARE_DATA_VERBS` or `name.startsWith('fetch')` → receiver-gated `DATA_VERBS` → `TRANSFORM_VERBS`.
- **Input position**: `file-symbols` → `concernGroups` (fileSymbols.ts:100-102,135-137) → `call_expression` callee (`node.children?.[0]`), trailing-identifier + receiver substring over callee source text — a List-A pattern.
- **Grammar checklist** (`call_expression` fields): `function: expression | import`; `arguments: arguments | template_string`; `type_arguments: type_arguments`.
- **Coverage**: handled = `member_expression` callee (`db.find`, `sendEmail`) + bare `identifier`; nested closures skipped. mishandled = IIFE `(fn)()`, computed `obj[key]()`, chained `factory()()`; `new Foo()` is `new_expression` not `call_expression` so constructors never classified. never-seen = `super.method()` (callee `super` not a `member_expression`).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:175-193`); parity = `spec68-solid-parity.spec.ts:125-133`; fixture = **ABSENT**; baseline = **ABSENT** (no `single-responsibility` in corpus-baselines.md); ledger = `rule-authenticity-ledger.md:42` (old size-proxy row), `rule-replacement-ledger.md` Session 1 (9-78) + Follow-up (191-248) + Session 34 (2745-2791), `severity-assignment-ledger.md:83`.

### `function-length` (5)

- **Claim** (registry): `Function "{name}" has {lines} lines, exceeding the maximum of {max}. Consider breaking it down.` (`ruleRegistry.ts:198`).
- **Firing condition**: `thresholdKey: 'maxLinesPerMethod'`, `fallback: 200`, `measure: fn => fn.lineCount` (solid.ts:420-422); shared loop fires when `measure(fn) > max`.
- **Input position**: `file-symbols` → `lineCount` = `location.end.line - location.start.line + 1` (fileSymbols.ts:151 / method :97).
- **Grammar checklist**: `function_declaration`, `generator_function_declaration`, `function_expression`, `arrow_function`, `method_definition`.
- **Coverage**: handled = all five. never-seen = `generator_function_expression`; `method_signature`/`abstract_method_signature` correctly excluded (no body). Single-line `arrow_function` expression bodies still produce a span.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:195-213`); parity = `spec68-solid-parity.spec.ts:135-143`; fixture = **ABSENT**; baseline = `solid::function-length` (240, 471, 899, 946, 974, 1015, 1036); ledger = `rule-replacement-ledger.md` Session 1 (20-32), `severity-assignment-ledger.md:84`.

### `parameter-count` (6)

- **Claim** (registry): `Function "{name}" has {params} parameters, exceeding the maximum of {max}. Consider using an options object.` (`ruleRegistry.ts:217`).
- **Firing condition**: `thresholdKey: 'maxParametersPerMethod'`, `fallback: 6`, `measure: fn => fn.parameterCount` (solid.ts:437-439); fires when `measure(fn) > max` after the name-level exemption `!(fn.name in exemptions)` (solid.ts:205).
- **Input position**: `file-symbols` → `parameterCount` = `parameters.length` (fileSymbols.ts:149 / method :95) → `formal_parameters`.
- **Grammar checklist**: `formal_parameters` (every function-like carries a `parameters: formal_parameters` field). Destructured params (`object_pattern`/`array_pattern`) count as one each.
- **Coverage**: handled = ordinary `identifier` params. mishandled = destructured `{ a, b }` counts as 1 not N; rest `...args` counts 1. never-seen = interface `method_signature` params. Single exemption `accumulateBrandes` (solid.ts:448-456).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:214-232`); parity = `spec68-solid-parity.spec.ts:145-153`; fixture = **ABSENT**; baseline = `solid::parameter-count` (245, 475, 917); ledger = `rule-replacement-ledger.md` Session 1 (41-51), `severity-assignment-ledger.md:85`.

### `interface-size` (7)

- **Claim** (registry): `Interface "{name}" has many members.` (`ruleRegistry.ts:236`). TS arm (solid.ts:481) inlines `has ${iface.memberCount} members, exceeding the maximum of ${max}…`; Go arm (:492) `methods… exceeding the maximum of 10`.
- **Firing condition**: TS `max = num(thresholds,'maxInterfaceMembers',25)` (:474); `if (!iface.hasMethodMembers || iface.memberCount <= max) continue;` (:478). Go `if (decl.methodCount <= 10) continue;` (:489). Requires `hasMethodMembers`, so property-only (data-shape) interfaces are exempt.
- **Input position**: TS — `file-symbols` → `FileInterfaceSymbol.memberCount`/`hasMethodMembers` (fileSymbols.ts:71-72) → `adapter.extractInterfaces` → `interface_declaration`; members via `buildInterfaceMembers` counting **only `method_signature` + `property_signature`** (TreeSitterTypeScriptAdapter.ts:821-836). Go — `type-declarations` → `decl.methodCount`.
- **Grammar checklist** (`interface_body` children): `call_signature`, `construct_signature`, `export_statement`, `index_signature`, `method_signature`, `property_signature`.
- **Coverage**: handled = `method_signature` (method-bearing) + `property_signature` (counts to memberCount, not `hasMethodMembers`). never-seen = `call_signature` (callable), `construct_signature` (constructable), `index_signature` (dictionary) — none counted, so many-signature callable/constructable/indexed interfaces under-report (and may exempt entirely via `hasMethodMembers: false`).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:233-248`); parity = `spec68-solid-parity.spec.ts:155-163`; fixture = **ABSENT**; baseline = `solid::interface-size` (483, 929, 977); ledger = `rule-authenticity-ledger.md:43` (interface-segregation row), `rule-replacement-ledger.md` Session 3 (266-333), `severity-assignment-ledger.md:86`.

## Go metrics (8–16)

Nine rules over Go facts produced by `src/phase/goFunctions.ts`, `goFunctionAnalysis.ts`, `goSwitches.ts`, `typeDeclarations.ts`, `goImports.ts`. Rule bodies in `src/phase/rules/goRules.ts` (seven) and `src/phase/rules/solid.ts` (`switch-size`, `function-size`, `struct-size` — solid.ts:518/547/574). **No rule's `analyze(ctx)` firing condition is a regex over raw text** — all are pure comparisons over located facts. Every Go producer skips `*_test.go` via `isTestFile('go', file.file)`.

### `switch-size` (8)

- **Claim** (registry): `Switch or type switch has many case clauses.` (`ruleRegistry.ts:258`).
- **Firing condition**: `solid.ts:574` — `if (sw.caseCount <= 8) continue;` → fires when `caseCount > 8`. `caseCount` in `goSwitches.ts:40-46`: `expression_switch_statement` counts direct `expression_case`/`default_case` children; `type_switch_statement` counts `type_case`/`default_case`. Whole-file walk, nested switches inspected independently. Test files skipped (`goSwitches.ts:32`).
- **Input position**: `go-switches` → `caseCount`/`kind` → `expression_switch_statement`/`type_switch_statement` (direct case children); `line` = switch keyword line.
- **Grammar checklist**: `expression_switch_statement` children `[default_case, expression_case]` (fields `initializer:_simple_statement`, `value:_expression`); `type_switch_statement` children `[default_case, type_case]` (`alias:expression_list`, `initializer`, `value:_expression` required); `expression_case` field `value:expression_list`; `type_case` field `type:_type` (multiple); `default_case` no fields.
- **Coverage**: handled = `expression_case`/`type_case`/`default_case` (default included). Not read = `value`/`initializer`/`alias` fields. never-seen = none (the two switch node types exhaust the container set).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:262-272`); parity = **ABSENT** (spec68-solid-parity.spec.ts:65-83 only *lists* it; pin deferred to `spec68-go-function-switch-parity.spec.ts` which **does not exist**); fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:29-30`, `rule-replacement-ledger.md:336`, `severity-assignment-ledger.md:88`.

### `function-size` (9)

- **Claim** (registry): `Function has many parameters, multiple returns, and high complexity.` (`ruleRegistry.ts:277`).
- **Firing condition**: `solid.ts:547` — `if (!(fn.complexity > 20 && fn.returnCount > 2 && fn.parameterCount > 6)) continue;` (AND of all three). `complexity` = base 1 + one per `COMPLEXITY_NODES` (`goFunctions.ts:48-64`); `returnCount` = result entries (:81-87); `parameterCount` = expanded `parameter_declaration` identifier count (:68-77). Test files + `Test`/`Benchmark`/`Example`/`Fuzz` funcs skipped (:126,136).
- **Input position**: `go-functions` → `complexity`/`returnCount`/`parameterCount` → `function_declaration`/`method_declaration` subtree.
- **Grammar checklist**: `function_declaration` (`name:identifier` required, `parameters:parameter_list` required, `result:_simple_type|parameter_list`, `body:block`, `type_parameters`); `method_declaration` (`name:field_identifier`, `receiver:parameter_list` required, `parameters`, `result`, `body`); `parameter_list` children `[parameter_declaration, variadic_parameter_declaration]`; `parameter_declaration` field `name:identifier` (multiple), `type:_type`; complexity nodes = if/for/expression_switch/type_switch/expression_case/type_case/default_case.
- **Coverage**: handled = `identifier`/`field_identifier` name, `parameter_declaration` (names.length else 1), parenthesised result, complexity nodes. **mishandled = `variadic_parameter_declaration` never counted** — `parameterCountOf` filters `decl.type !== 'parameter_declaration'`, so `func f(a ...int)` contributes 0 params (not 1) and `func f(a int, b ...string)` counts 1 (not 2). Single-type result counts 1; result `parameter_list` counts only `parameter_declaration` children.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:281-291`); parity = **ABSENT** (deferred to nonexistent `spec68-go-function-switch-parity.spec.ts`); fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:27`, `rule-replacement-ledger.md:576`, `severity-assignment-ledger.md:89`.

### `struct-size` (10)

- **Claim** (registry): `Struct has many fields.` (`ruleRegistry.ts:296`).
- **Firing condition**: `solid.ts:518` — `if (decl.fieldCount <= 15) continue;` → fires when `fieldCount > 15`. `fieldCount` = expanded `field_identifier` count (`typeDeclarations.ts:32-42`): per `field_declaration`, `names.length > 0 ? names.length : 1` (embedded name-less field counts 1). Only named `type_spec` declarations; anonymous `struct{...}` literals absent.
- **Input position**: `type-declarations` → `fieldCount` → `type_spec` → `struct_type` → `field_declaration_list` → `field_declaration` → `field_identifier`.
- **Grammar checklist**: `type_spec` (`name:type_identifier` required, `type:_type` required, `type_parameters`); `struct_type` children `[field_declaration_list]`; `field_declaration` (`name:field_identifier` multiple/optional, `type:_type|generic_type|qualified_type|type_identifier`, `tag:interpreted_string_literal|raw_string_literal`).
- **Coverage**: handled = `field_identifier` (expanded) + embedded name-less counted 1. never-seen = field `type`/`tag` not read. `interface_type` arm handled by `interface-size`, not this rule.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:300-310`); parity = **ABSENT**; fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:28`, `rule-replacement-ledger.md:576`, `severity-assignment-ledger.md:90`.

### `liskov-substitution` (11)

- **Claim** (registry): `Method calls panic().` (`ruleRegistry.ts:315`).
- **Firing condition**: `solid.ts:604` — `if (!fn.isMethod || !fn.callsPanic) continue;` → fires only on a `method_declaration` whose body has a `call_expression` whose **direct `identifier` child is `panic`** (`goFunctions.ts:90-98`). `foo.panic()` (`selector_expression`) does not trip it. Free functions never fire. Test functions excluded.
- **Input position**: `go-functions` → `isMethod`/`callsPanic` → `method_declaration` subtree → `call_expression` → `function:_expression` direct child `identifier` text `panic`.
- **Grammar checklist**: `call_expression` (`function:_expression`, `arguments:argument_list` required, `type_arguments`); `_expression` subtypes include `identifier`, `selector_expression`, `parenthesized_expression`, `unary_expression`, `call_expression`, `index_expression`.
- **Coverage**: handled = direct `identifier` `panic`. never-seen/mishandled = `foo.panic()` (selector) correctly not flagged (matches Go binary `call.Fun` = bare `*ast.Ident`); `panic` via `parenthesized_expression` not flagged.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:318-328`); parity = **ABSENT** (spec68-solid-parity.spec.ts:68-82 lists only; `composite-fixtures.spec.ts:131` exercises the *TS* `solid/liskov-substitution`; nearMissExecutor.spec.ts:317 defers to nonexistent `goDishonestRules.spec.ts`); fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:31`, `severity-assignment-ledger.md:91`, `rule-replacement-ledger.md:2732`.

### `channel-deadlock` (12)

- **Claim** (registry): `Guaranteed deadlock: an unbuffered channel is both sent to and received from in the same goroutine.` (`ruleRegistry.ts:339`).
- **Firing condition**: `goRules.ts:252-254` — `if (fn.hasGo) continue;` then `if ((fn.ops[name] ?? 0) >= 2)` for each `name` in `fn.unbuffered` → fires on an unbuffered channel (`make(chan T)` single arg) with ≥2 send/receive ops and **no** `go` statement. Producer `goFunctionAnalysis.ts:245-294`; `isUnbufferedMakeChan` = `call_expression` named `make` + single `channel_type` arg; ops per bare-`identifier` channel via `send_statement.channel` + `unary_expression` with `<-` prefix.
- **Input position**: `channel-operations` → `hasGo`/`unbuffered[]`/`ops{}` → block body: `go_statement`; `short_var_declaration`/`assignment_statement` RHS `make(chan T)`; `send_statement`; `unary_expression` (receive `<-`).
- **Grammar checklist**: `go_statement` child `_expression`; `short_var_declaration`/`assignment_statement` (`left`/`right:expression_list`); `send_statement` (`channel`/`value:_expression`); `unary_expression` (`operand`, `operator` includes `<-`); `call_expression` + `channel_type` (`value:_type`).
- **Coverage**: handled = `go_statement`, single-arg `make(chan T)`, send/receive on bare `identifier` channel. never-seen = buffered `make(chan T, N)` (2 args) and explicit-zero `make(chan T, 0)` excluded (only 1-arg form); channel via `selector_expression`/`index_expression` never counted; receive in a `select` not counted.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:343-353`); parity = **ABSENT** (nearMissExecutor.spec.ts:318 defers to nonexistent `goChannelDeadlock.spec.ts`); fixture = **ABSENT** in fixtures dirs (only `bench/corpus/mixed-go-ts/src/deadlock.go`, asserted by spec66-r3 integration not `expected.json`); baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:37`, `rule-replacement-ledger.md:744`, `severity-assignment-ledger.md:330`.

### `error-handling` (13)

- **Claim** (registry): `Function assigns an error that is never checked, returned, or propagated.` (`ruleRegistry.ts:358`).
- **Firing condition**: `goRules.ts:182-196` — for each `err` binding position (sorted `assignPositions`), `drops = true` iff no `checkPositions` entry falls strictly after that assign and before the next assign (`check > assign && check < upper`). Fires once per function if any assign is dropped. Producer `goFunctionAnalysis.ts:115-181`: assigns = `err` on LHS of `short_var_declaration`/`assignment_statement` whose RHS has a `call_expression`; checks = `err != nil`/`err == nil`, `_ = err`, `return err`, bare `return` when `hasNamedErr`, `err` as call arg. Positions are byte offsets (`range[0]`).
- **Input position**: `error-bindings` → `assignPositions[]`/`checkPositions[]`/`hasNamedErr` → `short_var_declaration`/`assignment_statement` (LHS `err`), `binary_expression` (`==`/`!=`), `return_statement` (`expression_list`), `call_expression` (`argument_list`).
- **Grammar checklist**: `short_var_declaration` (`left`/`right:expression_list`); `assignment_statement` (+`operator`); `binary_expression` (`left`/`right:_expression`, `operator` incl `==`/`!=`); `return_statement` child `expression_list`; `call_expression` field `arguments:argument_list`; `argument_list` children `_expression`/`_type`/`variadic_argument`.
- **Coverage**: handled = `err` from call, `==`/`!=` compare, `return err`, bare `return` (named-`err`), `err` as call arg, `_ = err`. never-seen = `err` compared with any non-`==`/`!=` operator; `err.Error()` as call arg (call-arg arm matches only bare `identifier`, not `selector_expression`); `return fmt.Errorf("...%w", err)` IS covered (call-arg arm).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:362-372`); parity = **ABSENT** (`errorHandlingShape.spec.ts` tests TS `conventions/error-handling`, not this rule); fixture = **ABSENT**; baseline = **ABSENT** (corpus-baselines.md:243/904 and baseline.json:97 are `conventions/error-handling`); ledger = `rule-authenticity-ledger.md:35`, `severity-assignment-ledger.md:328`.

### `concurrency` (14)

- **Claim** (registry): `Function launches a goroutine without synchronization.` (`ruleRegistry.ts:377`).
- **Firing condition**: `goRules.ts:224` — `if (!fn.hasGo || fn.hasSync) continue;` → fires when `hasGo && !hasSync`. Producer `goFunctionAnalysis.ts:202-224`: `hasGo` = any `go_statement`; `hasSync` = any `send_statement`, `unary_expression` whose raw text `trimStart().startsWith('<-')`, or `selector_expression` whose `field_identifier` ∈ `SYNC_METHOD_NAMES`.
- **Input position**: `concurrency-primitives` → `hasGo`/`hasSync` → `go_statement`; `send_statement`; `unary_expression`; `selector_expression`.
- **Grammar checklist**: `go_statement` child `_expression`; `send_statement` (`channel`/`value`); `unary_expression` (`operand`, `operator` incl `<-`); `selector_expression` (`operand`, `field:field_identifier` required).
- **Coverage**: handled = `go_statement`, `send_statement`, `<-` receive, sync-method selectors. never-seen = sync via `select` statements, `sync.Once`/`sync.Cond`/`atomic.*`; `<-ch` receive on non-`unary_expression` form not counted. The `<-` check is a raw-text prefix (`trimStart().startsWith('<-')`) — a source-region pattern, see List A.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:381-391`); parity = **ABSENT** (nearMissExecutor.spec.ts:320 → nonexistent `goDishonestRules.spec.ts`); fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:36`, `severity-assignment-ledger.md:329`.

### `import-organization` (15)

- **Claim** (registry): `Import block mixes standard library and third-party imports without grouping.` (`ruleRegistry.ts:396`).
- **Firing condition**: `goRules.ts:106-131` — groups imports per file in source order, flags the **first** import whose group drops below the running max: `importGroup(imp.source)` = `2` if `path.startsWith('.')` (local), `1` if first `/`-segment contains `.` (third-party), else `0` (stdlib) (`goRules.ts:78-82`); fires when `g < maxGroup` (:120). TS imports skipped via `imp.alias === undefined` (:108). One finding per file.
- **Input position**: `imports` → `source`/`alias` → `import_spec` (`path` field text, unquoted; source order preserved by `goImports.ts:38-66`).
- **Grammar checklist**: `import_spec` (`name:blank_identifier|dot|package_identifier` optional, `path:interpreted_string_literal|raw_string_literal` required).
- **Coverage**: handled = `path` text classification (stdlib/third-party/local by first segment). mishandled = local module-path without leading `.` (e.g. `example.com/org/x`) classified third-party; only `./`/`../` count as "local"; `name`/alias not read.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:400-410`); parity = **ABSENT** (nearMissExecutor.spec.ts:321 → nonexistent `goImportOrganization.spec.ts`); fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:33`, `rule-replacement-ledger.md:658`, `severity-assignment-ledger.md:326`.

### `import-style` (16)

- **Claim** (registry): `Dot import detected — can lead to namespace pollution.` (`ruleRegistry.ts:415`).
- **Firing condition**: `goRules.ts:153` — `if (imp.alias !== '.') continue;` → fires on every import with `alias === '.'`. Producer `goImports.ts:44-58` maps `dot`→`.`, `package_identifier`→name, `blank_identifier`→`_`, unnamed→`null`. TS imports (`alias === undefined`) skipped.
- **Input position**: `imports` → `alias` → `import_spec` → `name` field `dot` (or `package_identifier`/`blank_identifier`).
- **Grammar checklist**: `import_spec` field `name:blank_identifier|dot|package_identifier`.
- **Coverage**: handled = `dot`→`.` only. never-seen = named/blank/unnamed aliases all correctly skipped (not dot imports).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:419-429`); parity = **ABSENT** (nearMissExecutor.spec.ts:322 → nonexistent `goImportOrganization.spec.ts`); fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:34`, `rule-replacement-ledger.md:689,700`, `severity-assignment-ledger.md:327`.

### `solid/liskov-substitution` (17)

- **Claim** (registry): `Method "{name}" overrides a parent method and throws where the parent does not.` (`ruleRegistry.ts:434`). Emitted message (solid.ts:646) appends "Callers of the parent contract cannot handle it."
- **Firing condition**: `if (!cls.extends) continue;` (:632); within-file parent `classes.find(c => c.file === cls.file && c.name === cls.extends)` (:635); `if (!parent) continue;` (:636); skip `constructor` (:640); `if (m.throws && !parentMethod.throws)` (:643). `m.throws = nodeThrows` (full-subtree walk for `throw_statement`, fileSymbols.ts:163-169).
- **Input position**: `file-symbols` → `FileClassSymbol.extends` (fileSymbols.ts:118) + `FileMethodSymbol.throws` (:99) → `throw_statement` anywhere in the `method_definition` subtree.
- **Grammar checklist** (`throw_statement`): `expression`, `sequence_expression` (thrown operand); method `body` = `statement_block`.
- **Coverage**: handled = direct `throw new Error(...)`. mishandled = `throw` inside a nested closure still marks the method throwing (nodeThrows does not stop at nested functions); only boolean "throws" compared, never thrown types. never-seen = **cross-file parent** — `parent` is `undefined` (within-file `classes.find` only), so cross-file `extends` never fires (documented `blocked` pending a type resolver).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:431-445`); parity = `spec68-solid-parity.spec.ts:165-173`; fixture = `spec-17/node-type-regression.ts` (R8 guard); baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:44`, `rule-replacement-ledger.md` Session 11 (918-995), `severity-assignment-ledger.md:87`.

## dry (18–23)

Six rules over `code-block`, `string-literals`, `imports`, and `clone-pair-history` facts. Rule bodies in `src/phase/rules/dry.ts`; block/fragment producers in `src/phase/codeBlocks.ts`. Two of the six (`dry/duplicate`, `dry/structural-similarity`) are source-region patterns (List A); the rest are located-fact relations.

### `dry/duplicate` (18)

- **Claim** (registry): `Duplicate code block detected ({lines} lines). First occurrence at {file}:{line}.` (`ruleRegistry.ts:450`).
- **Firing condition**: `detectExactDuplicates` (`dry.ts:464-504`). `minLine = cfg.minLineThreshold || 5` (:465); `large = blocks.filter(b => b.lineCount >= minLine)` (:466); `deduplicateBlocks` (:467); group by `block.hash` (:469-474); `if (group.length < 2) continue;` (:478); per later block `if (spansOverlap(original, block)) continue;` (:483); fires per repeat anchored at the LATER block. `hash = hashCode(normalizeCode(block.text))` — SHA256 (`codeBlocks.ts:97-99`) over `normalizeCode` (:80-88: trim lines, strip `//` and `/* */` comments).
- **Input position**: `code-block` (kind `block`) → `hash`/`text`/`lineCount`/`start`/`end` → arbitrary source region (block span), not a single node type. Produced by `extractBlocks` (`codeBlocks.ts:193-215`).
- **Grammar checklist**: block-producing productions — `function_declaration`, `generator_function_declaration`, `function_expression`, `arrow_function`, `method_definition` (extractFunctions); `class_declaration`, `abstract_class_declaration` + `method_definition` children (extractClasses); `if_statement` (`parenthesized_expression` condition, `statement` consequence, `else_clause`), `for_statement`, `for_in_statement`, `while_statement`, `do_statement`, `switch_statement` (`switch_body`), `try_statement` (`statement_block`, `catch_clause`, `finally_clause`) via `isSignificantBlockType`.
- **Coverage**: handled = the 14 forms; `normalizeCode` strips comments+whitespace so those differences still hash equal. mishandled = `generator_function_expression` referenced by `isFunction` (TreeSitterTypeScriptAdapter.ts:999-1007) but **absent from the loaded grammar** (phantom — generator expression never produced as a block); blocks differing only in identifiers do NOT hash equal (identifiers kept by `normalizeCode`) — that shape is `dry/structural-similarity`'s job. never-seen = under `minLineThreshold` (default 15, floor 5), single-occurrence hashes, test/spec files, cross-file (per-file grouping).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:452-467`); parity = `spec68-dry-block-parity.spec.ts:74-98,196-216`; fixture = `bench/corpus/dry/` (src/duplicates.ts + src/unique.ts, expected.json `dry/duplicate`); baseline = `bench/baselines/baseline.json:36` (f1 1.0) + `corpus-baselines.md:923` (recall-protocol, count 6); ledger = `rule-authenticity-ledger.md:119,186`, `rule-replacement-ledger.md:2389`, `severity-assignment-ledger.md:128`.

### `dry/structural-similarity` (19)

- **Claim** (registry): `Structurally similar code block detected ({similarity}% similar to {file}:{line}).` (`ruleRegistry.ts:473`).
- **Firing condition**: `detectStructuralDuplicates` (`dry.ts:507-540`). `minLine = cfg.minLineThreshold || 5`; `threshold = cfg.similarityThreshold ?? 0.85` (:509); pairwise over deduped blocks; skip `original.hash === block.hash` (:518); skip overlap (:519); `similarity = computeJaccardSimilarity(original.structuralSkeleton, block.structuralSkeleton)` (:521-523); `if (similarity < threshold) continue;` (:524). `computeJaccardSimilarity` (dry.ts:300-311) = Jaccard over token **bigrams** (`tokenBigrams`, :287-293). Skeleton = `normalizeCodeForStructure` (`codeBlocks.ts:91-94` = `normalizeCode` + `normalizeStructure`: identifiers→`ID`, literals→`LIT`, 50-entry `keywords` kept).
- **Input position**: `code-block` → `structuralSkeleton` → arbitrary source region reduced to a token-kind skeleton (same 14 forms as `dry/duplicate`).
- **Grammar checklist**: same 14 block productions; the skeleton is a text transform of those regions.
- **Coverage**: handled = the 14 forms; bigram Jaccard is order- and frequency-aware. mishandled = exact hash-equal pairs skipped (go to `dry/duplicate`); identifier/literal content erased to `ID`/`LIT`. **Comparator divergence**: the migrated comparator is bigram-based; the legacy `UniversalDRYAnalyzer.computeJaccardSimilarity` (:577-588) is token-**set**-based. never-seen = under `minLine`, similarity <0.85, test/spec files, cross-file. `checkStructuralSimilarity` default is `false` (`dry.ts:231`) but §10 removed it as a gate — fires unconditionally now (parity :158-193).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:476-489`); parity = `spec68-dry-block-parity.spec.ts:107-133,158-193`; fixture = **ABSENT** (bench `dry` expected.json lists only `dry/duplicate`); baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:120,186`, `rule-replacement-ledger.md:2156,2612`, `severity-assignment-ledger.md:129`.

### `dry/similar-expression` (20)

- **Claim** (registry): `Near-identical expression detected ({shared} shared {unit}: {names}). First occurrence at {file}:{line}.` (`ruleRegistry.ts:495`).
- **Firing condition**: `detectExpressionSimilarities` (`dry.ts:574-603`). `min = cfg.minShapeNames || 4` (:575); drop `f.names.length < min` (:582); drop `fragmentKind === 'chain' && isFluentChain(f.names)` (:583); `dedupeShapeFragments` (:586); pairwise only same `fragmentKind` (:593) AND same `target` (:594); `shared = longestCommonSubsequence(names, names)` (:595, LCS :378-402); `if (shared.length < min) continue;` (:596); each later fragment once. `names` from `objectFieldNames` (`codeBlocks.ts:229-244`: `pair` key + `shorthand_property_identifier`) or `callChainMethodNames` (:247-265: `call_expression`→`member_expression`→`property_identifier`).
- **Input position**: `code-block` (kind `fragment`, `fragmentKind` 'object'|'chain') → `names`/`target` → `object` literal node (objects) or `call_expression` node (chains).
- **Grammar checklist**: object position = `object` (children `method_definition`, `pair`, `shorthand_property_identifier`, `spread_element`); `pair` key = `computed_property_name`|`number`|`private_property_identifier`|`property_identifier`|`string`, value = `expression`. chain position = `call_expression` (function `expression`|`import`, arguments `arguments`|`template_string`, `type_arguments`) via `member_expression` (object, property `private_property_identifier`|`property_identifier`, `optional_chain`).
- **Coverage**: handled = object literals that are a direct `variable_declarator`/`assignment_expression` value (extractFragments :273-317) + call chains of `member_expression.property_identifier`. mishandled = `object` children `method_definition`/`spread_element` ignored; `pair` with computed/number/string/private keys yields raw text; chain callee must be `member_expression` with `property_identifier` — `obj.#m()`, `obj['m']()`, `optional_chain`/parenthesized callees break the walk. never-seen = objects NOT directly a declarator/assignment value (e.g. `pgTable('users', {...})` args — intentionally silent), fluent chains, <4 names, different-target objects, test/spec files.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:503-523`); parity = `dry-similar-expression.spec.ts` + `spec68-dry-block-parity.spec.ts:136-148`; fixture = **ABSENT**; baseline = `corpus-baselines.md:250` (count 4), :909 (21), :955 (5), :982 (1); ledger = `severity-assignment-ledger.md:130` (no authenticity/replacement row — the §133 default-on rule).

### `dry/diverging-clone` (21)

- **Claim** (registry): `Clone pair has diverged: similarity dropped {drop} (from {previous} to {current}) across {runs} consecutive runs. Review {file1}:{line1} and {file2}:{line2} for diverged logic.` (`ruleRegistry.ts:531`).
- **Firing condition**: `detectDivergingClone` (`dry.ts:628-663`). `threshold = cfg.divergenceThreshold ?? 0.05` (:629); `requiredDeclines = cfg.divergenceRuns ?? 2` (:630); `if (threshold <= 0) return [];` (:631); per fingerprint group `if (rows.length < requiredDeclines + 1) continue;` (:636); check last `requiredDeclines` consecutive pairs for strict decline `rows[i].similarity < rows[i-1].similarity - threshold` (:640-644); `if (consecutiveDeclines >= requiredDeclines)` fire (:646), anchored at most-recent row, `symbol` = fingerprint. Emitted message adds `(pair: <fp12>…)` suffix.
- **Input position**: `clone-pair-history` → `rows[].similarity` (timestamp-ordered series) + `file1`/`file2`/`line1`/`line2` → **no AST position**; sourced from SQLite `dry_pair_history` via `CORPUS_PRODUCERS['clone-pair-history']`, grouped by `fingerprint`.
- **Grammar checklist**: N/A — no tree-sitter position; the fact is DB-derived clone-pair history.
- **Coverage**: handled = strict `<` decline over last `requiredDeclines` (default 2) pairs, threshold 0.05. mishandled = `minPairSimilarity` declared (`dry.ts:610-614`) but never read (matches legacy Phase 2). never-seen = `threshold <= 0`, `< requiredDeclines + 1` rows, single decline + recovery, drop exactly at threshold (strict `<`).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:537-544`); parity = `spec68-dry-diverging-clone-parity.spec.ts:135-225`; fixture = `bench/corpus/diverging-clones/` (clone_a.ts + clone_b.ts, expected.json `dry/diverging-clone`); baseline = `bench/baselines/baseline.json:28` (f1 1.0), `corpus-baselines.md` **ABSENT**; ledger = `severity-assignment-ledger.md:133` (and :124 note "(dry/diverging-clone, unregistered)").

### `duplicate-string-literal` (22)

- **Claim** (registry): `String literal "{text}" is duplicated {count} times.` (`ruleRegistry.ts:549`).
- **Firing condition**: `detectDuplicateStringLiteral` (`dry.ts:167-199`). Skip `lit.value.length <= 10` (:170); skip `isNameLiteral(lit.value)` (:171); group by `(file, value)`; `if (locs.length <= 2) continue;` (:185) — needs ≥3 occurrences. `value` = verbatim `getNodeText` including quotes. `isNameLiteral` (:157-164) strips quotes then ORs five regexes (:131-152). Emitted message = `String literal "${value.substring(0,30)}..." is duplicated ${locs.length} times` — carries quotes + 30-char truncation, diverging from the registry placeholders.
- **Input position**: `string-literals` → `value` → `string`/`template_string` nodes (verbatim source text, quotes included); producer `findNodes(ast, {custom: n => n.type === 'string' || n.type === 'template_string'})`.
- **Grammar checklist**: `string` (children `escape_sequence`, `string_fragment`) + `template_string` (children `escape_sequence`, `string_fragment`, `template_substitution`). The grammar also has an **anonymous** `string`; the producer matches by type name so captures both named and anonymous.
- **Coverage**: handled = single/double/backtick literals; `${…}` interpolations captured as one raw value. mishandled = quote-style variants are distinct (`"x"` vs `'x'` don't dedupe); length check counts the two quote chars; `template_substitution` content captured verbatim. never-seen = `length <= 10`, name-literals (vocabulary token/relative module/CLI option/separator-only/dotted-name), ≤2 occurrences, cross-file.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:552-558`); parity = `spec68-dry-strings-parity.spec.ts:72-195`; fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:121,186`, `severity-assignment-ledger.md:131`.

### `duplicate-import` (23)

- **Claim** (registry): `Duplicate import of "{module}".` (`ruleRegistry.ts:564`).
- **Firing condition**: `detectDuplicateImport` (`dry.ts:82-117`). Skip `imp.alias !== undefined` (:90 — marks Go-import facts). Group `imports` by `(file, source)`; `if (locs.length <= 1) continue;` (:104); fires anchored at `locs[0]`. Emitted message diverges from registry: `Module "${source}" is imported ${locs.length} times` (:108). `source` from `buildImportInfo` (TreeSitterTypeScriptAdapter.ts:650-669): `node.childForFieldName('source')`, `sourceNode.text.slice(1,-1)` (strip quotes); `null` if no `source` field.
- **Input position**: `imports` → `source` → `import_statement`'s `source` field (named `string`); anchor from the import statement's `line`/`column`.
- **Grammar checklist**: `import_statement` (fields `source` optional `string`, children `import_clause`, `import_require_clause`, `import_attribute`); source `string` children `escape_sequence`, `string_fragment`.
- **Coverage**: handled = TS/JS `import_statement` with a `source` field (`import`/`import type`/side-effect/`import = require(...)`); side-effect + named imports of the same source still count (parity :125). mishandled = Go imports skipped; registry Claim text ≠ emitted message. never-seen = single occurrence, cross-file duplicates (per-file grouping, parity :136).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:567-570`); parity = `spec68-dry-parity.spec.ts:71-142`; fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:122,186`, `rule-replacement-ledger.md:2253,2612-2613`, `severity-assignment-ledger.md:132`.

## data-access (24–29)

Six rules spanning four fact kinds (`data-access-calls`, `table-catalog`, `string-literals`, `loop-queries`). Four of six (`sql-injection-risk`, `complex-query`, `unfiltered-query`, `missing-org-filter`) live in `src/phase/rules/dataAccess.ts` reading `data-access-calls` (+ `table-catalog` for `missing-org-filter`); `hardcoded-connection` sits in `src/phase/rules/security.ts` reading `string-literals`; `loop-query` is exported separately (`loopQueryRules`) reading `loop-queries`.

### `sql-injection-risk` (24)

- **Claim** (registry): `Potential SQL injection risk in {method}. Use parameterized queries.` (`ruleRegistry.ts:581`).
- **Firing condition**: `dataAccess.ts:174-229` iterates `data-access-calls`, fires on the producer pre-computed flag `if (!call.hasSqlInjectionRisk) continue;` (:188). Severity branches on escape: `call.sqlEscaped` → `'high'` (`Interpolated SQL in ${method} — verify escaping…`, :191-207); else `'critical'` (:208-224). `needs: {formats:['typescript','tsx','javascript','go'], facts:['data-access-calls']}` (:177). The flag is produced in `UniversalDataAccessAnalyzer.ts` from `adapter.getDynamicParts` filtered through `isSafeDynamicPart` (sanitizer allowlist `['escapeSql']`, parameterized `['?',':param','$1','prepared','parameterized']`).
- **Input position**: `data-access-calls` → `hasSqlInjectionRisk`, `sqlEscaped`, `method`, `enclosingFunction`, `file`, `line`, `column`. Source region = interpolation/concatenation operands of the query node (dynamic parts inside `string`/`template_string`/`binary_expression` operands).
- **Grammar checklist**: `call_expression` with `arguments` = `arguments` node (children = any `expression`) or bare `template_string`. Dynamic-part positions: `string` (concat operand), `template_string`→`template_substitution`, `binary_expression` `+` (operands `string`/`identifier`/`template_string`/`call_expression`), `identifier`, `call_expression`. **No `tagged_template` node** — `` sql`…${id}` `` parses as `call_expression(identifier)` with a `template_string` argument.
- **Coverage**: handled = string-concat, template `${}` interpolation, sanitizer-wrapped (`escapeSql`), pre-parameterized chains (`.prepare().bind()`, `.exec()` spread, D1 convenience, db-wrapper). mishandled/partial = no taint/dataflow — resolved-safe constant vs attacker-controlled indistinguishable beyond static checks (ledger "partial"). never-seen = full user-input taint tracking.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:584-593`); parity = `spec68-data-access-parity.spec.ts:71,74` + `spec68-data-access-rules.spec.ts:50-66`; fixture = `spec-19/item-04-real-sql-injection.ts`, `item-07-real-template-injection.ts`, `item-09-playwright-evaluate.ts`, `item-10-const-ternary-table.ts`, `r3-sql-injection-gating.test.ts`, `spec-33/s33-item5-sql-injection.test.ts`, `s33-item6-taint-tracking.test.ts`, `s33-item11-method-name-fp.test.ts`; baseline = `corpus-baselines.md` (49, 200, 254, 675, 713, 716, 915, 975); ledger = `rule-authenticity-ledger.md:45`, `rule-replacement-ledger.md:1563`, `severity-assignment-ledger.md:112,359`; `bench/baselines/baseline.json` = **ABSENT**.

### `missing-org-filter` (25)

- **Claim** (registry): `Query on {tables} has no organization/tenant predicate.` (`ruleRegistry.ts:604`).
- **Firing condition**: `dataAccess.ts:394-488`. Build `buildOrgFilterTierSet({orgFilterTables, orgFilterColumns, schemas}, ddlTableColumns)` (:418-425); map table names through `catalog.aliases` (:436); `if (!tableRequiresOrgFilter(tables, tierSet)) continue;` (:438). Three quiet paths: (a) raw-SQL INSERT — `isRawSqlInsert(call.queryText)` (:440) with `rawInsertColumnList` (:451-456), quiet when `columns === null` (positional) or some column in the tenant set; (b) `else if (call.hasOrganizationFilter) continue;` (:457); (c) `else if (hasUniqueColumnFilter(...)) continue;` (:459-463). Else `'critical'` (:469). `needs: {… facts:['data-access-calls','table-catalog']}` (:397-400).
- **Input position**: `data-access-calls` → `tables`, `queryText`, `hasOrganizationFilter` + `table-catalog` → `tables[].columns`, `uniqueColumns`, `aliases`. Source region = SQL/ORM text (INSERT column list + filter regexes) and per-table column declarations.
- **Grammar checklist**: INSERT column list matched on raw text via `rawInsertColumnList` (`/\bINSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s+\S+\s*\(([^)]*)\)/i` + REPLACE form); predicate via `hasOrganizationFilter` (List A) matching `org_id = ?`/`eq(org_id, v)`/`where({ org_id })`/`where('org_id', x)`. `.go` also declared.
- **Coverage**: handled = read/mutation predicate forms, raw-SQL INSERT column lists, Drizzle/Knex/Prisma predicate forms, bootstrap unique-key suppression, JOIN-on-org rejected. mishandled/partial = no taint proving the PK is attacker-controlled (worker `WHERE id = $1` vs request-reachable `id` fire identically — ledger "partial"). never-seen = id-vs-request-binding distinction.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:607-620`); parity = `spec68-data-access-parity.spec.ts:71`, `spec68-data-access-rules.spec.ts:159-218`, `spec68-missing-org-filter-parity.spec.ts:109-133`; fixture = **ABSENT** (inline DDL + `parity.ts` strings); baseline = `corpus-baselines.md` (200, 818, 826, 948) + `bench/baselines/baseline.json:11,54`; ledger = `rule-authenticity-ledger.md:46,154`, `rule-replacement-ledger.md:2733`, `severity-assignment-ledger.md:108,113,345,417`.

### `complex-query` (26)

- **Claim** (registry): `Query references many tables (join-heavy).` (`ruleRegistry.ts:626`).
- **Firing condition**: `dataAccess.ts:233-264`. `joinedTableCount = num(thresholds,'joinedTableCount',4)` (:246); `if (call.tables.length <= joinedTableCount) continue;` (:249) — fires `'high'` when `call.tables.length > 4`. Emits `Query references ${call.tables.length} tables` (:253). `needs: {formats:['typescript','tsx','javascript','go'], facts:['data-access-calls']}` (:236).
- **Input position**: `data-access-calls` → `tables` (string[]) from `extractTables` (regex — List A), `enclosingFunction`, `method`, `file`, `line`, `column`.
- **Grammar checklist**: `tables` produced by regex over raw text (`FROM`, `JOIN`, `INSERT INTO`, `.from(`, `.selectFrom('…')`, `db.<table>.<verb>(`), so any production whose text contains those spellings contributes a count. `.go` declared.
- **Coverage**: handled = join-heavy table-count. mishandled/partial = subquery ≤4 tables formerly flagged; `hasSubquery`/`hasJoins` computed-but-unwired; replacement ledger marks the subquery-or-many-tables gate now wired (`complexQuery.spec.ts` negative cases :84-94). never-seen = N/A (count-based).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:629-637`); parity = `spec68-data-access-parity.spec.ts:86-128`, `spec68-data-access-rules.spec.ts:71-85`, `complexQuery.spec.ts:78-94`; fixture = filename-only (`item-15-complex-query-builder.ts` referenced at `oracle-rerun.test.ts:210`, no body contains the id); baseline = `corpus-baselines.md` (252, 287, 291, 297, 932); ledger = `rule-authenticity-ledger.md:47,154`, `rule-replacement-ledger.md:1003,1005,1069,2594`, `severity-assignment-ledger.md:114`; `bench/baselines/baseline.json` = **ABSENT**.

### `unfiltered-query` (27)

- **Claim** (registry): `Unfiltered write or tenant-scoped read on {tables} has no WHERE/HAVING/LIMIT.` (`ruleRegistry.ts:642`).
- **Firing condition**: `dataAccess.ts:268-314`. Order: `skipTest = thresholds.skipTestFiles !== false && isTestOrSpecPath(call.file)` → continue (:286); `if (call.tables.length > joinedTableCount) continue;` (:292, Spec 55 R5 — complex-query wins); `isWrite = isUnfilteredWrite(call)` (:294), `isRead = isUnfilteredRead(call, thresholds)` (:295), `if ((!isWrite && !isRead) || call.tables.length === 0) continue;` (:296). Fires `'high'` (:304). `needs: {formats:['typescript','tsx','javascript','go'], facts:['data-access-calls']}` (:271).
- **Input position**: `data-access-calls` → `hasFilter`, `queryText` (candidate node text, comments stripped), `tables`, `file` (test-path gate).
- **Grammar checklist**: classification is regex over raw text — `hasMassWriteVerb` = `/\bUPDATE\s+\S+\s+SET\b/` or `/\bUPDATETABLE\b/`; `isUpsertForm` = `/\bINSERT\s+OR\s+(?:IGNORE|REPLACE)\b/`, `/\bREPLACE\s+INTO\b/`, `/\bON\s+CONFLICT\b/`, `/\bON\s+DUPLICATE\s+KEY\b/`; `hasWriteVerb` = INSERT/DELETE/UPDATE/REPLACE-INTO/DELETEFROM/UPDATETABLE/INSERTINTO; `hasFilter` = `hasQueryFilter` (WHERE-non-tautology/HAVING/LIMIT — List A).
- **Coverage**: handled = unfiltered UPDATE mass-write, filterless tenant-table read, upsert exclusion, bare-DELETE exemption, test-file skip. mishandled/partial = `WHERE 1=1` explicitly excluded via `whereClauseIsTautology`, but filter test is keyword-presence not row-bound analysis (ledger "partial"). never-seen = predicate-level result-set boundedness.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:645-652`); parity = `spec68-data-access-parity.spec.ts:98-116`, `spec68-data-access-rules.spec.ts:90-152`, `unfilteredQuery.spec.ts:136-192`; fixture = **ABSENT** (referenced in `composite-fixtures.spec.ts:83,99` and `corpus-fixtures.spec.ts`); baseline = `corpus-baselines.md` (49, 194, 209, 221, 247, 287, 289, 295, 299, 300, 302, 343, 346, 354, 357, 359, 400, 407, 411, 419, 922) + `bench/baselines/baseline.json:12,57`; ledger = `rule-authenticity-ledger.md:48,154`, `rule-replacement-ledger.md:1076,1078,1146,2595`, `severity-assignment-ledger.md:115,404-418`.

### `hardcoded-connection` (28)

- **Claim** (registry): `Hardcoded database connection string detected.` (`ruleRegistry.ts:658`).
- **Firing condition**: `security.ts:82-94` → `detectHardcodedConnection(ctx.facts['string-literals'])` (:48-80): `if (!isConnectionString(lit.value)) continue;` (:51). `isConnectionString` (:34-43) = `patterns.some(p => p.test(text))` over `[/mongodb:\/\//i, /postgres:\/\//i, /mysql:\/\//i, /Server=.*;Database=/i, /Data Source=.*;Initial Catalog=/i]`. Fires `'critical'` (:68). `needs: {formats:['typescript','tsx','javascript'], facts:['string-literals']}` (:85) — **does not declare `go`**.
- **Input position**: `string-literals` → `value`, `file`, `line`, `column`, `enclosingFunction` → `extractStringLiterals` (`src/phase/stringLiterals.ts`, `node.type === 'string' || 'template_string'`).
- **Grammar checklist**: only two productions can reach this position — `string` and `template_string` (both `primary_expression` subtypes). `.go` not covered.
- **Coverage**: handled = mongodb://, postgres://, mysql://, ADO.NET `Server=…;Database=`, `Data Source=…;Initial Catalog=`. mishandled/partial = misses `redis://`, JDBC/ODBC DSNs, inline `user:pass@host`, env-var indirection (ledger "partial — not exhaustive"). never-seen = non-listed schemes.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:661-667`); parity = `spec68-hardcoded-connection-parity.spec.ts:64-116` (runs via `runSecuritySlice`); fixture = **ABSENT**; baseline = `corpus-baselines.md` (200, 969); ledger = `rule-authenticity-ledger.md:49,154`, `severity-assignment-ledger.md:116`; `rule-replacement-ledger.md` = **ABSENT**; `bench/baselines/baseline.json` = **ABSENT**.

### `loop-query` (29)

- **Claim** (registry): `Database query inside a loop detected in {method}.` (`ruleRegistry.ts:673`).
- **Firing condition**: `dataAccess.ts:516-543` is a pure projection of the pre-computed `loop-queries` fact (no predicate in `analyze`). Predicate is producer-side in `collectLoopQueryCandidates` (`UniversalDataAccessAnalyzer.ts:2136-2245`): DB call (`isDbCallNode`) → skip template-literals (:2162) → skip short text <10 chars (:2165) → skip statement-construction-only (:2169) → skip SQL-string-construction (:2175) → `findEnclosingLoop` (:2177) → skip inside `db.transaction` (:2187) → skip transaction-wrapped helper (:2197) → skip LLM-pipeline loop (:2205) → skip message-lifecycle loop (:2211) → dedup per loop keyed on `loopNode.range[0]` (:2218-2220). `findEnclosingLoop` (:2488) fires on `adapter.isLoop(parent)` or `isIteratorCallback` over `['forEach','map','filter','reduce','some','every','find','findIndex','flatMap']`. `needs: {formats:['typescript','tsx','javascript'], facts:['loop-queries']}` (:519). Severity `'severe'` (:520); depth message when `q.depth > 1`; emitted text includes `(loop at line ${q.loopLine})`.
- **Input position**: `loop-queries` → `file`, `line`, `column`, `symbol`, `loopLine`, `depth` (types.ts:370-382). Source region = resolved DB call callee (:2232) + enclosing loop node.
- **Grammar checklist**: loop = `for_statement`/`for_in_statement`/`while_statement`/`do_statement` (`adapter.isLoop`) or `call_expression` whose `function` is `member_expression` with `property` one of the nine iterator methods. DB call = `call_expression`/`member_expression` callee or a `template_string` SQL argument. `.go` not served.
- **Coverage**: handled = lexical containment, LLM-pipeline + queue-consumer suppression, transaction-batching suppression, per-loop dedup, await-callee re-anchoring. mishandled/partial = purely lexical — no loop-carried dataflow proving query depends on loop variable (ledger "partial — needs loop-variable dependency"). never-seen = true N+1 dependency proof.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:676-682`); parity = `spec68-loop-query-parity.spec.ts:68-150`, `loopQueryAnchor.spec.ts:56-74`, `loopQueryShapes.spec.ts:58-106`, `loopQueryLlmDiscriminator.spec.ts:55-146`, `loopQueryQueueConsumer.spec.ts:53-116`; fixture = `spec-19/item-01-real-loop-insert.ts`, `item-02-llm-loop-no-db.ts`, `item-03-real-n-plus-one.ts`, `item-05-findindex-not-db.ts`, `item-06-immemory-iteration.ts`, `item-08-real-nested-n-plus-one.ts`, `r2-db-call-gate.test.ts`, `spec-52/item-01-prepare-in-loop.ts`, `item-03-exec-in-loop.ts`, `item-04-storage-sql-exec-in-loop.ts`, `spec-17/for-loop-query.ts`, `spec-17/nested-loops-query.ts`; baseline = `corpus-baselines.md` (48, 73, 194, 212, 214, 221, 222, 241, 634, 895, 950, 1017, 1032) + `bench/baselines/baseline.json:10,52`; ledger = `rule-authenticity-ledger.md:50`, `severity-assignment-ledger.md:117`; `rule-replacement-ledger.md` = **ABSENT**.

### `hardcoded-secret` (30)

- **Claim** (registry `message`): `"Hardcoded secret detected: a credential value is embedded in source. Move it to an environment variable or secret store."` (`ruleRegistry.ts:690`). Emitted text is longer: `"Hardcoded secret${label} detected: a ${value.length}-character credential is embedded in source…"` (`src/phase/rules/secrets.ts:167-168`).
- **Firing condition**: `detectHardcodedSecret` (`secrets.ts:185-209`) over the `secret-candidates` fact. Skip `isTestOrFixtureFile(c.file)`; if `c.position === 'call'` require `c.args.length >= 2` and some arg `isCredentialSelector(arg)`, then flag any non-selector arg where `looksLikeRealSecret(value)`; else flag when `isSecretName(c.name) && looksLikeRealSecret(c.value)`. `normalizeName` = lowercase + strip non-alphanumerics; `isSecretName` = membership in `SECRET_NAMES` (list B); `looksLikeRealSecret` rejects placeholder, email (`/^[^@\s]+@[^@\s]+\.[^@\s]+$/`), URL (`/^https?:\/\//i`), pure identifier (`/^[A-Za-z_$][A-Za-z_$]*$/`), requires `length >= 8` and `hasDigit || hasUpper || hasHardSymbol` where `HARD_SYMBOL = /[^A-Za-z0-9\-_.\s]/`.
- **Input position**: `secret-candidates` → `SecretCandidate` union. For `position: 'declarator'|'assignment'|'pair'` it reads `.name` + `.value` (plain strings); for `'call'` it reads `.args`. The `line`/`column` anchor is the **enclosing node** start, not the string node.
- **Grammar checklist** (node types the producer emits from, `secretCandidates.ts:92-133`): `variable_declarator` (`name` = `array_pattern`/`identifier`/`object_pattern`, `value` = `expression`); `assignment_expression` (`left` = `array_pattern`/`identifier`/`member_expression`/`non_null_expression`/`object_pattern`/`parenthesized_expression`/`subscript_expression`/`undefined`); `pair` (`key` = `computed_property_name`/`number`/`private_property_identifier`/`property_identifier`/`string`); `call_expression` `arguments` children (`expression`/`spread_element`).
- **Coverage**: handled = single/double-quoted `string` in the four positions. Mishandled/never-seen = `template_string` values, destructuring declarator/assignment names, `computed_property_name`/`#private`/numeric pair keys, concatenated or `spread_element` call args (structurally unreachable — the producer never emits them), env-var references (`member_expression`), test/fixture files (excluded by design).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:693-717`); parity = `spec68-hardcoded-secret-parity.spec.ts` (whole file); fixture = **ABSENT**; baseline = `corpus-baselines.md` (knex=1, blitz=3) — not in `baseline.json`; ledger = `severity-assignment-ledger.md:97,101` only — **ABSENT** from `rule-authenticity-ledger.md` and `rule-replacement-ledger.md`.

### `file-documentation` (31)

- **Claim**: `'File is missing a leading documentation comment.'` (`ruleRegistry.ts:724`). Emitted: `'File lacks a leading documentation comment'` (`fileDocumentation.ts:143`).
- **Firing condition**: gate `fileHeaders = cfg.fileHeaders ?? cfg.requireFileDocs ?? false`; per `file-header` fact skip `isExempt` and `matchesAnyGlob(skipGlobs)`; fire when `!fact.headerDoc || !isFileHeaderDoc(fact.headerDoc)` where `isFileHeaderDoc = /@(fileoverview|file|module|module-desc|overview|purpose)\b/i.test(doc)`.
- **Input position**: `file-header` → `FileHeaderFact.headerDoc` (`string | null`) → the file's leading comment: `ast.root.children[0]` if it is a `comment` node, else the doc comment preceding the first root child.
- **Grammar checklist**: one comment node type `comment` (covers `//`, `/* */`, `/** */`; the `/**` distinction is text-prefix only). Header candidate = first `program` child `comment` (any style), else `getDocumentation(firstChild)` which only matches a `/**`-prefixed `comment` sibling. `program` root children = `hash_bang_line` + `statement`.
- **Coverage**: handled = leading `/** @fileoverview`, `/* @file */`, `// @module`; license block correctly fires. Mishandled = a `//`/`/* */` header *preceding* (not as first child of) a non-comment first child is invisible — branch (b) only matches `/**`. Never-seen = `@license`/`@copyright` markers (deliberately excluded).
- **Evidence**: samples = yes (`ruleRegistry.ts:727-734`); parity = `spec68-file-documentation-parity.spec.ts`; fixture = **ABSENT** (inline source); baseline = **ABSENT** (default-OFF); ledger = `rule-authenticity-ledger.md:104`, `rule-replacement-ledger.md:94-95,127,146,162,187,2606`, `severity-assignment-ledger.md:144`.

### `function-documentation` (32)

- **Claim**: `'Function "{name}" is missing a doc comment.'` (`ruleRegistry.ts:739`). Emitted: `'exported function '${name}' lacks a documentation comment'` (exported) / `'function '${name}' lacks…'`.
- **Firing condition**: `if (!cfg.requireFunctionDocs) return []`; skip `isExempt`, `isAnonymousOrCallback`, `scope === 'public' && !isExported`, `lineCount < docsMinLines`; fire when `!isSubstantiveDoc(jsDoc)`. `isSubstantiveDoc` = strip `/**`/`*/`/leading `*`, reject empty/placeholder (`PLACEHOLDER_DOC_PATTERN`), strip `@tag{...}`, strip non-alphanumerics, require ≥1 word of length ≥2 not in `DOC_STOP_WORDS`.
- **Input position**: `file-symbols` → `FileFunctionSymbol.jsDoc` (+ `isExported`, `isAnonymousOrCallback`, `lineCount`) → `function_declaration`/`generator_function_declaration`/`function_expression`/`arrow_function` (methods excluded).
- **Grammar checklist**: `extractFunctions` yields `function_declaration` (name `identifier`), `generator_function_declaration`, `function_expression`, `arrow_function`, `method_definition`. Comment attach scans backward for a `/**`-prefixed `comment` sibling only; `//` and `/* */` never count as JSDoc.
- **Coverage**: handled = named/`function*`/`async`/`export`/`export default` functions. Mishandled = `export const foo = () => {}` — the arrow's `isExported` is false (parent is `variable_declarator`, not `export_statement`), so an exported arrow is skipped at `scope: 'public'`. Never-seen = `generator_function_expression`; anonymous default-export arrow (name `<anonymous>`).
- **Evidence**: samples = yes (`ruleRegistry.ts:742-749`); parity = `spec68-documentation-parity.spec.ts:87-95,137-153`; fixture = **ABSENT**; baseline = `corpus-baselines.md:242,893,944,994,1003` + `baseline.json:20`; ledger = `rule-authenticity-ledger.md:105`, `rule-replacement-ledger.md:141,155,184,2607`, `severity-assignment-ledger.md:145`.

### `parameter-documentation` (33)

- **Claim**: `'Parameter "{name}" in function "{func}" is missing a @param tag.'` (`ruleRegistry.ts:754`). Emitted: `'Function '${item.name}' missing documentation for parameter '${param}'`.
- **Firing condition**: over `tagEligibleItems` (functions/methods not exempt/anonymous, exported, ≥`docsMinLines`, *carrying a substantive doc*), for each parameter name `checkParameterDocumentation` builds `new RegExp('@param\\s+(?:\\{[^}]+\\}\\s+)?' + param + '\\b', 'i')` and fires when it does not match. The `requireParamDocs`/`requireReturnDocs` gates were removed (§10) — it fires unconditionally on tag-eligible items.
- **Input position**: `file-symbols` → `FileFunctionSymbol.parameterNames` + `jsDoc` (and `FileMethodSymbol` equivalents) → `function_declaration`/`generator_function_declaration`/`function_expression`/`arrow_function` + `method_definition`.
- **Grammar checklist**: parameter names from `extractParameters` reading `required_parameter`/`optional_parameter` named children (`identifier` or `pattern`). Comment attach identical to `function-documentation` (`/**` sibling only). `isPlainIdentifierName` skips destructured params.
- **Coverage**: handled = `@param name`, `@param {Type} name`. Mishandled = mistyped `@params` reads as missing; destructuring silently skipped. Never-seen = object-property params (`a.b`), array-pattern params; functions with no doc emit only `function-documentation`.
- **Evidence**: samples = yes (`ruleRegistry.ts:757-764`); parity = `spec68-documentation-parity.spec.ts:97-105`; fixture = **ABSENT**; baseline = **ABSENT** (opt-in); ledger = `rule-authenticity-ledger.md:106`, `rule-replacement-ledger.md:94`, `severity-assignment-ledger.md:146`.

### `return-documentation` (34)

- **Claim**: `'Function "{name}" is missing a @returns tag.'` (`ruleRegistry.ts:769`). Emitted: `'Function '${item.name}' missing return value documentation`.
- **Firing condition**: over `tagEligibleItems`, skip `!item.returnType || returnType === 'void'`; fire when `!hasReturnDocumentation(jsDoc)` where `hasReturnDocumentation = /@returns?\b/i.test(doc)`.
- **Input position**: `file-symbols` → `FileFunctionSymbol.returnType` + `jsDoc` → same node types as `parameter-documentation`.
- **Grammar checklist**: `returnType` from `extractTypeAnnotation`, which reads `return_type` only for `function_declaration`, `method_definition`, `arrow_function` — **not** `function_expression` or `generator_function_declaration` (their return type is silently `null` and guarded out). `@return` and `@returns` both match.
- **Coverage**: handled = typed non-void functions/methods missing `@returns`/`@return`. Never-seen = `function_expression`/`generator_function_declaration` returns; `void`/untyped (guarded out).
- **Evidence**: samples = yes (`ruleRegistry.ts:772-790`); parity = `spec68-documentation-parity.spec.ts:107-115`; fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:107`, `severity-assignment-ledger.md:147`.

### `class-documentation` (35)

- **Claim**: `'Class "{name}" is missing a doc comment.'` (`ruleRegistry.ts:795`). Emitted: `'Class '${cls.name}' lacks a documentation comment`.
- **Firing condition**: `if (!cfg.requireClassDocs) return []`; skip `isExempt`, `scope === 'public' && !isExported`; fire when `!isSubstantiveDoc(cls.jsDoc)`. No `docsMinLines` gate.
- **Input position**: `file-symbols` → `FileClassSymbol.jsDoc` → `class_declaration`/`abstract_class_declaration`.
- **Grammar checklist**: `extractClasses` yields `class_declaration` (name `type_identifier`) and `abstract_class_declaration`. `buildClassInfo` returns null on null name → anonymous default-export class has no symbol.
- **Coverage**: handled = `class`/`abstract class`/`export class`/`export default class Name`. Never-seen = `class_expression` (`const X = class {}`), anonymous `export default class {}`.
- **Evidence**: samples = yes (`ruleRegistry.ts:798-805`); parity = `spec68-documentation-parity.spec.ts:117-125`; fixture = **ABSENT**; baseline = `corpus-baselines.md:913,945,1009`; ledger = `rule-authenticity-ledger.md:108`, `rule-replacement-ledger.md:145,158,185,2608`, `severity-assignment-ledger.md:148`.

### `method-documentation` (36)

- **Claim**: `'Method "{name}" is missing a doc comment.'` (`ruleRegistry.ts:810`). Emitted: `'public method '${cls.name}.${m.name}' lacks a documentation comment` — the `public` label is emitted **unconditionally** even under `scope: 'all'` (`rule-authenticity-ledger.md:109`).
- **Firing condition**: gated by `if (!cfg.requireFunctionDocs) return []` (reuses the *function* gate, not `requireClassDocs`); skip class `isExempt`/`scope==='public' && !isExported`; skip method `scope==='public' && m.isNonPublic`; fire when `!isSubstantiveDoc(m.jsDoc)`.
- **Input position**: `file-symbols` → `FileClassSymbol.methods[].jsDoc` (+ `isNonPublic`, `line`, `column`) → `method_definition`.
- **Grammar checklist**: `buildClassMembers` iterates `class_body` named children, building methods only for `method_definition`. `class_body` also allows `abstract_method_signature`, `class_static_block`, `index_signature`, `method_signature` — none become methods. `isNonPublic` checks for `accessibility_modifier`/`private`/`protected`/`#`/`_`.
- **Coverage**: handled = public `method_definition` of an exported class; private/protected/`#x`/`_x` skipped. Mishandled = `public` wording emitted for non-public cases under `scope:'all'`. Never-seen = `method_signature`, `abstract_method_signature`, `class_static_block`, `index_signature`, methods of `class_expression`.
- **Evidence**: samples = yes (`ruleRegistry.ts:813-820`); parity = `spec68-documentation-parity.spec.ts:127-135`; fixture = **ABSENT**; baseline = `corpus-baselines.md:901,942,1004`; ledger = `rule-authenticity-ledger.md:109`, `rule-replacement-ledger.md:145,160,186,2609`, `severity-assignment-ledger.md:149`.

## schema-json (37–53)

**Shared structure.** All 17 rules are thin projections of a single corpus fact. `schemaJson.ts` maps each id to a fixed severity and each rule's `analyze` is `findingsFor(ctx.facts['schema-validations'], id)` — a pure filter that re-homes the fact verbatim (`schemaJson.ts:60-95`). The actual validation lives in `jsonSchema.ts`'s `analyzeJsonSchemas`, which the `schema-validations` corpus processor invokes once. Three consequences follow, and they are the group's entire evidentiary content:

1. **No AST, no located position.** JSON files are parsed by `JSON.parse` (the `readJson` callback), not tree-sitter. **There is no JSON grammar loaded.** Every finding is anchored at `line: 1, column: 1` (`jsonSchema.ts:571-581` `emit()` hardcodes it) — a position that does not correspond to the offending token.
2. **No source region.** The firing condition is a relation over the *runtime-parsed JSON value* (object/array/string/number/boolean/null) at a dotted path, not over source text. This group is neither a source-region pattern (A) nor a name-list rule (B); it is the third category the audit surfaces: *value relations with a synthetic anchor*.
3. **Severity lives in the fact.** `invalid-json` = critical, `missing-schema-declaration` = high, the other 15 = severe (`schemaJson.ts:38-56`).

Grammar checklist for every rule in this group: **none** — no JSON grammar is loaded; the "productions" are `JSON.parse` value shapes (`object`, `array`, `string`, `number`, `boolean`, `null`) plus the schema keywords read off plain object properties.

| # | Rule | Firing condition (validator + predicate) |
|---|------|------------------------------------------|
| 37 | `invalid-json` | `JSON.parse` throws → `SyntaxError` catch in `loadSchemas` (`:117-127`), or data-file `readJson === null` in `validatePairedData` (`:150-154`) / `validateDiscoveredData` (`:182-188`). |
| 38 | `missing-schema-declaration` | `validateJsonSchema`: `!schema.$schema && config.jsonSchemaVersion` (`:200-202`). |
| 39 | `undefined-required-field` | `validateJsonSchema`: object schema with `required[]` field absent from `properties` (`:206-213`). |
| 40 | `invalid-type` | `checkSchemaTypeField`: a `schema.type` value not in `config.allowedJsonTypes` (`:238-247`). |
| 41 | `invalid-range` | `checkNumericRangeField`: `type` integer/number and `minimum > maximum` (`:250-258`). |
| 42 | `type-mismatch` | `validateAgainstSchema`: `!matchesSchemaType(data, actualType, allowedTypes)` (`:302-310`); `integer` accepts `number && Number.isInteger`. |
| 43 | `string-too-short` | `checkStringConstraints`: `minLength` set and `data.length < minLength` (`:338-340`). |
| 44 | `string-too-long` | `checkStringConstraints`: `maxLength` set and `data.length > maxLength` (`:341-343`). |
| 45 | `pattern-mismatch` | `checkStringConstraints`: `schema.pattern` present and `new RegExp(pattern).test(data)` false (`:344-349`). |
| 46 | `invalid-format` | `checkFormatConstraint`: `FORMAT_VALIDATORS[format]` present and returns false (`:484-489`). |
| 47 | `below-minimum` | `checkNumberConstraints`: `minimum` set and `data < minimum` (`:494-496`). |
| 48 | `above-maximum` | `checkNumberConstraints`: `maximum` set and `data > maximum` (`:497-499`). |
| 49 | `too-few-items` | `checkArrayConstraints`: `minItems` set and `data.length < minItems` (`:505-507`). |
| 50 | `too-many-items` | `checkArrayConstraints`: `maxItems` set and `data.length > maxItems` (`:508-510`). |
| 51 | `missing-required-field` | `checkObjectConstraints`: `required[]` field not `in data` (`:521-527`). |
| 52 | `unexpected-property` | `checkObjectConstraints` → `checkUnexpectedProperties`: `additionalProperties === false` (or `strictMode`) and a data key not in `properties` (`:537-550`). |
| 53 | `enum-mismatch` | `checkEnumConstraint`: `schema.enum` set and `!schema.enum.includes(data)` (`:562-568`). |

**Coverage (group).** Handled = the 17 schema-keyword checks above plus the 19-entry `FORMAT_VALIDATORS` registry (`email`/`idn-email`, `uuid`, `date`, `time`, `date-time`, `ipv4`, `ipv6`, `hostname`/`idn-hostname`, `uri`/`iri`, `uri-reference`/`iri-reference`, `uri-template`, `json-pointer`, `regex`). Mishandled = `invalid-json` throws away the real `JSON.parse` error in favor of synthetic text (`rule-authenticity-ledger.md:69`); the 1:1 anchor is a deliberate lie of position. Never-seen = any non-`string`/`number`/`integer`/`object`/`array` type, `exclusiveMinimum`/`exclusiveMaximum`, `additionalProperties` as a *schema object* (only `false` is checked for unexpected-property), and `minItems`/`maxItems` on nested `items` are validated but only via recursion (no separate finding id).

**Evidence (group).** samples = registry yes (each of the 17 has `samples`); parity = `src/__tests__/spec68-schema-json-parity.spec.ts`; fixture = **ABSENT**; baseline = **ABSENT** (the validation corpora are TS/Go code repos with no `.data.json`/`.schema.json`); ledger = `rule-authenticity-ledger.md:69-84`, `severity-assignment-ledger.md:180-196`; `rule-replacement-ledger.md` = **ABSENT** (the split to 17 thin rules is a §3.2 migration, not a replacement).

## schema-code (54–58)

Five rules over `schema-usage`/`function-bodies`/`dynamic-sql`/`table-catalog`/`migration-history` facts. **There is no SQL grammar loaded** — `.sql`/DDL content and SQL strings inside code are matched by regex over raw text, never parsed into an AST. Grammar checklists therefore cite the TS productions at the extraction sites, not SQL productions. Grammar source: tree-sitter-typescript 0.23.2 (183 named productions; probe-confirmed against `dist/grammars/tree-sitter-typescript.wasm`).

### `dynamic-sql-construction` (54)

- **Claim** (registry): `SQL query built via string interpolation or concatenation in {method}; use parameterized queries.` (`ruleRegistry.ts:1084`).
- **Firing condition**: `analyze` is a pure projection (`schema.ts:312-322`) over the `dynamic-sql` fact; predicate in producer `collectDynamicSqlCandidates` (`codeAnalysis.ts:825-849`) running `DANGEROUS_SQL_PATTERNS` (`:738-742`) over raw `sourceCode`: `` /query\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g ``, `/query\s*\(\s*['"][^'"]*['"]?\s*\+/g`, `/execute\s*\(\s*['"][^'"]*['"]?\s*\+/g`. Per match, `collectInjectionMatch` (:772-815) clears if parameterized (`/^\s*,/` after match or `callHasBindParams`) or `isAllDynamicPartsSafe`. Survivors emit `critical` at the match offset.
- **Input position**: `dynamic-sql` → `file`/`line`/`column`/`enclosingFn`/`symbol`. Source region = raw-`sourceCode` regex match; AST used only post-hoc (`findClosestNodeAt` → `findEnclosingCallExpression`) to locate the enclosing `call_expression` for the parameterized/taint gates.
- **Grammar checklist**: anchored node is `call_expression` with callee `identifier` (bare `query(`/`execute(`) or `member_expression` (`identifier` + `property_identifier`, e.g. `db.query`); first arg `template_string` (`string_fragment`/`template_substitution`) for interpolation, or `string`/`binary_expression` for concatenation. Productions: `call_expression`, `member_expression`, `identifier`, `property_identifier`, `arguments`, `template_string`, `template_substitution`, `string_fragment`, `string`, `binary_expression`.
- **Coverage**: handled = interpolation (`${...}`) + concatenation (`+`) on `query(`/`execute(`; parameterized/taint-safe clears. never-seen = `template_literal` — `hasTemplateArgument`/`getTemplateText`/`getFirstStringArgument` guards also test `template_literal`, which is **not a grammar production** (only `template_string`); dead branch. mishandled = `FUNCTION_NODE_TYPES` names `generator_function_expression` (nonexistent) and omits `generator_function`, so a dynamic-SQL site inside `function* () {}` is attributed to an outer identity.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:1087-1094`); parity = `spec68-dynamic-sql-construction-parity.spec.ts`; fixture = **ABSENT**; baseline = `corpus-baselines.md` hhra-org line 963 (count 1); ledger = `rule-authenticity-ledger.md:85` (Resolution row, `sql-injection`), `rule-replacement-ledger.md:1487,2600`, `severity-assignment-ledger.md:197`.

### `table-naming-convention` (55)

- **Claim** (registry): `Table name "{table}" should use snake_case convention.` (`ruleRegistry.ts:1101`).
- **Firing condition** (`schema.ts:188-211`): skip if `ref.origin === 'query-builder'` (:194); `isSnakeCase = /^[a-z][a-z0-9_]*$/.test(ref.tableName)` (:196); `isTableSuffix = ref.tableName.endsWith('Table')` (:197); `if (isSnakeCase || isTableSuffix) continue;` (:198); else emit `high`. Legacy twin `checkNamingConventions` (`codeAnalysis.ts:644-683`) adds an **unregistered** `reserved-word` emission (`const reserved = ['user','order','group','table','column','index']`, :671) with no registry entry (deliberately dropped, `schema.ts:28-32`).
- **Input position**: `schema-usage` → `.tableName`, a string captured by SQL-keyword regexes (`FROM`/`JOIN`/`INSERT`/`UPDATE`/`DELETE`/`CREATE`) over SQL text, or by ORM/query-builder `call_expression` string args — no SQL AST.
- **Grammar checklist**: table-name string originates at (a) `parseSqlTables` over raw SQL text (regexes `codeAnalysis.ts:367-377`) or (b) a `call_expression`'s `arguments` → `string`/`template_string` child. Node types: `call_expression`, `member_expression`, `identifier`, `property_identifier`, `arguments`, `string`, `template_string` (plus `decorator` for ORM).
- **Coverage**: handled = snake_case + `Table`-suffix; query-builder skip. never-seen = `template_literal`/`field_identifier` dead branches (`:1041/1060/1089`, `isChainedFurther` :328). mishandled = predicate tests the *reference* name, not DDL declarations — a scratch/test table via raw SQL still fires.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:1104-1111`); parity = `spec68-schema-rules.spec.ts`, `spec68-schema-parity.spec.ts`; fixture = **ABSENT**; baseline = `corpus-baselines.md` knex line 983 (count 1), Spec-66 mention @449; ledger = `rule-authenticity-ledger.md:86`, `rule-replacement-ledger.md:1566,2601`, `severity-assignment-ledger.md:198`.

### `unknown-table` (56)

- **Claim** (registry): `Reference to unknown table "{table}" ({type}). Did you mean: {suggestions}?` (`ruleRegistry.ts:1117`).
- **Firing condition** (`schema.ts:132-174`): `known = knownTableSet(facts['table-catalog'])` (:133, case-sensitive set of `catalog.tables[].name`); `unknownRefs` (:110-119) keeps usages where `origin !== 'query-builder' && !isSystemTable && !isTableValuedFunction && !known.has` (:96-99,115); fail-open guard `knownCount === 0 || refs.length / max(knownCount,1) > 10` (:117) → `[]`; drop refs whose table ∈ `migration-history.dropped` (:144,148); emit `critical` with `getNearestTableSuggestions(ref.tableName, known, 2)` (:149). Legacy twin `checkMissingReferences` (`:967-1004`).
- **Input position**: `schema-usage` (`.tableName`), `table-catalog` (`.tables[].name`, from `ddl-declarations` via `replayDdlDeclarations` over `DDL_RE`), `migration-history` (`.dropped`).
- **Grammar checklist**: known-table names derive from **raw `.sql`** matched by `DDL_RE` (`migrations.ts:212`); reference names from SQL-keyword regexes or `call_expression`/`member_expression`/`decorator` string args. Productions: `call_expression`, `member_expression`, `identifier`, `property_identifier`, `arguments`, `string`, `template_string`, `decorator`.
- **Coverage**: handled = raw-SQL/tagged-template/DB-call/ORM/query-builder extraction; system-table + table-valued-function exclusions; Levenshtein ≤2 suggestions; 10:1 fail-open; dropped-table partition. never-seen = `template_literal`/`field_identifier` dead branches. mishandled = fail-open at ratio >10 silently skips a sparse-catalog corpus (by design).
- **Evidence**: samples = registry yes (`ruleRegistry.ts:1120-1130`); parity = `spec68-schema-rules.spec.ts`, `spec68-schema-parity.spec.ts`, `spec68-schema-slice.spec.ts`, `spec68-table-catalog.spec.ts`, `spec68-cte-alias.spec.ts`, `spec68-stale-table-reference-parity.spec.ts`; fixture = `src/analyzers/__tests__/fixtures/spec-17/{schema-auto-discover.ts, template-alias-join.ts, template-prefix-table.ts, template-alias-from.ts, sql-tagged-template.ts}`; baseline = `corpus-baselines.md` recall 2@927, knex 12@971, blitz 4@1012, 4.0.0 @669 + `bench/baselines/baseline.json` (f1=1.0); ledger = `rule-authenticity-ledger.md:87`, `severity-assignment-ledger.md:199`; `rule-replacement-ledger.md` = **ABSENT**.

### `stale-table-reference` (57)

- **Claim** (registry): `Reference to dropped table "{table}" — dropped in {migration}.` (`ruleRegistry.ts:1140`).
- **Firing condition** (`schema.ts:238-276`): same `unknownRefs` + fail-open as `unknown-table`; for each surviving unknown ref, `const drop = dropped[ref.tableName]; if (!drop) continue;` (:245-246); emit `critical` with message branching on `drop.createdInSameMigration.length` (successor-table evidence or "was not recreated"). Provenance `dropProvenance` (`migrations.ts:127-189`): DROP'd table → `{migrationFile, createdInSameMigration}`, except same-file create-and-drop scratch fixtures (teardown, cleared :181-188).
- **Input position**: `schema-usage` (`.tableName`), `table-catalog` (`.tables[].name`), `migration-history` (`.dropped[tableName] = {migrationFile, createdInSameMigration}`) from `ddl-declarations`.
- **Grammar checklist**: same as `unknown-table` — drop provenance from raw `.sql` via `DDL_RE`; reference names from SQL-string regexes or `call_expression` args. No SQL AST.
- **Coverage**: handled = dropped-table partition of the unknown set; successor evidence; same-file create-and-drop teardown exemption. never-seen/mishandled = inherits `template_literal`/`field_identifier` dead branches + `generator_function` identity gap.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:1143-1153`); parity = `spec68-stale-table-reference-parity.spec.ts`, `spec68-schema-parity.spec.ts`; fixture = **ABSENT**; baseline = `corpus-baselines.md` recall 19@912, 4.0.0 @683; ledger = `severity-assignment-ledger.md:347` (missed-by-original-sweep); `rule-authenticity-ledger.md` = **ABSENT**, `rule-replacement-ledger.md` = **ABSENT**.

### `too-many-queries` (58)

- **Claim** (registry): `Function "{name}" has {count} queries, exceeding the maximum of {max}.` (`ruleRegistry.ts:1162`).
- **Firing condition**: `detectTooManyQueries` (`functionBodies.ts:39-65`): skip `skipTestFiles !== false && isTestOrSpecPath(fn.file)`; ceiling `maxQueries = thresholds['maxQueriesPerFunction'] ?? 5`; fire when `countQueries(fn.text) > maxQueries`. `countQueries` (`codeAnalysis.ts:1473-1482`) = `callCount + execCount + sqlCount`: callCount = `/\.(?:query|execute|run|first|raw|batch)\b[^()\n]*\(|(?<!Promise)\.all\b[^()\n]*\(/g`; execCount = `countExecCallsWithSql` (`/\.exec\b[^()\n]*\(/g` + SQL keyword in balanced body); sqlCount = `countSqlKeywordOccurrences(stripQueryCallBodies(text))` over `SQL_QUERY_PATTERNS` (`/SELECT\s+/gi`, `/INSERT…INTO|REPLACE\s+INTO/gi`, `/(?<!DO\s)(?<!KEY\s)UPDATE\s+/gi`, `/DELETE\s+FROM/gi`).
- **Input position**: `function-bodies` → `.text` = full function-node source text (`extractFunctionBodies` → `adapter.extractFunctions` + `getNodeText`). It is a *source region*, not a parsed SQL position — a List-A pattern.
- **Grammar checklist**: `extractFunctions` (`TreeSitterTypeScriptAdapter.ts:928-934`) admits exactly `function_declaration`, `generator_function_declaration`, `function_expression`, `arrow_function`, `method_definition`. The `countQueries` regexes match `call_expression`/`member_expression` text as substrings (no AST lookup).
- **Coverage**: handled = the 5 declarations. never-seen = `generator_function_expression` (not a grammar production; `FUNCTION_NODE_TYPES` also lists it spuriously). mishandled = generator-function *expression* (`const g = function* () {}`) parses as `generator_function`, which `extractFunctions` does not list → body **silently not counted**.
- **Evidence**: samples = registry yes (`ruleRegistry.ts:1165-1172`); parity = `spec68-too-many-queries-parity.spec.ts`; fixture = **ABSENT** (incidental comment only, `spec-52/item-07-chained-prepare-bind-first-in-loop.ts`); baseline = `corpus-baselines.md` (Spec-52 re-pin 79/94/98/111, Spec-55 R3 194-206, recall 84@900, hhra-org 21@947, knex 3@978); ledger = `severity-assignment-ledger.md:202`; `rule-authenticity-ledger.md` = **ABSENT**, `rule-replacement-ledger.md` = **ABSENT**.

## react (59–65)

All seven read one fact kind `react-component` (producer `scanParsedFile` → `ComponentScanResult`), formats `typescript`/`tsx`/`javascript`. The analysis itself lives in `src/analyzers/reactAnalyzer.ts` (legacy body), re-emitted by `src/phase/rules/react.ts` filtering `.filter(v => v.rule === id)`.

### `hooks-naming` (59)

- **Claim**: `React hook "{name}" does not follow the "use*" naming convention.` (`ruleRegistry.ts:1186`). Emitted: `Custom hook '${name}' should start with 'use'`.
- **Firing condition**: `reactAnalyzer.ts:66` `if (config.checkHooksRules && component.hooks?.length > 0)`; then `component.hooks.filter(hook => hook.customHook && !hook.name.startsWith('use'))` (`:156-158`).
- **Input position**: `react-component` → `hooks[].name`/`hooks[].customHook` → `call_expression` (callee `identifier`/`member_expression`) inside a functional/memo/forwardRef component, plus file-level `function_declaration`s for the `hookUsingFns` pre-scan.
- **Grammar checklist**: `call_expression` (`function` → `identifier` | `member_expression`); `member_expression` (`object` → `React`, `property` → `property_identifier`); `function_declaration` (`name` → `identifier`).
- **Coverage**: handled = `identifier` callee and `React.*` member callee. **Dead** = the `use*`-identifier path and the `React.useXxx` path — both guard on `name.startsWith('use')`, so `!name.startsWith('use')` is always false for them; the rule fires **only** via the `hookUsingFns` path (a same-file `function_declaration` whose name does *not* start with `use` but whose body calls a built-in hook). Never-seen = aliased/renamed hook imports (`useState as useSt`).
- **Evidence**: samples = yes (`ruleRegistry.ts:1189-1196`); parity = `spec68-react-parity.spec.ts:144-150`; fixture = `bench/corpus/react/src/hooks-naming.tsx` (+ `good-hook.tsx`); baseline = `baseline.json:68`; **ABSENT** from `corpus-baselines.md`; ledger = `rule-authenticity-ledger.md:111`, `severity-assignment-ledger.md:161`.

### `complexity` (60)

- **Claim**: `React component "{name}" has complexity {complexity}, exceeding the maximum.` (`ruleRegistry.ts:1201`).
- **Firing condition**: **two emitters sharing the id.** (1) Per-component `component.complexity > config.maxComponentComplexity` (default 20, `reactAnalyzer.ts:101`). (2) A cross-component cycle detector wired unconditionally at `react.ts:110` → `checkCircularDependencies` emits `rule: 'complexity'` "Circular dependency detected" when `findCycle` returns a path (`reactAnalyzer.ts:376-405`). `component.complexity` = base 1; +1 per `if_statement`/`ternary_expression`; +2 per `for`/`for_in`/`while`; +`cases.length` per `switch`; +1 per `.map(` member call (`componentScanner.ts:481-514`).
- **Input position**: `react-component` → `complexity` (number) and `jsxElements[]` + `imports[]` (cycle detector).
- **Grammar checklist**: `if_statement`, `ternary_expression`, `for_statement`, `for_in_statement`, `while_statement`, `switch_statement`→`switch_body`→`switch_case`/`switch_default`, `call_expression`→`member_expression` (property `map`); cycle arm over `jsx_element`/`jsx_self_closing_element` tag names + `import_statement`→`import_clause`.
- **Coverage**: handled = the enumerated control-flow nodes and `.map`. **Mishandled** = the cycle arm is mislabeled under `complexity` (a different claim than "high complexity"). Never-seen = `do_statement`, `catch_clause`, logical `&&`/`||` (uncounted); the cycle detector skips lowercase JSX tags.
- **Evidence**: samples = yes (`ruleRegistry.ts:1205-1218`); parity = `spec68-react-parity.spec.ts:126-132`; fixture = `bench/corpus/react/src/bad-hook.tsx`; baseline = `baseline.json:65` + `corpus-baselines.md:487,906,953`; ledger = `rule-authenticity-ledger.md:112`, `severity-assignment-ledger.md:162`.

### `missing-props` (61)

- **Claim**: `React component "{name}" is missing prop-types.` (`ruleRegistry.ts:1223`).
- **Firing condition**: `if (!config.requirePropTypes || hasPropsValidation(component)) return []` (`reactAnalyzer.ts:125`); `hasPropsValidation` = `component.props?.length > 0` (`:182-190`). Default `requirePropTypes: false` — fires only when enabled AND `component.props` is empty/undefined.
- **Input position**: `react-component` → `props[]` → destructured first parameter (`object_pattern`/`object_binding_pattern`), inline `object_type`/`type_literal`, class `extends_clause`→`type_arguments`.
- **Grammar checklist**: `object_pattern`, `object_binding_pattern`, `binding_element`, `shorthand_property_identifier_pattern`, `pair_pattern`, `type_annotation`, `object_type`, `type_literal`, `property_signature`, `formal_parameters`, `required_parameter`, `optional_parameter`, `variable_declarator`, `class_declaration`→`class_heritage`→`extends_clause`.
- **Coverage**: handled = destructured params + inline object type literals. Mishandled = `type_reference` (`React.FC<Props>` with a named interface) is unresolvable → false positive; a `P.propTypes = {...}` assignment is **not** read (the near-miss passes only because it destructures `{x}`). Never-seen = `propTypes` assignment, cross-file interface resolution.
- **Evidence**: samples = yes (`ruleRegistry.ts:1226-1233`); parity = `spec68-react-parity.spec.ts:134-142`; fixture = `bench/corpus/react/src/missing-props.tsx`; baseline = `baseline.json:69`; **ABSENT** from `corpus-baselines.md`; ledger = `rule-authenticity-ledger.md:113`, `severity-assignment-ledger.md:163`.

### `no-error-boundary` (62)

- **Claim**: `React component tree is missing an error boundary.` (`ruleRegistry.ts:1238`).
- **Firing condition**: `if (cfg.requireErrorBoundaries === false) return []` (default true); `checkErrorBoundaryUsage` emits one app-level finding iff `componentsWithErrorBoundary.size === 0 && !hasConventionErrorBoundary && totalComponents > 10` (`reactAnalyzer.ts:459-462`). `hasErrorBoundary` set only for class components with methods named `componentDidCatch`/`getDerivedStateFromError`; Next.js convention via basename in `NEXT_ERROR_BOUNDARY_BASENAMES`.
- **Input position**: `react-component` → `hasErrorBoundary` (bool) + `filePath` basename + aggregate component count.
- **Grammar checklist**: `class_declaration` (`name` → `type_identifier`) → `class_body` → `method_definition` (`name` → `property_identifier`/`private_property_identifier`/`computed_property_name`/`number`/`string`).
- **Coverage**: handled = class error-boundary methods, Next.js basenames. Never-seen = functional `<ErrorBoundary>` wrappers (no AST signal), `computed_property_name` method names. The ledger's quoted "per-component" arm (complexity>7 or `useEffect`) was **removed** (Spec 55 R4).
- **Evidence**: samples = yes (`ruleRegistry.ts:1241-1248`); parity = `spec68-react-parity.spec.ts:169-176`; fixture = `bench/corpus/react/src/no-error-boundary.tsx`; baseline = `baseline.json:66` + `corpus-baselines.md:276,280,281`; ledger = `rule-authenticity-ledger.md:114`, `severity-assignment-ledger.md:164`.

### `performance` (63)

- **Claim**: `React component "{name}" is missing memoization.` (`ruleRegistry.ts:1253`).
- **Firing condition**: **three emitters sharing the id** (`react.ts:183`): (1) memoization `requireMemoization && componentType==='functional' && complexity > 5` (default off); (2) inline `onClick` AST-derived `jsxElementDetails[].attributes.some(a => a.name === 'onClick' && (valueKind === 'arrow' | 'function'))`; (3) missing list keys **raw-source** `source.includes('.map(') && jsxElements.length > 0 && !source.includes('key=')` where `source = component.body ?? component.context` (`reactAnalyzer.ts:309-312`).
- **Input position**: `react-component` → `componentType`/`complexity`/`jsxElementDetails[].attributes`/`jsxElements[]`/`body`/`context` (raw source string).
- **Grammar checklist**: `jsx_opening_element` (`attribute` → `jsx_attribute`/`jsx_expression`) → `jsx_attribute` → `jsx_expression` → `arrow_function`/`function_expression`/`identifier`. Leg 3 is raw text, not AST.
- **Coverage**: handled = `onClick` with `arrow_function`/`function_expression` value; a bare `onClick={handleClick}` is correctly not flagged. Mishandled = leg 1 "missing memoization" overreaches a `complexity > 5` size proxy; leg 3 is a source substring. Never-seen = `onClick` via `spread_element`, `memo`/`forwardRef` components. The authenticity-ledger predicates for the inline-prop and missing-keys legs are **stale** (pre-spec-44); only leg 3 still matches a raw substring today.
- **Evidence**: samples = yes (`ruleRegistry.ts:1256-1263`); parity = `spec68-react-parity.spec.ts:116-124`; fixture = `bench/corpus/react/src/performance.tsx`; baseline = `baseline.json:67` + `corpus-baselines.md:700,898,943,1007,1031`; ledger = `rule-authenticity-ledger.md:115`, `severity-assignment-ledger.md:165`, `rule-replacement-ledger.md:1997-2042`.

### `accessibility` (64)

- **Claim**: `Accessibility issue in component "{name}": {issue}.` (`ruleRegistry.ts:1268`).
- **Firing condition**: `if (config.checkAccessibility && component.jsxElements)`; `checkAccessibility` over `jsxElementDetails`: (1) `img` without `alt` → severe; (2) `onClick` on `nonInteractiveElements = ['div','span','section']` → severe (`reactAnalyzer.ts:262-283`).
- **Input position**: `react-component` → `jsxElementDetails[].tagName` + `attributes[].name` → `jsx_element`/`jsx_self_closing_element` → `jsx_opening_element`.
- **Grammar checklist**: `jsx_element` (`open_tag` → `jsx_opening_element`, `close_tag` → `jsx_closing_element`), `jsx_self_closing_element`, `jsx_opening_element` (`name` → `identifier`/`member_expression`/`jsx_namespace_name`; `attribute` → `jsx_attribute`/`jsx_expression`), `jsx_attribute` (children `property_identifier`/`string`/`jsx_expression`/`jsx_element`/`jsx_self_closing_element`/`jsx_namespace_name`).
- **Coverage**: handled = `jsx_attribute` whose name is `property_identifier` (**the `identifier` fallback in `componentScanner` is dead** — the grammar only emits `property_identifier` for attribute names). Never-seen = `jsx_namespace_name` tags (`<svg:path>`), `alt`-through-spread. The authenticity-ledger predicate (`component.context?.includes('alt=')`) is **stale**; current code is per-attribute AST.
- **Evidence**: samples = yes (`ruleRegistry.ts:1271-1278`); parity = `spec68-react-parity.spec.ts:106-114`; fixture = `bench/corpus/react/src/accessibility.tsx`; baseline = `baseline.json:70` + `corpus-baselines.md:916,961`; ledger = `rule-authenticity-ledger.md:116`, `severity-assignment-ledger.md:166`, `rule-replacement-ledger.md:2086-2151`.

### `raw-element` (65)

- **Claim**: `` raw `<{element}>` — this project uses `<{wrapper}>` ({file}). `` (`ruleRegistry.ts:1283`, resolvable).
- **Firing condition**: `if (cfg.rawElementCheck === false) return []` (default true); watch list `config.rawElementWatchList ?? ['button','input','select','textarea','table']`; build wrapper map (config or auto-detect an exported component whose `jsxElements` contains exactly one watch-list intrinsic); early-exit if empty; emit per location when count ≥ `wrapperMinUsages` (default 5).
- **Input position**: `react-component` → `jsxElements[]` (tag strings; intrinsic = first char lowercase) + `isExported` + `jsxElementDetails[]`.
- **Grammar checklist**: `jsx_element`, `jsx_self_closing_element`, `jsx_opening_element` (`name` → `identifier`/`member_expression`/`jsx_namespace_name`). Intrinsic detection is a char-class test over the tag string.
- **Coverage**: handled = lowercase `identifier` watch-list tags. Mishandled = wrapper auto-detection is a heuristic. Never-seen = `React.createElement(Button, ...)` (no JSX node), `jsx_namespace_name`, `member_expression` tags.
- **Evidence**: samples = yes (`ruleRegistry.ts:1286-1297`); parity = `spec68-react-parity.spec.ts:152-167`; fixture = `bench/corpus/react/src/raw-element.tsx` (+ `-near-miss.tsx`); baseline = `baseline.json:71` + `corpus-baselines.md:897,1006`; ledger = `rule-authenticity-ledger.md:117`, `severity-assignment-ledger.md:167`.

## schema-validator (66–68)

Three rules, one corpus fact (`cross-language-entities`, gated on ≥2 languages present), one `SchemaValidator` (constructed with no options → `strictTypeChecking` always true, so the loose branch is dead on the phase path). Extracts TS `interface` and Go `struct` entity shapes and compares them field-by-field.

### `schema-field-mismatch` (66)

- **Claim**: `Schema field type-name strings differ: {detail}.` (`ruleRegistry.ts:1313`).
- **Firing condition**: `if (normalizedRefType !== normalizedCurType) { … rule: "schema-field-mismatch" }` (strict branch, `SchemaValidator.ts:239`); loose branch `if (!areTypesCompatible(...))` at `:258` is dead. `normalizeType` folds nullability/containers then `PRIMITIVE_ALIASES[language]?.[t] || t` (`:441`) — unmapped types fall to raw string equality.
- **Input position**: `cross-language-entities` → TS `entity.parameters[].type` vs Go `entity.metadata.fields[].type`, compared via `normalizeType`.
- **Grammar checklist**: TS `interface_declaration` → `object_type` (`property_signature` read; `method_signature`/`call_signature`/`construct_signature`/`index_signature` legally present but never read). Go `type_declaration` → `type_spec` → `struct_type` → `field_declaration_list` → `field_declaration` (`field_identifier`, `type`, `tag`).
- **Coverage**: handled = TS/Go primitive aliases + `list<>`/`map<>`/nullability folding. Mishandled = unmapped named/structural types fall to exact-string equality. Never-seen = loose-mode branch, `python` alias arm, protobuf/graphql/json-schema schemas (stubbed to no extraction).
- **Evidence**: samples = yes; parity = `spec68-schema-validator-parity.spec.ts`; fixture = **ABSENT** (inline synthetic); baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:88`, `rule-replacement-ledger.md:1651`, `severity-assignment-ledger.md:213`.

### `missing-field` (67)

- **Claim**: `Missing field: {field}.` (`ruleRegistry.ts:1328`).
- **Firing condition**: for each ref field, `if (!refField.required || curFields.has(fieldName)) continue;` else emit (`SchemaValidator.ts:154-169`). `required` = TS `!param.optional` and Go `isGoValueType(field.type)` (non-nilable value type, not the old `isExported` proxy).
- **Input position**: `cross-language-entities` → TS `interface` `parameters[].optional` / Go `struct` `fields[].type`.
- **Grammar checklist**: same as `schema-field-mismatch` (TS `interface_declaration`/`property_signature`; Go `type_spec`/`struct_type`/`field_declaration`).
- **Coverage**: handled = TS optional flag + Go non-nilable-value-type requiredness. Mishandled = Go pointers/slices/maps/chans/funcs/interfaces treated optional (documented). Never-seen = protobuf/graphql/json-schema, TS `required_parameter`/`optional_parameter` (interface path reads only `property_signature`).
- **Evidence**: samples = yes; parity = `spec68-schema-validator-parity.spec.ts`; fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:89`, `rule-replacement-ledger.md:1746,2538`, `severity-assignment-ledger.md:214`.

### `extra-field` (68)

- **Claim**: `Extra field: {field}.` (`ruleRegistry.ts:1343`).
- **Firing condition**: `if (this.options.allowAdditionalFields) return []`; then for each current field not in ref set, emit (`SchemaValidator.ts:185-202`). `allowAdditionalFields` defaults false and is never overridden.
- **Input position**: `cross-language-entities` → same entity/field extraction; compares `curFields` keys against `refFields`.
- **Grammar checklist**: identical to the other two schema rules.
- **Coverage**: handled = literal name set-difference over field maps. Never-seen = protobuf/graphql/json-schema current-side fields (stubbed `[]`).
- **Evidence**: samples = yes; parity = `spec68-schema-validator-parity.spec.ts`; fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:90`, `severity-assignment-ledger.md:215`; `rule-replacement-ledger.md` = **ABSENT**.

## dependency-graph (69–75)

Seven rules over the `cross-language-entities` fact + the `file-imports`/`reachability` facts. The graph models **call** references (never `import_statement` edges). Four of the seven (`break-cycles`, `reduce-coupling`, `review-orphans`, and the `complexity`-mislabeled React cycle arm) are *suggestions* — static remediation strings gated by a paired issue, with no independent predicate of their own and `{placeholder}` text that is never rendered.

### `circular-dependency` (69)

- **Claim**: `Circular dependency detected: {cycle}.` (`ruleRegistry.ts:1359`).
- **Firing condition**: DFS back-edge `else if (recursionStack.has(neighbor))`, self-edge skip, `spansMultipleFiles(cycleNodes, fileById)` required (`DependencyGraphBuilder.ts:473-491`); edges from `buildReferences` resolving `metadata.callees` against the entity-name index.
- **Input position**: `cross-language-entities` → `metadata.callees[].name` resolved (same-file → same-dir → unique-global) → `DependencyEdge`.
- **Grammar checklist**: edge sources = TS `function_declaration`/`method_definition`/`variable_declarator`+`arrow_function`, Go `function_declaration`; callee names from `call_expression` `function` field. Type declarations are nodes but never call targets.
- **Coverage**: handled = cross-file call cycles. Mishandled (intentional) = same-file mutual recursion suppressed. Never-seen = import-only cycles (no `import_statement` edges); ambiguous bare-name callees drop the edge.
- **Evidence**: samples = yes; parity = `spec68-dependency-graph-parity.spec.ts`; fixture = **ABSENT**; baseline = `corpus-baselines.md:742`; ledger = `rule-authenticity-ledger.md:97`, `severity-assignment-ledger.md:237`; `rule-replacement-ledger.md` = **ABSENT**.

### `break-cycles` (70)

- **Claim**: `Break dependency cycle: {cycle}.` (`ruleRegistry.ts:1374`).
- **Firing condition**: **no independent predicate** — `recordCycleCheck` pushes the suggestion when `graph.cycles.length !== 0` (`DependencyGraphBuilder.ts:680-692`). `SUGGESTION_SEVERITY['break-cycles'] = 'severe'`.
- **Input position**: `cross-language-entities` → same cycle computation.
- **Grammar checklist**: same as `circular-dependency`.
- **Coverage**: handled = fires iff a real cross-file cycle exists. Mishandled = `{cycle}` never rendered (static generic advice).
- **Evidence**: samples = yes; parity = `spec68-dependency-graph-parity.spec.ts`; fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:98`, `severity-assignment-ledger.md:238`; `rule-replacement-ledger.md` = **ABSENT**.

### `tight-coupling` (71)

- **Claim**: `Tight coupling detected between {a} and {b}.` (`ruleRegistry.ts:1389`).
- **Firing condition**: `if (nodeIds.length < 3) continue`; `coupling = internalEdges / incidentEdges; if (coupling > 0.7)` (`DependencyGraphBuilder.ts:250-276`). Cluster = package directory.
- **Input position**: `cross-language-entities` → `DependencyNode.cluster` + `DependencyEdge` endpoints.
- **Grammar checklist**: nodes are all extracted entities; `call_expression` is the only edge producer.
- **Coverage**: handled = whole-cluster cohesion > 0.7 with ≥3 nodes. Mishandled = registry `{a}`/`{b}` is pairwise but the metric is cluster-level (count + `(N%)` rendered). Never-seen = clusters <3 nodes or zero incident edges.
- **Evidence**: samples = yes; parity = `spec68-dependency-graph-parity.spec.ts`; fixture = **ABSENT**; baseline = `corpus-baselines.md:258,933,959,981,993,1022,1035`; ledger = `rule-authenticity-ledger.md:99`, `severity-assignment-ledger.md:239`; `rule-replacement-ledger.md` = **ABSENT**.

### `reduce-coupling` (72)

- **Claim**: `Reduce coupling between {a} and {b}.` (`ruleRegistry.ts:1405`).
- **Firing condition**: same `coupling > 0.7` predicate; suggestion pushed when `count !== 0` (`DependencyGraphBuilder.ts:695-708`). `SUGGESTION_SEVERITY['reduce-coupling'] = 'high'`.
- **Input position**: `cross-language-entities` → same cluster/coupling computation.
- **Grammar checklist**: same as `tight-coupling`.
- **Coverage**: handled = fires iff a tightly-coupled cluster exists. Mishandled = `{a}`/`{b}` never rendered.
- **Evidence**: samples = yes; parity = `spec68-dependency-graph-parity.spec.ts`; fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:100`, `severity-assignment-ledger.md:240`; `rule-replacement-ledger.md` = **ABSENT**.

### `orphaned-nodes` (73)

- **Claim**: `Orphaned node "{node}" has no connections.` (`ruleRegistry.ts:1420`).
- **Firing condition**: `findOrphanedNodes` returns nodes passing all guards: skip `interface`/`struct`, `_`-prefixed, `isMethod`/dot-named, connected, exported, or `isNameReferenced(name, file, index)` (`DependencyGraphBuilder.ts:293-327`). Emits one finding per affected node.
- **Input position**: `cross-language-entities` → `DependencyNode` fields + `metadata.fileReferences` (fallback `metadata.callees`).
- **Grammar checklist**: candidates = TS `function_declaration`/`method_definition`/`variable_declarator`+`arrow_function`, Go `function_declaration`; reference index also reads `call_expression`, `jsx_opening_element`/`jsx_self_closing_element`, `identifier`, `shorthand_property_identifier`, `pair`.
- **Coverage**: handled = scope-aware function-level orphan detection. Mishandled (intentional) = interfaces/structs, `_`-prefixed, methods/dot-names, exported entry points suppressed. Never-seen = import-only reachability.
- **Evidence**: samples = yes; parity = `spec68-dependency-graph-parity.spec.ts`; fixture = **ABSENT**; baseline = `corpus-baselines.md:144,744`; ledger = `rule-authenticity-ledger.md:101`, `severity-assignment-ledger.md:241`; `rule-replacement-ledger.md` = **ABSENT**.

### `review-orphans` (74)

- **Claim**: `Review orphaned nodes: {nodes}.` (`ruleRegistry.ts:1435`).
- **Firing condition**: same orphan predicate — suggestion pushed when `orphanedNodes.length !== 0` (`DependencyGraphBuilder.ts:753-765`). `SUGGESTION_SEVERITY['review-orphans'] = 'severe'`.
- **Input position**: `cross-language-entities` → same orphan computation.
- **Grammar checklist**: same as `orphaned-nodes`.
- **Coverage**: handled = fires iff real orphans exist. Mishandled = `{nodes}` list never rendered.
- **Evidence**: samples = yes; parity = `spec68-dependency-graph-parity.spec.ts`; fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:102`, `severity-assignment-ledger.md:242`; `rule-replacement-ledger.md` = **ABSENT**.

### `unreferenced-module` (75)

- **Claim**: `Module is not imported by any other file and is not a framework entry point — dead code candidate.` (`ruleRegistry.ts:1450`).
- **Firing condition**: emit when `hasExports` AND not test file AND not entry point AND `importersOf[file]` empty (`unreferencedModule.ts:50-64`).
- **Input position**: `file-imports` → `hasExports`/`file`/`imports`; `reachability` → `importersOf[file]` + `packageEntryPoints`.
- **Grammar checklist**: `hasExports` = TS/JS `export_statement` or Go capitalized top-level name; import edges = TS `import_statement` `source`, Go `import_declaration`→`import_spec` `path`, re-export `source`, static-string dynamic `import()`/`require()`.
- **Coverage**: handled = exported + zero importers + not test + not entry point. Mishandled = workspace-package monorepos (package-named imports never form internal edges). Never-seen = `.astro`/`.vue` imports, Go packages reached via build tooling.
- **Evidence**: samples = yes; parity = `spec68-unreferenced-module-parity.spec.ts`; fixture = **ABSENT**; baseline = `corpus-baselines.md:645-664,795-807,896,941,992,1002`; ledger = `severity-assignment-ledger.md:243`; `rule-authenticity-ledger.md` = **ABSENT**, `rule-replacement-ledger.md` = **ABSENT**.

## styles (76–84)

Nine rules over the `style-declarations` fact (producer `stylesCss.ts`/`cssAstExtractor.ts` for `.css`/`.scss`, `styleExtractor.ts` for TS/JS). Fields consumed: `declarations[]` (`property`, `rawValue`, `normalizedValue`, `mechanism`, `filePath`, `line`, `context`, `tokenRef`), `tokens[]`, `classUsage[]`. `undefined-class` additionally reads `defined-classes` + `unread-style-sources`. The rule bodies live in `src/phase/rules/styles.ts`.

### `styles/value-drift` (76)

- **Claim**: `Color drift in "{property}": "{value}" is near-identical to "{canonical}" (ΔE = {d}). Consider using "{canonical}".` (`ruleRegistry.ts:1472`).
- **Firing condition**: route only `isColorProperty(property)` (16 `colorProps`, list B) through `detectColorDrift`; skip categorical/exclusion values; parse `rawValue` via `parseColorToRGB`, cluster by CIELAB ΔE76 (`rgbToLab`/`deltaE`) with `distance < colorDeltaE` (2.5), keep clusters `length >= 2`, flag every non-canonical member. Canonical = most-used then lexicographic.
- **Input position**: `style-declarations` → `declarations[].rawValue` + `property` — the value is **raw source text** after the colon, not a typed value node.
- **Grammar checklist** (css value-position productions): `property_name`, `color_value` (hex `#rgb…`, no separate `hex_color` node), `plain_value`, `integer_value`/`float_value` (+`unit`), `string_value`, `call_expression`, `parenthesized_value`, `binary_expression`, `grid_value`, `important`; SCSS adds `variable`, `interpolation`, `list_value`, `identifier`, `nesting_selector`.
- **Coverage**: handled = `color_value` (4/7/9-hex), `rgb(...)` (comma/space), 5 named colors, `plain_value` keywords in `COLOR_KEYWORDS`. Mishandled = named colors beyond 5 (parse → null AND classified categorical → whole property skipped); `#rgba` (5-hex) legal but unhandled. Never-seen = `rgba()`, `hsl()`, `hsla()`, `hwb()`, `lab()`/`lch()`/`oklab()`/`color()` (rgb regex is `rgb\(` only).
- **Evidence**: samples = yes (`ruleRegistry.ts:1475-1482`); parity = `spec68-styles-parity.spec.ts:191-195,249-254`; fixture = **ABSENT** (in-memory seed); baseline = `corpus-baselines.md:834-862`; ledger = `rule-authenticity-ledger.md:58`, `severity-assignment-ledger.md:267`; `rule-replacement-ledger.md` = **ABSENT** (Spec 67 rework recorded in authenticity ledger).

### `styles/off-scale` (77)

- **Claim**: `Value "{value}" is off the Tailwind spacing scale.` (`ruleRegistry.ts:1487`).
- **Firing condition**: for each `scaleProperties` property (14, list B), require `decls.length >= offScaleMinDeclarations` (20); pick `declaredScale`; skip if scale empty; parse `rawValue` via `parseLengthToPx` (`/^(-?\d+(?:\.\d+)?)\s*(px|rem|em|%|vh|vw|pt|cm|mm)?$/`, rem/em→×16, pt→×1.333, cm→×37.795, mm→×3.7795, `%`/`vh`/`vw`→null); flag when `px !== 0 && !scaleSet.has(px)`.
- **Input position**: `style-declarations` → `declarations[].rawValue` + `property`; scale from `tokens[].name`/`value`.
- **Grammar checklist**: value-position `integer_value`/`float_value` (unit px/rem/em/pt/cm/mm or unitless); `%`/`vh`/`vw` and `call_expression` (`calc()`/`var()`) are legal but excluded.
- **Coverage**: handled = unitless/px/rem/em/pt/cm/mm; zero skipped. Mishandled = rem/em use a hardcoded 16px base (not the project's real root font-size). Never-seen = `%`, `vh`, `vw`, `calc()`, `var()`, `clamp()`, `min()`, `max()`.
- **Evidence**: samples = yes (`ruleRegistry.ts:1490-1497`); parity = `spec68-styles-parity.spec.ts:200-208,256-262`; fixture = **ABSENT**; baseline = `corpus-baselines.md:308-324`; ledger = `rule-authenticity-ledger.md:59`, `rule-replacement-ledger.md:1236,1324,2597`, `severity-assignment-ledger.md:268`.

### `styles/undefined-class` (78)

- **Claim**: `Class "{class}" was not found in any read stylesheet or utility set.` (`ruleRegistry.ts:1502`, resolvable).
- **Firing condition**: static filters drop `unresolvable`, `.css`/`.scss` `class`-mechanism definitions, defined classes, PascalCase, `(`-containing, `^\d`, `[`/`]`-adjacent, extraction-artifact chars; then `definedSet` membership; then Tailwind `expander.resolve` must be invalid; then near-miss Levenshtein ≤2 against `defined-classes` — fires only the `severe` near-miss branch.
- **Input position**: `style-declarations` → `classUsage[].className` (a `class_name` under `class_selector`) + `defined-classes[].className`.
- **Grammar checklist**: `class_selector` children = `class_name`, `nesting_selector`, `class_selector` (chained), `pseudo_class_selector`, `pseudo_element_selector`, `string_value`; SCSS adds `placeholder`. Only `class_name` directly under `class_selector` is extracted; `class_name` under pseudo selectors is excluded.
- **Coverage**: handled = plain and `&`-BEM-resolved `class_name`; near-miss ≤2. Mishandled = `&.modifier`/`& .descendant` marked `unresolvable` → dropped. Never-seen = `placeholder` (`%`), `id_name`/`attribute_name`.
- **Evidence**: samples = yes (`ruleRegistry.ts:1505-1515`); parity = `spec68-styles-undefined-class-parity.spec.ts`; fixture = **ABSENT**; baseline = `corpus-baselines.md:256,624,930,1019`; ledger = `rule-authenticity-ledger.md:60,61`, `severity-assignment-ledger.md:269,346`; `rule-replacement-ledger.md` = **ABSENT**.

### `styles/token-bypass` (79)

- **Claim**: `Token bypass: raw value "{value}" used instead of a design token.` (`ruleRegistry.ts:1526`).
- **Firing condition**: `matchBypassToken` returns null if `token_ref`, property `--`/`$`, categorical exclusion, or `scaleProps` membership; normalize via `normalizeForTokenMatch` (lowercase/trim, `replace(/,\s+/g, ',')`, `#rgb`→`#rrggbb`); skip `TRIVIAL_VALUES` (14, list B); require `tokenValueMap.get(normalized)` hit; type-gate `declType === tokenInfo.valueType`.
- **Input position**: `style-declarations` → `declarations[].rawValue`/`tokenRef`/`property`/`normalizedValue` + `tokens[].value`.
- **Grammar checklist**: value-position productions (as value-drift); token map values from `declaration` nodes whose property starts `--`, or Tailwind theme tokens.
- **Coverage**: handled = hex (3/6), `rgb()` comma/space collapse, `plain_value` keywords. Mishandled = the old color-only overclaim resolved — type gate now matches `normalizedValue.type`. Never-seen = token values that are `hsl()`/`calc()`.
- **Evidence**: samples = yes (`ruleRegistry.ts:1530-1536`); parity = `spec68-styles-parity.spec.ts:197-198,264-272`; fixture = **ABSENT**; baseline = `corpus-baselines.md:20,334,894,995,1010`; ledger = `rule-authenticity-ledger.md:62`, `rule-replacement-ledger.md:1330,1400,2598`, `severity-assignment-ledger.md:271`.

### `styles/mechanism-fragmentation` (80)

- **Claim**: `Styling mechanism fragmented across {count} mechanisms.` (`ruleRegistry.ts:1541`).
- **Firing condition**: group by `` `${property}::${normalized_value ?? raw_value}` ``; flag when `mechs.size >= mechanismFragmentationMinMechanisms` (3).
- **Input position**: `style-declarations` → `declarations[].property`/`normalizedValue`/`rawValue`/`mechanism`.
- **Grammar checklist**: **none** — pure data over the `mechanism` string field.
- **Coverage**: handled = every `StyleMechanism` value (`css`/`scss`/`tailwind`/`inline`/`css-in-js`/`design-token`). Never-seen = n/a.
- **Evidence**: samples = yes (`ruleRegistry.ts:1544-1551`); parity = `spec68-styles-parity.spec.ts:210-215`; fixture = **ABSENT**; baseline = `corpus-baselines.md:903`; ledger = `rule-authenticity-ledger.md:63`, `severity-assignment-ledger.md:272`; `rule-replacement-ledger.md` = **ABSENT**.

### `styles/mechanism-mixing` (81)

- **Claim**: `Mixing styling mechanisms in one file.` (`ruleRegistry.ts:1556`).
- **Firing condition**: per `file_path`, collect distinct `mechanism`; flag when `mechs.size >= mechanismFragmentationMinMechanisms` (shares the fragmentation knob).
- **Input position**: `style-declarations` → `declarations[].filePath` + `mechanism`.
- **Grammar checklist**: **none**.
- **Coverage**: handled = all `StyleMechanism` values per file. Never-seen = n/a.
- **Evidence**: samples = yes (`ruleRegistry.ts:1560-1566`); parity = `spec68-styles-parity.spec.ts:210-215`; fixture = **ABSENT**; baseline = `corpus-baselines.md:920`; ledger = `rule-authenticity-ledger.md:64`, `severity-assignment-ledger.md:273`; `rule-replacement-ledger.md` = **ABSENT**.

### `styles/declaration-set-similarity` (82)

- **Claim**: `Declaration set similar to another block ({similarity}%).` (`ruleRegistry.ts:1571`).
- **Firing condition**: group by `${file_path}::${context}`, valueSet = `${property}:${normalized_value ?? raw_value}`, filter `declCount >= declarationSetMinDeclarations` (5); prefix-indexed Jaccard join, then exact `similarity = intersection.size / union.size >= declarationSetSimilarityThreshold` (0.9).
- **Input position**: `style-declarations` → `declarations[].context`/`property`/`normalizedValue`/`rawValue`/`filePath`.
- **Grammar checklist**: **none** — `context` is raw selector text, but the rule compares value sets, not selector AST.
- **Coverage**: handled = any `rule_set` context with ≥5 declarations; exact Jaccard re-verified so the prefix index is lossless.
- **Evidence**: samples = yes (`ruleRegistry.ts:1575-1581`); parity = `spec68-styles-parity.spec.ts:217-223`; fixture = **ABSENT**; baseline = `corpus-baselines.md:910,1005`; ledger = `rule-authenticity-ledger.md:65`, `severity-assignment-ledger.md:274`; `rule-replacement-ledger.md` = **ABSENT**.

### `styles/z-index-sprawl` (83)

- **Claim**: `Z-index sprawl: {count} distinct z-index values.` (`ruleRegistry.ts:1586`).
- **Firing condition**: only `byProperty.get('z-index')`; `collectZIndexValues` does `parseInt(raw_value, 10)` skipping `NaN`; flag once when `values.size > zIndexMaxDistinct` (6).
- **Input position**: `style-declarations` → `declarations[].property === 'z-index'` + `rawValue`.
- **Grammar checklist**: value-position `integer_value` (unitless) intended; `parseInt` over raw text accepts any leading integer.
- **Coverage**: handled = unitless and negative integers. Mishandled = lenient `parseInt` counts `5px`→5, `50%`→50. Never-seen = `auto`, `var(--z)`, `calc()` (`NaN` skipped).
- **Evidence**: samples = yes (`ruleRegistry.ts:1590-1596`); parity = `spec68-styles-parity.spec.ts:225-232`; fixture = **ABSENT**; baseline = `corpus-baselines.md:935,996`; ledger = `rule-authenticity-ledger.md:66`, `severity-assignment-ledger.md:275`; `rule-replacement-ledger.md` = **ABSENT**.

### `styles/z-index-singleton` (84)

- **Claim**: `Z-index value "{value}" appears only once.` (`ruleRegistry.ts:1601`).
- **Firing condition**: same `collectZIndexValues` parse; flag each value where `list.length === 1 && values.size > 2`.
- **Input position**: `style-declarations` → `declarations[].property === 'z-index'` + `rawValue`.
- **Grammar checklist**: value-position `integer_value` (unitless).
- **Coverage**: handled = unitless singleton values. Mishandled = same lenient `parseInt`. Never-seen = `auto`/`var()`/`calc()`.
- **Evidence**: samples = yes (`ruleRegistry.ts:1605-1611`); parity = `spec68-styles-parity.spec.ts:225-232`; fixture = **ABSENT**; baseline = `corpus-baselines.md:921,991`; ledger = `rule-authenticity-ledger.md:67`, `severity-assignment-ledger.md:276`; `rule-replacement-ledger.md` = **ABSENT**.

## conventions (85–89)

Five rules over the `function-index` + `mined-conventions` facts (and `import-form`/`export-form` for two). The *convention* is mined upstream (`conventionMiner.ts`) with `minCorpus` 20 / `modeShare` 0.8 gates; the rule then flags each fact whose value diverges from the dominant mode. Rules live in `src/phase/rules/conventions.ts`.

### `conventions/usage-pair` (85)

- **Claim**: `'{pct}% of \`{antecedent}\` callers also call \`{consequent}\`.'` (`ruleRegistry.ts:1618`).
- **Firing condition**: for each `usage-pair` convention with both antecedent/consequent, find callers of `antecedent` and flag each whose call-set lacks `consequent` (`conventions.ts:98-131`). The pair is pre-filtered upstream (`confidence >= 0.9`, `support >= 20`, `BUILT_IN_CALLEES` skipped).
- **Input position**: `function-index` → `functionCalls: string[]`; `mined-conventions` → `domain='usage-pair'`, `antecedent`/`consequent`.
- **Grammar checklist**: `call_expression` (`function` = `identifier`/`member_expression`/`selector_expression`/nested `call_expression`); enclosing bodies from `function_declaration`, `variable_declarator`→`arrow_function`, React components.
- **Coverage**: handled = `function_declaration`, `variable_declarator`+`arrow_function`. Never-seen = `method_definition` (deliberately skipped), `generator_function_declaration`/`generator_function_expression`, non-React `function_expression`.
- **Evidence**: samples = yes (`ruleRegistry.ts:1621-1631`); parity = `spec68-conventions-parity.spec.ts:181-225,292-335`; fixture = **ABSENT** (inline seed; bench corpus `bench/corpus/conventions/src/`); baseline = `corpus-baselines.md:253,902`; ledger = `rule-authenticity-ledger.md:52`.

### `conventions/import-form` (86)

- **Claim**: `'Import form mismatch: use {form} for "{source}".'` (`ruleRegistry.ts:1636`).
- **Firing condition**: for each `import-form` fact in the `function-index` file set, look up `(directory, source)` and flag when `imp.form !== conv.consequent` (`conventions.ts:334-338`). The `imp.form` value is produced by regex `parseFileImports` over raw `file.source`, classifying `default|named|namespace|side-effect|require`.
- **Input position**: `import-form` → `source`/`form`/`line`; `function-index` → file-set gate; `mined-conventions` → `domain='import-form'`.
- **Grammar checklist**: the *regex* handles six forms (side-effect, namespace, default, default+named, named, require-default, require-destructured). NOT handled: `import type { … }`, TS `import x = require('x')` (`import_equals`).
- **Coverage**: handled = the six regex forms. Never-seen = `import type`, `import =`, and any import whose file has no indexed function (dropped by the `funcFiles` gate).
- **Evidence**: samples = yes (`ruleRegistry.ts:1639-1646`); parity = `spec68-import-form-parity.spec.ts`; fixture = **ABSENT**; baseline = `corpus-baselines.md:246,924`; ledger = `rule-authenticity-ledger.md:53` (notes the regex-over-text gap).

### `conventions/error-handling` (87)

- **Claim**: `'Error-handling convention mismatch: {detail}.'` (`ruleRegistry.ts:1651`).
- **Firing condition**: for each `function-index` fact with a body in `ERROR_HANDLING_HANDLED_LANGUAGES`, classify `detectErrorHandlingShape(body)` and flag when `shape !== conv.pattern` (`conventions.ts:150-160`). `detectErrorHandlingShape` is AST-structural: `catch_clause`→`try-catch`, `call_expression` with member `catch`→`promise-catch`, `if_statement` whose condition `isErrorPresenceCheck` (bare `err`/`error`, `!err`, `err != null`/`err === undefined`)→`if-err`; returns null when shapes ≠ 1.
- **Input position**: `function-index` → `body` (raw body re-parsed as `async function __ca() ${body}`), `language`; `mined-conventions` → `domain='error-handling'`.
- **Grammar checklist**: `catch_clause`, `call_expression` (member `catch`), `if_statement` (condition `identifier` `err`/`error` | `unary_expression` `!` | `binary_expression` `==`/`!=`/`===`/`!==` vs `null`/`undefined`).
- **Coverage**: handled = the three shapes. Mishandled = `try`/`finally` without `catch`, `err instanceof Error`, `err.code`, `errorMessage` (all rejected). Never-seen = non-TS/JS bodies, 0-or-≥2 shapes.
- **Evidence**: samples = yes (`ruleRegistry.ts:1654-1661`); parity = `spec68-conventions-parity.spec.ts:191,223,310`; fixture = **ABSENT**; baseline = `corpus-baselines.md:243,904`; ledger = `rule-authenticity-ledger.md:54`, `rule-replacement-ledger.md:1152` (regex→structural).

### `conventions/export-shape` (88)

- **Claim**: `'Export shape mismatch: {detail}.'` (`ruleRegistry.ts:1666`).
- **Firing condition**: for each exported `function-index` fact, resolve export form from `export-form` and flag when `form !== conv.pattern` (`conventions.ts:271-283`).
- **Input position**: `export-form` → `name`/`isDefault`; `function-index` → `isExported`/`name`; `mined-conventions` → `domain='export-shape'`.
- **Grammar checklist**: `buildExportInfo` handles `export_statement` with `default` modifier, `export_clause`→`export_specifier`, declaration child (`function_declaration`/`class_declaration`/`abstract_class_declaration`/`lexical_declaration`/`variable_declaration`), `value` field.
- **Coverage**: handled = default-vs-named for the declaration/`export {}`/`export default` forms. Never-seen = re-export-only symbols (matched only by `e.name === fact.name`), CJS `module.exports` (not in `extractExports`).
- **Evidence**: samples = yes (`ruleRegistry.ts:1669-1676`); parity = `spec68-conventions-parity.spec.ts:201,225,311`; fixture = **ABSENT**; baseline = `corpus-baselines.md:931`; ledger = `rule-authenticity-ledger.md:55`.

### `conventions/naming` (89)

- **Claim**: `'Naming convention mismatch: {detail}.'` (`ruleRegistry.ts:1681`).
- **Firing condition**: for each exported `function-index` fact, classify kind/casing and flag when `casing !== conv.pattern` (`conventions.ts:206-220`). `classifyExportKind` = `react-component`/`hook` (`/^use[A-Z]/`)/`function`; `detectCase` = `UPPER_SNAKE`/`PascalCase`/`camelCase`/`snake_case`/`kebab-case`; `hasNonLatinChars` guard.
- **Input position**: `function-index` → `name`/`isExported`/`entityType`/`componentType`; `mined-conventions` → `domain='naming'`.
- **Grammar checklist**: `function_declaration` (`name` = `identifier`), `variable_declarator`→`arrow_function`, React `function_expression`/`class_declaration`/`call_expression` (memo/forwardRef). `method_definition` (`property_identifier`) excluded.
- **Coverage**: handled = the five casing regexes. Never-seen = `method_definition` names, non-Latin names (guarded).
- **Evidence**: samples = yes (`ruleRegistry.ts:1684-1691`); parity = `spec68-conventions-parity.spec.ts:292`; fixture = **ABSENT**; baseline = `corpus-baselines.md:919,952`; ledger = `rule-authenticity-ledger.md:56`.

## cross-domain (90–94)

Five rules over `schema-usage` (+ `call-graph`/`batch-functions`/`coverage`/`hotspot` where noted). Rules in `src/phase/rules/crossDomain.ts`.

### `cross-domain/written-never-read` (90)

- **Claim**: `'Table "{table}" is written but never read.'` (`ruleRegistry.ts:1698`).
- **Firing condition**: a table with ≥1 write row (`insert|update|delete|create`), ≥1 non-query-builder row, ≥1 `insert|update` (data-flows-in) row, no `select`, not `_fts`-suffixed (`crossDomain.ts:239-269`); `WRITE_TYPES`/`DATA_WRITE_TYPES`/`isFts5Table` all from hardcoded sets.
- **Input position**: `schema-usage` → `usageType`/`tableName`/`origin`/`filePath`/`line`/`functionName`/`functionStartLine/Column` (one SQL table reference per fact).
- **Grammar checklist**: table references come from DB-provenanced `call_expression` SQL-string args (`.query("SELECT …")`, `.raw`, ORM `insert/update/delete/create/select`) and `.sql` DDL — the `usageType` verb is parsed from SQL text, not a node type.
- **Coverage**: handled = the pure set-difference. Mishandled = tables read only via dynamic/ORM/reflection SQL (read side invisible → false positive), query-builder-only tables (excluded).
- **Evidence**: samples = yes (`ruleRegistry.ts:1701-1708`); parity = `spec68-cross-domain-parity.spec.ts:126-237`; fixture = **ABSENT** (bench corpus `bench/corpus/cross-domain/src/`); baseline = `corpus-baselines.md:90,257,431,539,695,911`; ledger = `rule-authenticity-ledger.md:91`.

### `cross-domain/read-never-written` (91)

- **Claim**: `'Table "{table}" is read but never written.'` (`ruleRegistry.ts:1713`).
- **Firing condition**: a table with ≥1 `select`, ≥1 non-query-builder row, and no write row (`insert|update|delete|create`) (`crossDomain.ts:274-298`). Unlike `written-never-read`, `create`/`delete` stay in the write set.
- **Input position**: `schema-usage` → `usageType`/`tableName`/etc.
- **Grammar checklist**: same as `written-never-read`.
- **Coverage**: handled = exact inverse set comparison. Mishandled = cannot distinguish a genuine missing-write bug from an externally-managed table; writes outside the scanned corpus invisible.
- **Evidence**: samples = yes (`ruleRegistry.ts:1715-1723`); parity = `spec68-cross-domain-parity.spec.ts:126-237`; fixture = **ABSENT**; baseline = `corpus-baselines.md:87,251,446,914`; ledger = `rule-authenticity-ledger.md:92`.

### `cross-domain/multi-table-write` (92)

- **Claim**: `'Function writes to {count} distinct tables.'` (`ruleRegistry.ts:1728`).
- **Firing condition**: group write rows (`insert|update|delete` — `TXN_WRITE_TYPES` excludes `create`) by `(file, coordinate, table)`, take `MIN(line)`, group by function into a direct write set, depth-1-expand via `call-graph` callees, flag when `allTables.size >= txnTableMax` (4) unless a `batch-functions` span encloses the write line (`crossDomain.ts:441-458`).
- **Input position**: `schema-usage` → write rows; `call-graph` → `functions`/`callEdges`; `batch-functions` → `file`/`startLine`/`endLine`.
- **Grammar checklist**: `call_expression` (DB write verbs) for writes; `call_expression`/`member_expression` edges for the graph; function nodes containing a `.batch(` call.
- **Coverage**: handled = direct + depth-1 expanded write set with batch-span suppression. Never-seen = `create` (excluded), >depth-1 chains, resolution failures (degrade to direct set).
- **Evidence**: samples = yes (`ruleRegistry.ts:1731-1738`); parity = `spec68-cross-domain-parity.spec.ts:241-466`; fixture = **ABSENT**; baseline = `corpus-baselines.md:101,182-185,690,919`; ledger = `rule-replacement-ledger.md:1823` (rename) — **no own row** in `rule-authenticity-ledger.md`.

### `cross-domain/no-validator-reachable` (93)

- **Claim**: `'No validator reachable within BFS depth: {detail}.'` (`ruleRegistry.ts:1743`).
- **Firing condition**: gated on `thresholds['validatorBypass']` present; build validator set (user-config → `VALIDATOR_PACKAGES` provenance → `validate`/`assert` name heuristic), BFS (depth 3) from each writer to any validator, flag uncovered writers per directory when `dirWriterList.length >= 20` and `coveredCount/total >= 0.8` (`crossDomain.ts:662-694`).
- **Input position**: `schema-usage` → writer rows; `call-graph` → `functions` (`usedImports` JSON, `isExported`) + `callEdges`.
- **Grammar checklist**: `call_expression` (DB write verbs) for writers; `call_expression` edges for the graph; the validator set is provenance over `used_imports` + a name prefix, not a grammar production.
- **Coverage**: handled = three-source validator identification + BFS reach. Never-seen = validators not in `VALIDATOR_PACKAGES` and not matching the prefix; writes with no `functions` row (INNER JOIN drops them).
- **Evidence**: samples = yes (`ruleRegistry.ts:1746-1753`); parity = `spec68-cross-domain-parity.spec.ts:468-652`; fixture = **ABSENT**; baseline = `corpus-baselines.md:103`; ledger = `rule-replacement-ledger.md:1900` (rename) — **no own row** in `rule-authenticity-ledger.md`.

### `cross-domain/uncovered-risk` (94)

- **Claim**: `'Uncovered risk: {detail}.'` (`ruleRegistry.ts:1758`).
- **Firing condition**: gated on `thresholds['coverage']` present; rank exported functions by hotspot `PERCENT_RANK` (top decile, `topRiskDecile` 0.1); measured path (if `coverage.measuredCount > 0`) flags top-decile exported functions with no `covered=1`; else static-reach fallback flags top-decile functions not reachable via BFS (depth 2) from `testGlobs`-matched files (`crossDomain.ts:975-988`).
- **Input position**: `call-graph` → `functions` + `callEdges`; `hotspot` → `target`/`score`; `coverage` → `entries`/`measuredCount`/`source`.
- **Grammar checklist**: **none** — all inputs are index tables projected to facts; test-file globs are filename patterns.
- **Coverage**: handled = measured path + static-reach fallback. Mishandled = static fallback substitutes call-graph reachability for actual coverage; measured path relies on `code-audit coverage --import`.
- **Evidence**: samples = yes (`ruleRegistry.ts:1761-1768`); parity = `spec68-cross-domain-parity.spec.ts:655-796`; fixture = **ABSENT**; baseline = **ABSENT**; ledger = `rule-authenticity-ledger.md:95`.

## secrets + security (95–97)

Rules in `src/phase/rules/securityDefects.ts` (and `secrets.ts` for `hardcoded-secret` at #30). Producers in `src/phase/securityCandidates.ts` / `secretCandidates.ts` do the AST walking; the rule bodies are thin filters over `security-candidates`/`secret-candidates`.

### `command-injection-risk` (95)

- **Claim**: `"Unsafe process invocation: {method} is passed a command built by interpolation/concatenation."` (`ruleRegistry.ts:1775`).
- **Firing condition**: filter `kind === 'command-injection'` + test/fixture skip. Predicate in producer `commandInjectionCandidate`: callee `children[0].type === 'identifier'` (member callees excluded), `fnName ∈ SHELL_PROCESS_FUNCTIONS`, first arg exists, then `unsafe` = template-with-`template_substitution` OR `binary_expression` with `+` operator and a non-literal operand (`isLiteralNode`).
- **Input position**: `security-candidates` → `.fnName`; `line`/`column` = `call_expression` node start. Source region = `call_expression` `function` + first `arguments` child.
- **Grammar checklist**: callee `identifier` (rejected `member_expression`, tagged-template form). Command node handled: `template_string` (with `template_substitution`), `binary_expression` (`+`). Legal-but-never-fire: bare `string`, `number`, `identifier`, `call_expression`, `parenthesized_expression`, `ternary_expression`, non-`+` binary.
- **Coverage**: handled = interpolated template and `+`-concat first args. Mishandled = variable/call-result command (no taint), tagged-template form, `.concat()`. Never-seen = `spawn(cmd, args)` with computed identifier command.
- **Evidence**: samples = yes (`ruleRegistry.ts:1778-1785`); parity = `spec68-security-defects-parity.spec.ts:65-89` + `spec61-exploits.spec.ts:430-435`; fixture = **ABSENT**; baseline = `corpus-baselines.md:907,985,1042-1070`; ledger = `rule-authenticity-ledger.md:127`, `severity-assignment-ledger.md:392`; `rule-replacement-ledger.md` = **ABSENT**.

### `dynamic-require-of-project-path` (96)

- **Claim**: `"Dynamic require/import of a project config path: {path}."` (`ruleRegistry.ts:1790`).
- **Firing condition**: filter `kind === 'dynamic-require'` + `accept: isConfigPath(argText)`. `isConfigPath` = lowercased `argText` matches `/config/` AND `/path|file|dir|join\(|resolve\(|pathtofileurl|href/`. Producer requires callee `require`/`import`/`createRequire` and a non-literal first arg whose raw text is `argText`.
- **Input position**: `security-candidates` → `.argText` (raw specifier source); `line`/`column` = `call_expression` start. Source region = the entire first-argument raw text.
- **Grammar checklist**: callee `identifier` `require` / `import` node / outer `call_expression` over `createRequire`; argument = any non-literal expression (`identifier`, `call_expression`, `binary_expression`, substituted `template_string`).
- **Coverage**: handled = computed args whose raw text contains "config" + a path marker. Mishandled = a genuinely project-discovered path whose expression lacks the literal substring `config`; `module.require`/`module.createRequire`. Never-seen = `createRequire` bound as `module.createRequire`.
- **Evidence**: samples = yes (`ruleRegistry.ts:1794-1800`); parity = `spec68-security-defects-parity.spec.ts:91-115`; fixture = **ABSENT**; baseline = `corpus-baselines.md:1024,1055`; ledger = `rule-authenticity-ledger.md:128`, `severity-assignment-ledger.md:393`; `rule-replacement-ledger.md` = **ABSENT**.

### `unescaped-html-interpolation` (97)

- **Claim**: `"Unescaped HTML interpolation: {field} is inserted into an HTML template without an escaping call."` (`ruleRegistry.ts:1806`).
- **Firing condition**: filter `kind === 'unescaped-html'`. All structural work in the producer: `computeHtmlSinkTemplates` (local flow → sink roots → backward worklist); sink roots = `insertAdjacentHTML` 2nd arg, `res.send`/`res.write`/`setHTMLUnsafe`/`.html(x)` 1st arg, `innerHTML`/`outerHTML` assignment, `__html` pair, `dangerouslySetInnerHTML` attr, `template_string` fragment `/v-html\s*=/i`; for each sink-reaching substitution, skip `ESCAPE_FNS`-wrapped calls, unwrap `||`/`??` string-fallback, terminal value must be a `member_expression` whose `property_identifier` is `prop`.
- **Input position**: `security-candidates` → `.prop`; `line`/`column` = `template_substitution` node start.
- **Grammar checklist**: `template_string` (`string_fragment`/`template_substitution`); terminal value `member_expression` (`property` = `property_identifier`, `#priv` missed).
- **Coverage**: handled = `${user.name}` member access reaching an HTML sink (with `||`/`??` unwrap, escape-wrap skip, script/style skip). Mishandled = bare identifiers, call results, ternaries, literals, subscripts, private fields; numeric member fields (`e.rank`) still fire. Never-seen = interpolation outside a sink-reaching template.
- **Evidence**: samples = yes (`ruleRegistry.ts:1811-1828`); parity = `spec68-security-defects-parity.spec.ts:117-135`; fixture = **ABSENT**; baseline = `corpus-baselines.md:1033,1056,1059-1077`; ledger = `rule-authenticity-ledger.md:129`, `severity-assignment-ledger.md:394`; `rule-replacement-ledger.md` = **ABSENT**.

---

## Cross-cutting A — rules whose condition is a source-region pattern

The 97 per-rule sections above each document a firing condition. Those conditions split into two
species:

- **A relation over located facts** — the rule's `analyze(ctx)` reads discrete fact fields (a
  symbol's `name`, `line`, `column`, a `count`, a `receiver`) and computes a *relation* over them:
  `count > threshold`, `name ∈ set`, `a ∈ b`. The input is already located and already typed; the
  rule never sees a raw string.
- **A pattern over a source region** — the discrimination is a **regex or string predicate run over
  raw text**: a function body, a query string, a code fragment, a specifier, a value literal. The
  "fact" carries a located anchor (file/line) but the *decision* is made by pattern-matching the
  text, not by comparing located fields.

The two-phase model (Spec 68) did not eliminate the second species. It moved those patterns one
layer down — out of the rule body and into the **producer** — but a regex over raw text is still a
regex over raw text. The producer emits a located fact whose *existence* (or whose single field)
*is* the pattern match; the rule then reads that field. The phase-model rule looks like a relation,
but the condition that actually decides whether it fires lives in the producer's regex. The three
canonical instances named in the request are all in the data-access/schema family; the full
inventory is wider.

### The canonical three (as cited)

1. **`countQueries(funcText)`** — `too-many-queries` (28), `complex-query` (27).
   Predicate is three regex passes over the function-body *source text*
   (`src/analyzers/universal/schema/codeAnalysis.ts:1463-1482`):
   - eager-call count `/\.(?:query|execute|run|first|raw|batch)\b[^()\n]*\(|(?<!Promise)\.all\b[^()\n]*\(/g`,
   - `.exec`-body probe `countExecCallsWithSql(text)` (balanced-paren walk + `SQL_QUERY_PATTERNS`),
   - leftover keyword count `SQL_QUERY_PATTERNS` = `/SELECT\s+/gi`,
     `/INSERT(?:\s+OR\s+(?:IGNORE|REPLACE))?\s+INTO|REPLACE\s+INTO/gi`,
     `/(?<!DO\s)(?<!KEY\s)UPDATE\s+/gi`, `/DELETE\s+FROM/gi`.
   **Region**: the function body text. No AST node kinds are consulted for the count itself — a
   query is a *call-site + keyword* textual signature, not a tree shape.

2. **`extractTables`' `/FROM\s+(\w+)/`** — `complex-query` (27), `missing-org-filter` (29),
   `unknown-table`. The cited `/FROM\s+(\w+)/` is a shorthand for the real default `sql` pattern
   (`UniversalDataAccessAnalyzer.ts:174`):
   `/FROM\s+["'`]?([\p{L}\p{N}_]+)["'`]?/giu`, plus the sibling `INSERT … INTO` / `DELETE … FROM` /
   `JOIN` / `UPDATE` capture regexes and the ORM/query-builder arm
   `/from\s*\(\s*["'`]?([\p{L}\p{N}_]+)["'`]?\s*\)/giu` + the Kysely `selectFrom`/`deleteFrom`/…/
   `db.<table>.<method>(`/`db.<table>.<method>` patterns. **Region**: the query fragment text.

3. **`hasOrganizationFilter`'s alternation** — `missing-org-filter` (29)
   (`UniversalDataAccessAnalyzer.ts:1616-1683`). Four regexes are *built* from an alternation
   `(?:candidate|candidate|…)` over `config.organizationPatterns` (default 8 candidates:
   `organizationid, organization_id, orgid, org_id, tenantid, tenant_id, companyid, company_id`),
   matched over the query text:
   - comparison `\balt\b\s*(?:=|!=|<>|<=|>=|<|>|\bIS\b|\bIN\b|\bLIKE\b)`,
   - helper `\b(?:eq|ne|notEq|gt|gte|lt|lte|inArray|notInArray|like|ilike|notIlike|between|notBetween)\s*\(\s*(?:[\w$]+\.)*\s*\balt\b\s*,\s*(?!\s*[\w$]+\s*\.)`,
   - object-filter `\b(?:where|andWhere|orWhere|whereEq|whereNot|having|on|set|values|data)\s*(?:\(|:)\s*\{[^{}]*\balt\b\s*:`,
   - positional `\b(?:where|andWhere|orWhere|whereEq|whereNot|having|on)\s*\(\s*['"`]\s*alt\s*['"`]`.
   **Region**: the query text. This is the clearest case: a name *list* (the org-column
   candidates) is compiled into a source-region *regex*, so the firing condition is a pattern over
   raw text even though its seed is a name list (see Section B).

### The rest of the inventory

Every remaining source-region pattern, grouped by owning analyzer. Each entry gives the pattern
(quoted where it is short enough), the region it scans, and the rule(s) it decides.

**data-access (`src/analyzers/universal/UniversalDataAccessAnalyzer.ts`)** — the largest family.

- `hasQueryFilter(text)` (1695-1700) — `unfiltered-query` (25): `/\bWHERE\b/`, `/\bHAVING\b/`,
  `/\bLIMIT\b/` over uppercase, comment-stripped text, plus `whereClauseIsTautology`. **Region**:
  query text.
- `DANGEROUS_SQL_PATTERNS` (`schema/codeAnalysis.ts:738-742`) — `sql-injection-risk` (26): three
  regexes, e.g. `/query\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`/g`. **Region**: query text.
- `isRawSqlInsert` / `rawInsertColumnList` (104-120) — `sql-injection-risk` (26): raw-insert
  keyword + column-list parsing over query text.
- `isOrmPattern` (1496-1536, 32 regexes) — data-access producer: ORM-shape recognition
  (`.select().from()`, `db.<table>.<method>(`, etc.) over the call text. **Region**: query/call text.
- `LLM_PROVIDER_RE` (`/(?:anthropic|openai|deepseek|claude|gpt|gemini|cohere|mistral|bedrock|vertex|ollama|llm|gateway)/i`)
  and `LLM_ACTION_RE` (`/(?:embed|reembed|completion|chat|prompt|synthesize|thesis|agent|classify|summarize|translate)/i`)
  (2058-2069) — data-access producer: LLM-call classification over call text.
- `extractTables`'s full regex family (already the canonical #2) — `complex-query` (27),
  `missing-org-filter` (29), `unknown-table`.

**schema-code / schema-validator / schema-json.**

- `DDL_RE` = `/(CREATE)\s+(?:VIRTUAL\s+)?TABLE…|(DROP)\s+TABLE…|(ALTER)\s+TABLE…\s+RENAME\s+TO…/gi`
  (`schema/migrations.ts:212`) and `DDL_PRESENCE_RE` = `/(?:CREATE|DROP|ALTER)\s+(?:VIRTUAL\s+)?TABLE/i`
  (585) — the DDL rules (`reserved-word`, `missing-schemas`, `table-naming-convention`,
  `duplicate-schema-declaration`, `unknown-table`'s migration arm). **Region**: migration/source DDL text.
- `replayDdlDeclarations` (99-202) — ordered DDL op extraction over migration SQL text.
- `ORM_OBJECT_RE` = `/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([^'"]+)['"]/g`
  (`phase/schemaObjects.ts:38`) — `schema-validator` (66-68). **Region**: source text (ORM-builder
  bindings). The completeness oracle counts the *same* regex (`oracles.ts:217-219`), making this
  the only producer whose oracle is the pattern itself rather than a dumb tree-node count.

**solid.**

- `extractInstanceofTargets` = `/\binstanceof\s+([A-Za-z_$][\w$]*)/` (`phase/fileSymbols.ts:327-331`)
  — `open-closed` (16). **Region**: file source text. The OCP target set is *produced* by this
  regex, then related (`target ∉ interface/abstract names`), so the rule is a hybrid: a
  source-region pattern feeding a relation.

**Go.**

- channel-op receive detection `getNodeText(node, '').trimStart().startsWith('<-')`
  (`phase/goFunctionAnalysis.ts:215,274`) — `channel-deadlock` (14). **Region**: the channel-operation
  node's source text. A raw-text *prefix* check, not a node-kind relation — the one Go rule whose
  producer discriminates by string rather than by tree shape.

**security.**

- `isConfigPath(argText)` = lowercased `/config/` **AND** `/path|file|dir|join\(|resolve\(|pathtofileurl|href/`
  — `dynamic-require-of-project-path` (96). **Region**: the entire first-argument raw text.
- `computeHtmlSinkTemplates` (97) — `unescaped-html-interpolation`: a backward worklist over the
  AST, but the sink-root detection includes `/v-html\s*=/i` matched against a `string_fragment`
  node's text. **Region**: template-string fragment text (plus the AST worklist).
- `hardcoded-secret` (30) value arm — `hasKnownTokenPrefix`
  (`/^Bearer\s/i`, `/^sk-[A-Za-z0-9]{20,}/`, `/^(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9]{20,}/`,
  `/^(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/`, `/^AKIA[0-9A-Z]{16}$/`, `/^xox[baprs]-/`,
  `/^eyJ[A-Za-z0-9_-]{10,}\./`) and `isPlaceholder` (`/^<[^>]+>$`, `/^[.…]{3,}$/`, `/^[*xX]{3,}$/`,
  `/^redacted$/i`) over the **value string**. The *name* arm is Section B (`SECRET_NAMES`); the
  *value* arm is a source-region pattern over the literal.

**react.**

- missing-key performance leg-3 (`reactAnalyzer.ts:309-312`):
  `source.includes('.map(') && … && !source.includes('key=')` over the **raw component source**.
  A string `includes` predicate — the crudest form of a source-region pattern.

**dry.**

- `isNameLiteral(value)` (5 regexes: `VOCABULARY_TOKEN`, `RELATIVE_MODULE`, `CLI_OPTION`,
  `SEPARATOR_ONLY`, `DOTTED_NAME`, `dry.ts:131-152`) — `duplicate-string-literal` (24): whether a
  quoted literal is a *name* rather than a *value* is decided by regex over the literal text.
- `normalizeCode` / `normalizeStructure` / `hashCode` (SHA256, `phase/codeBlocks.ts:80-99`) —
  the block rules (structural-similarity, expression-similarity): similarity is a
  normalized-text + hash/bigram comparison over the **block text**, not a relation over located
  facts.

**The counterexample worth naming.** `command-injection-risk` (95) is the one security rule whose
predicate is *fully AST-structural* — `children[0].type === 'identifier'`, `template_substitution`
vs `string_fragment`, `binary_expression` with `+` — and its only name list (`SHELL_PROCESS_FUNCTIONS`)
is a plain set-membership (Section B), not a compiled regex. It demonstrates the clean form the
Section-A family has *not* yet reached.

### Section A — the complete list

| # | Pattern | Rules decided | Region scanned |
|---|---------|---------------|----------------|
| 1 | `countQueries` (eager-call + `SQL_QUERY_PATTERNS` + `.exec` probe) | 27, 28 | function body text |
| 2 | `extractTables` (`FROM`/`INSERT`/`DELETE`/`JOIN`/`UPDATE` + ORM `.from(` + Kysely + `db.<t>.<m>(`) | 27, 29, unknown-table | query text |
| 3 | `hasOrganizationFilter` (4 compiled alternation regexes) | 29 | query text |
| 4 | `hasQueryFilter` (`WHERE`/`HAVING`/`LIMIT`) | 25 | query text |
| 5 | `DANGEROUS_SQL_PATTERNS` (3) | 26 | query text |
| 6 | `isRawSqlInsert` / `rawInsertColumnList` / write-verb regexes | 26 | query text |
| 7 | `isOrmPattern` (32) | 26, 27, 29 | query/call text |
| 8 | `LLM_PROVIDER_RE` / `LLM_ACTION_RE` | 26 (LLM arm) | call text |
| 9 | `DDL_RE` / `DDL_PRESENCE_RE` / `replayDdlDeclarations` | 54-58 (schema DDL) | migration/source DDL text |
| 10 | `ORM_OBJECT_RE` | 66-68 | source text |
| 11 | `extractInstanceofTargets` `/\binstanceof\s+…/` | 16 | source text |
| 12 | channel-op `<-` prefix | 14 | channel-op node text |
| 13 | `isConfigPath` (`/config/` AND path marker) | 96 | argument raw text |
| 14 | `computeHtmlSinkTemplates` (+ `/v-html\s*=/i`) | 97 | template fragment text |
| 15 | `hasKnownTokenPrefix` / `isPlaceholder` / `HARD_SYMBOL` | 30 (value arm) | value literal text |
| 16 | `source.includes('.map(')` heuristic | 63 (react missing-key) | component source text |
| 17 | `isNameLiteral` (5 regexes) + `normalizeCode`/`hashCode` | 24, 18-23 (dry) | literal / block text |

---

## Cross-cutting B — rules consulting a name / suffix / receiver list

The second species is the **name/suffix/receiver list**: a fixed vocabulary of names, suffixes, or
receiver tokens that a rule tests by **membership** or **substring** — `name ∈ SECRET_NAMES`,
`receiver.includes(token)`, `name.startsWith('Test')`. Unlike Section A, there is no regex over a
region; the condition is a set lookup against a located, already-typed symbol field. Two of the
lists named in the request no longer exist under the cited name — the refactor renamed them, and
the correct homes are recorded below.

### The renamed symbols (address first)

- **`isAbstractionBoundary`** — does not exist under this name. The cited "suffix regex" is the
  **concern classifier** in `src/analyzers/universal/functionConcerns.ts`. It does not use a single
  "abstraction boundary" regex; it is `classifyCall(calleeText)` → `trailingIdentifier`
  (`/([A-Za-z_$][\w$]*)\s*$`) + `receiverText` (`lastIndexOf('.')`), then membership against the
  seven name sets below + a `DATA_RECEIVERS` substring test. It feeds `single-responsibility` (15):
  a function is flagged when its calls span ≥2 of the three *voting* concerns. The full list
  inventory follows under "concern classifier".
- **`GO_GROUP_RULES`** — does not exist under this name. The correct symbol is the **`goRules`
  array** in `src/phase/rules/goRules.ts:268`, which is *not* a name list: it is the array of the
  five migrated Go rule *definitions* (`importOrganization`, `importStyle`, `errorHandling`,
  `concurrency`, `channelDeadlock`). The name lists the Go rules actually consult are
  `SYNC_METHOD_NAMES` (7), `COMPLEXITY_NODES` (7, a node-type list), and `isTestFunction`'s four
  prefixes — recorded below under "Go".

### The name lists (complete, grouped by owning module)

**Concern classifier — `functionConcerns.ts`** (feeds `single-responsibility` 15).

| List | Len | Stands in for |
|------|-----|---------------|
| `VOTING_CONCERNS` | 3 | `data-access`, `messaging`, `rendering` — the only concerns that *count* toward SRP span. |
| `NESTED_FUNCTION_TYPES` | 8 | node types that open a nested closure boundary (the walk does not descend): `function_declaration`, `function_expression`, `arrow_function`, `method_definition`, `generator_function_declaration`, `generator_function_expression`, `method_declaration`, `func_literal`. |
| `BARE_DATA_VERBS` | 15 | data-access verbs unambiguous without a receiver: `query fetch findone findmany findall findbyid findby insert update delete upsert save persist migrate runquery`. |
| `DATA_VERBS` | 43 | `BARE_DATA_VERBS` + 28 receiver-gated verbs (`find get getone getbyid remove execute count sum avg max min post put patch head del list create read truncate findbypk updateone updatemany deleteone deletemany bulkcreate bulkinsert findandupdate`) — data access *only* on a data handle. |
| `DATA_RECEIVERS` | 36 | receiver substrings that mark a data handle (`database datastore repository repo connection conn client collection model cursor session store pool querybuilder prisma knex sequelize mongoose redis mongo orm dynamodb firestore supabase postgres mysql sqlite axios graphql superagent request api http https db sql`). Deliberately excludes `rows`/`results`/`records`. |
| `TRANSFORM_VERBS` | 39 | array/collection shaping verbs (`map filter reduce sort groupby group flatmap slice find findindex findlast some every concat join reverse includes indexof flatten compact uniq unique merge pick omit normalize transform stringify serialize format keys values entries assign clone deepclone pluck chunk shuffle`). |
| `MESSAGING_NAMES` | 18 | side-channel signals (`email mail notify notification sms publish enqueue broadcast newsletter mailer sendemail sendmessage sendnotification sendmail sendsms sendtext pushnotification textmessage`); `send*` and `alert` deliberately absent. |
| `LOGGING_NAMES` | 17 | observability/audit verbs (`logevent logerror loginfo logwarn logwarning logdebug logmessage audit track trackevent analytics telemetry metric sentry logger gtag ga`); `console.*` deliberately absent. |
| `RENDERING_NAMES` | 9 | presentation verbs (`render rendertostring display template markdown draw print rendercomponent paint`); `createElement` deliberately absent. |
| `trailingIdentifier` | — | regex `/([A-Za-z_$][\w$]*)\s*$/` — the "suffix" half of the cited `isAbstractionBoundary`. |

**file-symbols — `phase/fileSymbols.ts`.**

| List | Len | Stands in for |
|------|-----|---------------|
| `BUILTIN_TYPES` | 56 | built-in/platform types exempt from the OCP interface-vs-class check: JS built-ins + typed arrays + web platform globals (`Date Array Object Map Set … Request Response Headers ReadableStream WritableStream TransformStream`). |

**schema config — `schema/config.ts`.**

| List | Len | Stands in for |
|------|-----|---------------|
| `DB_RECEIVER_NAMES` | 4 | `db database sql stmt` — receiver names that mark a DB handle. |
| `DB_CALL_METHOD_NAMES` | 6 | `exec prepare batch run all first` — the fixed DB-call API surface. |
| `SQL_CARRYING_METHOD_NAMES` | 5 | `exec prepare query raw execute` — methods whose *first* arg is SQL text (vs a params array). |
| `DB_BINDING_NAMES` | 1 | `env.DB` — the Cloudflare D1 binding. |
| `DB_WRAPPER_NAMES` | 2 | `d1Query d1Exec` — D1 wrapper helpers. |
| `SQL_TAG_NAMES` | 2 | `sql db` — tagged-template SQL tag names. |

**provenance — `analyzers/provenance.ts`.**

| List | Len | Stands in for |
|------|-----|---------------|
| `DB_PACKAGES` | 16 | known DB driver/ORM package names (`better-sqlite3 drizzle-orm @prisma/client pg mysql2 postgres kysely knex mongodb mongoose @libsql/client @planetscale/database @neondatabase/serverless @vercel/postgres bun:sqlite node:sqlite`). |
| `VALIDATOR_PACKAGES` | 9 | validator library names (`zod joi ajv valibot yup superstruct arktype @sinclair/typebox class-validator`). |
| `DB_TYPES` | 10 | known DB type names for propagation (`D1Database D1PreparedStatement D1Result Database Pool PrismaClient Kysely Connection SqliteDatabase BetterSQLite3Database`). |
| `DB_CALL_METHODS` | 8 | `exec prepare batch run all first query raw` — the fixed DB-call surface (superset of `DB_CALL_METHOD_NAMES`). |
| `ORM_METHODS` | 39 | ORM recognition surface (find/findOne/…/where/join/leftJoin/… + Kysely `selectFrom`/`selectAll`/…). |

**schema-code — `schema/codeAnalysis.ts`.**

| List | Len | Stands in for |
|------|-----|---------------|
| `systemTables` | 7 | `information_schema pg_catalog mysql performance_schema sys sqlite_master sqlite_sequence` — schema prefixes excluded from unknown-table. |
| `TABLE_VALUED_FUNCTIONS` | 25 | table-valued function names (`json_each unnest generate_series … read_csv glob range`) — not real tables. |
| `SQL_KEYWORDS` | 83 | the SQL keyword vocabulary (incl. `the a an`) used to drop keywords captured as tables. |
| `reserved` | 6 | `user order group table column index` — reserved words for `table-naming-convention`. |

**Go — `phase/goFunctions.ts`, `phase/goFunctionAnalysis.ts`.**

| List | Len | Stands in for |
|------|-----|---------------|
| `COMPLEXITY_NODES` | 7 | node types counted for complexity (`if_statement for_statement expression_switch_statement type_switch_statement expression_case type_case default_case`). |
| `SYNC_METHOD_NAMES` | 7 | `Add Done Wait Lock Unlock RLock RUnlock` — sync-package methods marking concurrency (`concurrency` rule). |
| `isTestFunction` prefixes | 4 | `Test Benchmark Example Fuzz` — Go test-function name prefixes exempting `*_test.go` producers. |

**React — `analyzers/reactAnalyzer.ts`, `utils/reactDetection.ts`.**

| List | Len | Stands in for |
|------|-----|---------------|
| `builtInHooks` | 15 | React built-in hook names (`useState useEffect useContext useReducer useCallback useMemo useRef useImperativeHandle useLayoutEffect useDebugValue useId useDeferredValue useTransition useSyncExternalStore useInsertionEffect`). |
| `NEXT_ERROR_BOUNDARY_BASENAMES` | 8 | `error.{ts,tsx,js,jsx}` + `global-error.{ts,tsx,js,jsx}` — Next.js error-boundary basenames (`no-error-boundary`). |
| `nonInteractiveElements` | 3 | `div span section` — elements that must not carry `onClick` (accessibility). |
| `rawElementWatchList` | 5 | `button input select textarea table` — elements watched for missing keys (config `rawElementWatchList`). |

**dry — `phase/rules/dry.ts`.**

| List | Len | Stands in for |
|------|-----|---------------|
| `FLUENT_CHAIN_METHODS` | 163 | well-known fluent-API method names (query/schema builders, validators, commander, promises, DOM/stdlib chains) that are "structurally similar by design" — the expression-similarity rule stays quiet on them. |
| `excludePatterns` | 10 | test/spec globs (`**/*.test.ts` … `**/test/**`) excluding test code from block similarity. |

**code-blocks — `phase/codeBlocks.ts`.**

| List | Len | Stands in for |
|------|-----|---------------|
| `keywords` | 50 | the reserved-word set kept intact during structure normalization (48 language keywords + `ID`/`LIT` markers). |
| `blockTypes` | 7 | `if_statement for_statement for_in_statement while_statement do_statement switch_statement try_statement` — significant block node types. |

**data-access — `UniversalDataAccessAnalyzer.ts`.**

| List | Len | Stands in for |
|------|-----|---------------|
| `SQL_KEYWORDS` | 11 | `SELECT INSERT UPDATE DELETE FROM WHERE JOIN CREATE DROP ALTER TRUNCATE` — keyword probe for `.exec` query counting. |
| `iteratorMethods` | 9 | `forEach map filter reduce some every find findIndex flatMap` — array-iteration methods exempt from raw-SQL insert detection. |

**conventions — `conventions/conventionMiner.ts`.**

| List | Len | Stands in for |
|------|-----|---------------|
| `BUILT_IN_CALLEES` | 144 | JS/stdlib built-in callee names (Array/String/Object/Math/JSON/Promise/Console/Timers/Number/RegExp/Map/Set/Error) excluded from mined-convention callee counts — a call to `.map()`/`JSON.parse`/`setTimeout` is not a project convention. |

**security — `phase/securityCandidates.ts`, `phase/rules/secrets.ts`.**

| List | Len | Stands in for |
|------|-----|---------------|
| `SHELL_PROCESS_FUNCTIONS` | 8 | `execSync exec execFile execFileSync spawn spawnSync fork execAsync` — unsafe process-invocation callees (`command-injection-risk`). |
| `ESCAPE_FNS` | 8 | `escapeHtml htmlEscape escape escapeHTML sanitize sanitizeHtml h e` — escaping calls that neutralize an HTML interpolation (`unescaped-html-interpolation`). |
| `RECEIVER_PASSTHROUGH_METHODS` | (partial) | `join concat toString valueOf slice substring substr …` — methods whose result still carries the receiver's value (taint flows). |
| `SECRET_NAMES` | 22 | secret-bearing identifier names (`password passwd pwd passphrase secret clientsecret apikey accesskey accesstoken authtoken token privatekey credential credentials awssecret awskey sessionkey signingkey authorization xapikey xauthtoken`), normalized lowercased-with-nonalnum-stripped (`hardcoded-secret` name arm). |
| `PLACEHOLDERS` | 42 | placeholder/example values (`password changeme secret dummy todo fixme xxx test 123456 qwerty foobar sample insecure …`) that suppress a secret finding. |

### Section B — the complete list

Twenty-eight name/suffix/receiver lists total, across ten owning modules. Four named in the request
resolve as follows: `DB_RECEIVER_NAMES` (real, 4), `isAbstractionBoundary`'s suffix regex (renamed —
the `functionConcerns.ts` classifier, above), `BUILTIN_TYPES` (real, 56), `GO_GROUP_RULES` (renamed —
the `goRules` array of 5 rule *definitions*, whose actual name lists are `SYNC_METHOD_NAMES`/
`COMPLEXITY_NODES`/`isTestFunction` prefixes). The three largest are `FLUENT_CHAIN_METHODS` (163),
`BUILT_IN_CALLEES` (144), and `SQL_KEYWORDS` (83, schema-code); the smallest are `DB_BINDING_NAMES`
(1) and `DB_WRAPPER_NAMES`/`SQL_TAG_NAMES` (2 each).

**What each list stands in for, in one line.** Every entry is a hand-maintained proxy for a
language or API surface that the tool cannot derive structurally: a DB handle (`DB_RECEIVER_NAMES`),
a DB call surface (`DB_CALL_METHODS`), an ORM method surface (`ORM_METHODS`, `FLUENT_CHAIN_METHODS`),
a concern vocabulary (`BARE_DATA_VERBS`/`DATA_VERBS`/`DATA_RECEIVERS`/…), a secret-name vocabulary
(`SECRET_NAMES`), an escaping vocabulary (`ESCAPE_FNS`), a built-in/platform type set
(`BUILTIN_TYPES`), or a built-in-callee set (`BUILT_IN_CALLEES`). They are the enumerable,
"we can't see the runtime, so we enumerate the names" category of the rule evidence — the
complement of Section A's "we pattern-match the text" category. Together the two sections are the
point of this document: they name every place a rule's truth rests on a regex over raw text or a
hand-enumerated name, rather than on a relation over facts the tree already located and typed.

