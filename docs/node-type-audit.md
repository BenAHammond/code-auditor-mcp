# Node-type string-literal audit

**Date:** 2026-10-08
**Scope:** every string literal in `src/` compared against a tree-sitter node
type (`.type === '…'`, `getNodeType(…) === '…'`, `case '…'`, `findChildOfType(…,
'…')`, and type-name `Set`/array literals). This is the systemic check Ben
requested alongside the 14-site source-text-read sweep.

**Method.** The authoritative node-type vocabulary is the shipped grammar set —
five grammars, no `javascript` grammar (`.js`/`.jsx` parse with the
`typescript` grammar, per `parser.ts`):

| grammar | package | node-types.json |
|---|---|---|
| typescript | `tree-sitter-typescript@0.23.2/typescript` | 316 named types |
| tsx | `tree-sitter-typescript@0.23.2/tsx` | 326 named types |
| go | `tree-sitter-go@0.25.0` | 188 named types |
| css | `tree-sitter-css@0.25.0` | 104 named types |
| scss | `tree-sitter-scss@1.0.0` | 148 named types |

Every snake_case literal found in a node-type-comparison context was diffed
against the union of these five sets. Each literal reported below as *dead* was
confirmed absent from the grammar **and** verified against a live parse of the
construct (fragment, class field, rest parameter, interface method, switch
case, JSX, generator/class expression, `typeof`, heritage, tagged template).

---

## Findings

### Tier A — real correctness bugs (dead type, no correct fallback, live code)

These are node-type literals that never match at runtime, and there is **no**
correct sibling check, so the guarded branch silently never fires.

| dead literal | correct type | where | effect |
|---|---|---|---|
| `method_spec` | `method_elem` | `languages/go/GoAdapter.ts:85,420` | Go interface methods are never extracted — `extractName` returns null and `buildInterfaceInfo` records only embedded types, so interface method members are dropped. |
| `expression_case_clause` | `expression_case` | `languages/go/GoAdapter.ts:285` | Go `switch` case clauses are never added to cyclomatic complexity (undercount). |
| `type_case_clause` | `type_case` | `languages/go/GoAdapter.ts:284` | Go type-switch case clauses never added to complexity (undercount). |
| `named_exports` | *(none — `export_clause` holds `export_specifier` children directly)* | `utils/astUtils.ts:191,574` | `getExports`/`getReExports` silently drop **all** named exports and re-exports (`export { a, b }`). Live via `functionScanner.ts:164`. |
| `heritage_clause` | `class_heritage` (classes) / `extends_type_clause` (interfaces) | `utils/astUtils.ts:766,779,831` | `isHeritageExtendsTypeUsage`, `isClassImplementsTypeUsage`, `isAncestorTypeUsage` never detect a type in an `extends`/`implements` clause, so type-only identifiers there are misclassified. Live via `isTypeOnlyUsage` → `getImportsDetailed`. |
| `qualified_name` | `nested_identifier` | `utils/astUtils.ts:662,856` | `ns.Type` in type position is never recognized as a type-only usage. |
| `typeof_expression` | `type_query` | `utils/astUtils.ts:678,853` | `typeof X` type position is never recognized as a type-only usage. |
| `open_tag` | `jsx_opening_element` | `utils/astUtils.ts:1028`, `functionScanner.ts:533` | Non-self-closing JSX elements (`<Foo>…</Foo>`) never yield a tag name — JSX usage recording and `extractJSXElements` miss them (self-closing elements are handled by a separate branch). |
| `class_expression` | `class` | `converter.ts:110`, `adapterBridge.ts:239`, `TreeSitterTypeScriptAdapter.ts:1005`, `staticObjectExtract.ts:165` | Anonymous class expressions (`const C = class {}`) are never classified as class-like (`isClassType`/`isClass`), so they are dropped from class discovery/structural signature. |
| `generator_function_expression` | `generator_function` | `converter.ts:95`, `adapterBridge.ts:236`, `TreeSitterTypeScriptAdapter.ts:1015`, `staticObjectExtract.ts:163`, `provenance.ts:579,1479,1727`, `analyzers/universal/functionConcerns.ts:81`, `analyzers/crossDomain/CrossDomainAnalyzer.ts:662`, `phase/batchFunctions.ts:41`, `phase/localBinding.ts:29`, `phase/fileSymbols.ts:250`, `phase/oracles.ts:319` | Generator function expressions (`const g = function* () {}`) are never classified as functions, so they are dropped from function indexing, provenance, batch/scope resolution, file symbols, and oracle seeds. |

Both `class_expression` and `generator_function_expression` are ESTree/TS-API
names (`ClassExpression`, `GeneratorExpression`) that leaked into the
tree-sitter layer; tree-sitter-typescript names them `class` and
`generator_function` (paired with `class_declaration` /
`generator_function_declaration`, which the code already checks correctly).

### Tier B — dead aliases (correct name checked alongside; dead weight only)

These never match but a sibling check already covers the construct, so there is
**no behavior change** — they are dead weight, not silent misses.

| dead literal | correct sibling already present | where |
|---|---|---|
| `field_definition` | `public_field_definition` | `provenance.ts:490,2094,2434`, `receiverRoot.ts:213,338`, `TreeSitterTypeScriptAdapter.ts:619` |
| `template_literal` | `template_string` | `codeAnalysis.ts:1170,1189`, `fileImports.ts:55`, `pipelineAdapters.ts:1635`, `UniversalDataAccessAnalyzer.ts:2334`, `schema/discovery.ts:623` |
| `rest_parameter` | `required_parameter` (rest params parse as `required_parameter` wrapping a `rest_pattern`) | `functionScanner.ts:199`, `documentationAnalyzer.ts:62`, `astUtils.ts:401,701` |
| `binding_element` | `shorthand_property_identifier_pattern` / `pair_pattern` | `reactDetection.ts:313` |
| `object_binding_pattern` | `object_pattern` | `reactDetection.ts:365,382` |
| `type_literal` | `object_type` | `reactDetection.ts:393,420` |
| `jsx_fragment` | `jsx_element` (fragments parse as `jsx_element` with empty name) | `reactDetection.ts:31` |
| `export_declaration` | `export_statement` | `functionScanner.ts:570`, `astUtils.ts:179,563` |
| `switch_statement` (Go only) | `expression_switch_statement` / `type_switch_statement` | `languages/go/GoAdapter.ts:280` |
| `class_property` | (redundant — the `type_annotation` catch covers field types) | `astUtils.ts:710` |
| `tagged_template_literal` | `call_expression` (tagged templates parse as `call_expression`) | `astUtils.ts:835` |
| `string_type` / `number_type` / `boolean_type` | `predefined_type` | `astUtils.ts:670-672` |
| `type_reference` | `type_identifier` / `predefined_type` | `utils/dependencyExtractor.ts:301` |

### Tier C — documentation-only stale names (comment table, no executable effect)

The TS-API ↔ tree-sitter mapping table at `utils/astUtils.ts:600-656` documents
several wrong equivalents. They are comments only, but they mislead future work:

| TS API | documented as | actual tree-sitter type |
|---|---|---|
| `ts.isTypeReferenceNode` | `type_reference` | `type_identifier` |
| `ts.isTypeQueryNode` | `typeof_expression` | `type_query` |
| `ts.isQualifiedName` | `qualified_name` | `nested_identifier` |
| `ts.isHeritageClause` | `heritage_clause` | `class_heritage` |
| `ts.isPropertyDeclaration` | `class_property` | `public_field_definition` |
| `ts.isGetAccessorDeclaration` | `get_accessor` | `method_definition` |
| `ts.isTaggedTemplateExpression` | `tagged_template_literal` | `call_expression` |
| `ts.isExportDeclaration` | `export_declaration` | `export_statement` |
| `ts.isNamedExports` | `named_exports` | `export_clause` |
| `ts.isParameter` (rest) | `rest_parameter` | `required_parameter` + `rest_pattern` |

---

## Recommendation

Tier A are genuine correctness defects in a release candidate: they silently
drop Go interface methods, named exports, JSX element names, type-only-usage
detection, and every generator/class *expression*. Tier B and C are cleanup
(dead weight / stale docs) with no behavior change.

Fixing Tier A changes output — e.g. Go interfaces begin listing method members,
cyclomatic complexity rises for Go switches, and function indexing begins
seeing generator/class expressions — so the fixes must be followed by a
re-measure of the affected corpora and a re-baseline before `verify:close`.
The mechanical renames are unambiguous; the only nuance is `heritage_clause`,
which splits into `class_heritage` (class `extends`/`implements`) and
`extends_type_clause` (interface `extends`).
