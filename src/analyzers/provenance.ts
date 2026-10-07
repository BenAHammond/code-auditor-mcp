/**
 * Provenance Resolver — Spec 21
 *
 * Language-neutral DB and validator receiver detection through
 * provenance tracking instead of English name matching.
 *
 * "Where did this variable's value come from?" rather than
 * "Is this variable named 'db'?"
 *
 * ─── Architecture ───
 *   1. extractDBProvenancedImports   → seed identifiers from known package imports
 *   2. propagateProvenance           → follow assignments, destructuring, params
 *   3. buildProvenanceContext        → combine seeds + propagation + fallbacks (R3)
 *   4. isDBProvenanced               → answer: is this call-expression DB-bound?
 *
 * ─── Modes (R3) ───
 *   hybrid     (default) — provenance-primary + conjunctive name-fallback
 *   provenance            — strict provenance only, never consults name lists
 *   names                 — legacy English-only name matching (opt-in escape hatch)
 */

import type { AST, LanguageAdapter, ASTNode } from '../languages/types.js';
import type { Dialect } from '../mcp-tools/discoveryQueries.js';
import { dialectForPackage } from '../languages/sql/dialectDetection.js';
import { DB_PACKAGES, handleTypesForPackage } from './tsEcosystem.js';
import {
  buildBindingEnv,
  classifyRootIdentifier,
  extractInterfaceFields,
  type RootResolutionEnv,
  resolveReceiverRoot,
  resolveThisFieldType,
  findEnclosingClassHeritage,
  type Binding,
} from './receiverRoot.js';
import { identifyHandle } from './handleIdentification.js';
import { stripSqlQuotes } from './sqlLiteral.js';
import type {
  TsExpressionDescriptor,
  TsWithinFileProvenanceExtract,
  PropagationRule,
  OwnCall,
  ClassCall,
} from './tsExpressionDescriptor.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants — validator packages
//
// The DB ecosystem (DB_PACKAGES / ORM_METHODS) was TypeScript/npm-only and
// moved behind the resolution interface to `tsEcosystem.ts`
// (correction-seams-not-placement §4). What remains here is the
// validator-package vocabulary, a distinct concern.
// ═══════════════════════════════════════════════════════════════════════════

/** Validator packages — spec R4.1 */
export const VALIDATOR_PACKAGES: ReadonlySet<string> = new Set([
  'zod',
  'joi',
  'ajv',
  'valibot',
  'yup',
  'superstruct',
  'arktype',
  '@sinclair/typebox',
  'class-validator',
]);

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type ProvenanceReason = 'package' | 'binding' | 'propagation' | 'fallback' | 'wrapper' | 'module' | 'sql-argument';

export interface ProvenanceEvidence {
  identifier: string;
  reason: ProvenanceReason;
  /** Human-readable source of provenance, e.g. "import from better-sqlite3" */
  source: string;
  /** Chain of propagation — each hop records the intermediate identifier */
  chain: string[];
  /**
   * The npm package the handle traces to (base name, no subpath — `pg`, not
   * `pg/lib`), when its provenance names one — set for a package-import seed
   * and carried through propagation. This is the *structured* counterpart of
   * `source` (which is a human label): it is what `resolveSiteDialect` reads to
   * derive a per-call-site SQL dialect (`pg` → postgresql) instead of parsing
   * the label. Absent for wrapper / type-annotation / in-repo-module evidence,
   * which names no package.
   */
  packageName?: string;
}

export type DetectionMode = 'hybrid' | 'provenance' | 'names';

export interface DetectionConfig {
  mode: DetectionMode;
}

export interface ProvenanceContext {
  /** All DB-provenanced identifiers in the current file */
  dbProvenanced: Map<string, ProvenanceEvidence>;
  /** All validator-provenanced identifiers in the current file */
  validatorProvenanced: Map<string, ProvenanceEvidence>;
  /** Active detection mode */
  mode: DetectionMode;
  /**
   * Receiver roots of DB-shaped call sites (a DB/ORM method call), *proven or
   * unproven*. This is the file-gate signal: a file whose only DB signal is a
   * type-annotated handle with a non-literal SQL argument (unproven under
   * criterion 9, no dialect to parse) still passes the gate so `dynamic-sql-
   * construction` / `unresolved-query` can report the site rather than drop it.
   * It is *not* a handle decision — `identifyHandle` is the only thing that is.
   */
  dbActivity: Set<string>;
}

export interface InferredReceiverSet {
  identifiers: string[];
  evidence: Array<{ identifier: string; reason: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Package matching
// ═══════════════════════════════════════════════════════════════════════════

/** Check if a module specifier matches a DB package (exact or subpath). */
function matchesDBPackage(specifier: string): boolean {
  return [...DB_PACKAGES].some(
    (pkg) => specifier === pkg || specifier.startsWith(pkg + '/'),
  );
}

/**
 * The base npm package name of a module specifier — `pg` for `pg`/`pg/lib`,
 * `@neondatabase/serverless` for `@neondatabase/serverless` and its subpaths,
 * `mysql2` for `mysql2/promise`. Used to stamp {@link ProvenanceEvidence.packageName}
 * with the exact key `dialectForPackage` maps, so a subpath import still resolves
 * to its driver's dialect.
 */
function basePackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}

/** Check if a module specifier matches a validator package. */
function matchesValidatorPackage(specifier: string): boolean {
  return [...VALIDATOR_PACKAGES].some(
    (pkg) => specifier === pkg || specifier.startsWith(pkg + '/'),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Import extraction (R1 seed phase)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract the identifiers imported from any package matched by `matchesPackage`.
 * An import like `import Database from 'better-sqlite3'` produces `Database` as
 * provenanced with reason "package". Shared by the DB and validator variants,
 * which differ only in the package predicate.
 *
 * `handleTypesFor` is the Decision A type filter. It maps a matched specifier to
 * the package's handle-name set, or `undefined` when the caller wants no type
 * filter (the validator variant — a validator package's every export is a
 * validator). When the set is present, a *named* import seeds only if its
 * original export name (`spec.name`, not the local alias) is in the set; a
 * default or namespace import seeds unconditionally, because a DB package's
 * default/namespace *is* its handle and tree-sitter records no original export
 * name for a default import to match. This is what stops
 * `import { KVNamespace } from '@cloudflare/workers-types'` from seeding while
 * `import { D1Database }` still does.
 *
 * @param ast
 * @param adapter
 * @param matchesPackage
 * @param handleTypesFor
 * @returns
 */
function extractProvenancedImports(
  ast: AST,
  adapter: LanguageAdapter,
  matchesPackage: (specifier: string) => boolean,
  handleTypesFor: (specifier: string) => ReadonlySet<string> | undefined = () => undefined,
): Map<string, ProvenanceEvidence> {
  const seedMap = new Map<string, ProvenanceEvidence>();
  const imports = adapter.extractImports(ast);

  for (const imp of imports) {
    const specifier = imp.source;
    if (!matchesPackage(specifier)) continue;

    const handleTypes = handleTypesFor(specifier);
    for (const spec of imp.specifiers) {
      // Decision A: a named import seeds only when the package's manifest lists
      // the original export name as a handle. Default/namespace imports seed
      // unconditionally (see the doc above).
      if (handleTypes && !spec.isDefault && !spec.isNamespace && !handleTypes.has(spec.name)) continue;

      const localName = spec.alias ?? spec.name;
      const label = spec.isDefault
        ? `default import from ${specifier}`
        : spec.isNamespace
          ? `namespace import from ${specifier}`
          : `named import from ${specifier}`;

      // Don't overwrite existing evidence (first import wins for dedup)
      if (!seedMap.has(localName)) {
        seedMap.set(localName, {
          identifier: localName,
          reason: 'package',
          source: label,
          chain: [],
          packageName: basePackageName(specifier),
        });
      }
    }
  }

  return seedMap;
}

/**
 * Extract all DB-provenanced identifiers from a file's import statements.
 *
 * @param ast the parsed source file
 * @param adapter the language adapter providing import extraction
 * @returns a map of local identifier → DB-provenance evidence
 */
export function extractDBProvenancedImports(
  ast: AST,
  adapter: LanguageAdapter,
): Map<string, ProvenanceEvidence> {
  return extractProvenancedImports(ast, adapter, matchesDBPackage, handleTypesForPackage);
}

/**
 * Extract all validator-provenanced identifiers from a file's imports.
 *
 * @param ast the parsed source file
 * @param adapter the language adapter providing import extraction
 * @returns a map of local identifier → validator-provenance evidence
 */
export function extractValidatorProvenancedImports(
  ast: AST,
  adapter: LanguageAdapter,
): Map<string, ProvenanceEvidence> {
  return extractProvenancedImports(ast, adapter, matchesValidatorPackage);
}

// ═══════════════════════════════════════════════════════════════════════════
// Provenance propagation (R1 core)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Propagate provenance through a variable declaration (rules 1-3, 8).
 * Returns true if any new identifier was added.
 */
function propagateVariableDeclaration(
  node: ASTNode,
  ctx: PropagationContext,
): boolean {
  const { nameNode, valueNode } = splitVariableDeclarator(node, ctx.adapter);

  if (!nameNode) return false;

  if (valueNode) {
    return propagateFromValue(nameNode, valueNode, ctx);
  }

  return false;
}

/** Propagate provenance from a declarator's value expression into its names. */
function propagateFromValue(
  nameNode: ASTNode,
  valueNode: ASTNode,
  ctx: PropagationContext,
): boolean {
  const propagated = tryPropagateFromExpression(
    valueNode, ctx.adapter, ctx.sourceCode, ctx.provenanceMap, ctx.localFunctions,
  );
  if (!propagated) return false;
  let mutated = false;
  for (const varName of extractPatternNames(nameNode, ctx.adapter, ctx.sourceCode)) {
    if (!ctx.provenanceMap.has(varName)) {
      ctx.provenanceMap.set(varName, {
        identifier: varName,
        reason: 'propagation',
        source: propagated.source,
        chain: [...propagated.chain, propagated.identifier],
        packageName: propagated.packageName,
      });
      mutated = true;
    }
  }
  return mutated;
}

/**
 * Propagate provenance through a default parameter (rule 6).
 * Returns true if a new identifier was added.
 */
function propagateDefaultParameter(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  provenanceMap: Map<string, ProvenanceEvidence>,
  localFunctions?: ReadonlySet<string>,
): boolean {
  const children = adapter.getChildren(node);
  // assignment_pattern has [left, right]
  if (children.length < 2) return false;

  const leftNode = children[0];
  const rightNode = children[1];

  if (leftNode.type !== 'identifier') return false;

  const paramName = adapter.getNodeText(leftNode, sourceCode);
  const propagated = tryPropagateFromExpression(
    rightNode,
    adapter,
    sourceCode,
    provenanceMap,
    localFunctions,
  );
  if (propagated && !provenanceMap.has(paramName)) {
    provenanceMap.set(paramName, {
      identifier: paramName,
      reason: 'propagation',
      source: `default parameter = ${propagated.source}`,
      chain: [...propagated.chain, propagated.identifier],
      packageName: propagated.packageName,
    });
    return true;
  }
  return false;
}

/**
 * Propagate provenance through a class field initialization (rule 7).
 * Returns true if a new identifier was added.
 */
function propagateClassField(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  provenanceMap: Map<string, ProvenanceEvidence>,
  localFunctions?: ReadonlySet<string>,
): boolean {
  const children = adapter.getChildren(node);
  // Typically [name, value], [modifier, name, type], or [decorators..., name, value].
  const nameChild = children.find(
    (c) => c.type === 'property_identifier',
  );
  if (!nameChild) return false;

  const fieldName = adapter.getNodeText(nameChild, sourceCode);

  // Rule 7 — class field initialized with a DB value (`private db = new Database()`).
  // `accessibility_modifier` and `type_annotation` are excluded so the value is
  // found even on a modified or annotated field.
  const valueChild = children.find(
    (c) =>
      c.type !== 'property_identifier' &&
      c.type !== 'decorator' &&
      c.type !== 'accessibility_modifier' &&
      c.type !== 'private' &&
      c.type !== 'public' &&
      c.type !== 'protected' &&
      c.type !== 'static' &&
      c.type !== 'readonly' &&
      c.type !== 'abstract' &&
      c.type !== 'type_annotation',
  );

  if (valueChild) {
    const propagated = tryPropagateFromExpression(
      valueChild,
      adapter,
      sourceCode,
      provenanceMap,
      localFunctions,
    );
    if (propagated && !provenanceMap.has(fieldName)) {
      provenanceMap.set(fieldName, {
        identifier: fieldName,
        reason: 'propagation',
        source: `class field initialized from ${propagated.source}`,
        chain: [...propagated.chain, propagated.identifier],
        packageName: propagated.packageName,
      });
      return true;
    }
  }
  return false;
}

/**
 * S5b (form 4) — propagate provenance through a member assignment
 * (`this.db = new Database()`). The RHS is a DB-provenanced expression (a
 * `new X()` where X is an in-repo class that resolves, or a provenanced
 * identifier), so the assigned field is a DB handle. This is the `new X()`
 * binding form for the `this.<field> = …` assignment shape that no
 * `variable_declarator`/`field_definition` rule covers.
 */
function propagateMemberAssignment(
  node: ASTNode,
  ctx: PropagationContext,
): boolean {
  const { adapter, sourceCode, provenanceMap } = ctx;
  const children = adapter.getChildren(node);
  // children: [member_expression (this.db), <RHS expression>].
  const lhs = children.find(
    (c) => c.type === 'member_expression' || c.type === 'selector_expression',
  );
  if (!lhs) return false;

  const lhsChildren = adapter.getChildren(lhs);
  const obj = lhsChildren.find((c) => c.type === 'this' || c.type === 'super');
  if (!obj) return false;
  const prop = lhsChildren.find(
    (c) => c.type === 'property_identifier' || c.type === 'field_identifier',
  );
  if (!prop) return false;

  const fieldName = adapter.getNodeText(prop, sourceCode);
  if (!fieldName || provenanceMap.has(fieldName)) return false;

  const rhs = children[children.length - 1];
  if (!rhs || rhs.type === 'member_expression' || rhs.type === 'selector_expression') return false;

  const propagated = tryPropagateFromExpression(rhs, adapter, sourceCode, provenanceMap, ctx.localFunctions);
  if (!propagated) return false;

  provenanceMap.set(fieldName, {
    identifier: fieldName,
    reason: 'propagation',
    source: `this.${fieldName} assigned from ${propagated.source}`,
    chain: [...propagated.chain, propagated.identifier],
    packageName: propagated.packageName,
  });
  return true;
}

/**
 * Apply the single-file propagation rules for one AST node, mutating the
 * provided provenance map. Returns true if any new identifier was added.
 *
 * Rules 1-7 (spec R1): variable declarations (1-3), default parameters
 * (6), and class field initialization (7).
 */
/**
 * Single-file propagation scan context — bundles the adapter, source text,
 * and the mutable provenance map so the rule dispatcher takes one context
 * object rather than three trailing positional arguments.
 */
interface PropagationContext {
  adapter: LanguageAdapter;
  sourceCode: string;
  provenanceMap: Map<string, ProvenanceEvidence>;
  /** Names of functions declared in this file — S5f must not forward a
   *  provenanced argument through them (a local function's return is resolved
   *  by `detectDbReturningFunctions`/`detectDbWrappers`, not by treating "takes
   *  a handle" as "returns a handle"). */
  localFunctions: ReadonlySet<string>;
}

function applyPropagationRule(
  node: ASTNode,
  parent: ASTNode | null,
  ctx: PropagationContext,
): boolean {
  const { adapter, sourceCode, provenanceMap } = ctx;
  if (node.type === 'variable_declarator') {
    return propagateVariableDeclaration(node, ctx);
  }

  if (
    node.type === 'assignment_pattern' &&
    parent?.type === 'formal_parameters'
  ) {
    return propagateDefaultParameter(node, adapter, sourceCode, provenanceMap, ctx.localFunctions);
  }

  if (
    node.type === 'public_field_definition' ||
    node.type === 'field_definition'
  ) {
    return propagateClassField(node, adapter, sourceCode, provenanceMap, ctx.localFunctions);
  }

  // S5b (form 4) — `this.db = new Database()` / `this.db = <provenanced>`.
  if (node.type === 'assignment_expression') {
    return propagateMemberAssignment(node, ctx);
  }

  return false;
}

/**
 * Propagate provenance through assignments, destructuring, default
 * parameters, and class-field initializers within a single file.
 *
 * The 7 single-file propagation rules (spec R1):
 *   1. new Expression → variable
 *   2. DB-provenanced call return → variable
 *   3. member expression on DB receiver → variable
 *   4. object destructuring from DB source
 *   5. array destructuring from DB source
 *   6. default parameter with DB value
 *   7. class field initialized with DB value
 * @param adapter
 * @param ast
 * @param seedMap
 * @param sourceCode
 * @returns
 */
export function propagateProvenance(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  seedMap: Map<string, ProvenanceEvidence>,
): Map<string, ProvenanceEvidence> {
  // Work on a copy so we can add newly-provenanced identifiers during the walk
  const provenanceMap = new Map(seedMap);
  const ctx: PropagationContext = {
    adapter,
    sourceCode,
    provenanceMap,
    localFunctions: collectLocalFunctionNames(ast, adapter, sourceCode),
  };
  // Keep iterating until no new identifiers are discovered (handles chains)
  let changed = true;
  let iterations = 0;
  const MAX_ITERATIONS = 10; // safety valve for circular references

  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;

    walkAST(ast.root, (node, parent) => {
      if (applyPropagationRule(node, parent, ctx)) {
        changed = true;
      }
    });
  }

  return provenanceMap;
}

/**
 * Names of functions *declared in this file* — named function declarations,
 * method definitions, and arrow/function expressions bound to a variable.
 * S5f consults this to refuse to forward a provenanced argument through a local
 * function: the local function's own return is resolved by
 * `detectDbReturningFunctions` (returned construction), not by
 * the "it takes a handle, so it must return one" heuristic that is only sound
 * for *external* factories like `enhancePrisma(PrismaClient)`.
 */
function collectLocalFunctionNames(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): Set<string> {
  const names = new Set<string>();
  walkAST(ast.root, (node) => {
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const name = adapter.getNodeName(node);
      if (name) names.add(name);
      return;
    }
    if (node.type === 'variable_declarator') {
      const { nameNode, valueNode } = splitVariableDeclarator(node, adapter);
      if (!nameNode || !valueNode) return;
      const vt = valueNode.type;
      if (vt === 'arrow_function' || vt === 'function_expression' || vt === 'generator_function_expression') {
        for (const n of extractPatternNames(nameNode, adapter, sourceCode)) names.add(n);
      }
    }
  });
  return names;
}

// ═══════════════════════════════════════════════════════════════════════════
// Propagation helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Given a value expression node, check if it indicates DB provenance
 * and return the evidence of the provenanced source if so.
 */
function tryPropagateFromExpression(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  provenanceMap: Map<string, ProvenanceEvidence>,
  localFunctions?: ReadonlySet<string>,
): ProvenanceEvidence | null {
  // ── Rule 0: await x — unwrap the await and propagate from its operand ──
  // Mirrors getCallExpressionCallee, which already recurses through
  // await_expression. `await` is a significant anonymous child (converter.ts
  // SIGNIFICANT_ANONYMOUS_TYPES) and is skipped; the operand carries the
  // provenance (e.g. `const x = await factory()`).
  if (node.type === 'await_expression') {
    for (const child of adapter.getChildren(node)) {
      if (child.type === 'await') continue;
      const result = tryPropagateFromExpression(
        child, adapter, sourceCode, provenanceMap, localFunctions,
      );
      if (result) return result;
    }
    return null;
  }

  // ── Rule 1: new Database(...) ──
  if (node.type === 'new_expression') {
    const constructorNode = findChildOfType(node, [
      'identifier',
      'member_expression',
    ]);
    if (constructorNode) {
      const name = extractIdentifierName(constructorNode, adapter, sourceCode);
      const evidence = lookupEvidence(provenanceMap, name);
      if (evidence) return evidence;
    }
  }

  // ── Rule 2: drizzle(env.DB) — call where callee is DB-provenanced ──
  // ── Rule 3: db.prepare(sql) — member expression call on DB receiver ──
  if (node.type === 'call_expression') {
    const viaCall = tryCallProvenance(node, adapter, sourceCode, provenanceMap, localFunctions);
    if (viaCall) return viaCall;
  }

  // ── Simple identifier reference (for destructuring sources) ──
  if (node.type === 'identifier') {
    const name = adapter.getNodeText(node, sourceCode);
    const evidence = lookupEvidence(provenanceMap, name);
    if (evidence) return evidence;
  }

  // ── Member expression on DB-provenanced source (for non-call uses) ──
  if (node.type === 'member_expression') {
    const receiver = getMemberExpressionReceiver(node, adapter, sourceCode);
    const evidence = lookupEvidence(provenanceMap, receiver);
    if (evidence) return evidence;
  }

  return null;
}

/**
 * Look up a provenanced identifier's evidence, or null when the name is empty
 * or unprovenanced. Centralizes the repeated "if name is in the map, return it"
 * pattern shared by every rule-1/2/3 receiver check.
 */
function lookupEvidence(
  provenanceMap: Map<string, ProvenanceEvidence>,
  name: string | null,
): ProvenanceEvidence | null {
  if (name && provenanceMap.has(name)) return provenanceMap.get(name)!;
  return null;
}

/**
 * Rule 2/3: check a call_expression whose callee is either a DB-provenanced
 * identifier (e.g. `drizzle(...)`) or a member expression on a DB receiver
 * (e.g. `db.prepare(sql)`).
 */
function tryCallProvenance(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  provenanceMap: Map<string, ProvenanceEvidence>,
  localFunctions?: ReadonlySet<string>,
): ProvenanceEvidence | null {
  const calleeNode = getCallExpressionCallee(node, adapter);
  if (!calleeNode) return null;

  // Case: simple identifier call — drizzle(...)
  if (calleeNode.type === 'identifier') {
    const name = adapter.getNodeText(calleeNode, sourceCode);
    const evidence = lookupEvidence(provenanceMap, name);
    if (evidence) return evidence;

    // S5f — higher-order wrapper: a plain-identifier call whose callee is NOT
    // provenanced but forwards a provenanced DB-handle argument
    // (`enhancePrisma(PrismaClient)`). The call result is treated as a DB handle.
    const argEvidence = tryProvenancedArgument(node, adapter, sourceCode, provenanceMap, localFunctions);
    if (argEvidence) return argEvidence;
  }

  // Case: member expression — db.prepare(...)
  if (calleeNode.type === 'member_expression') {
    const receiver = getMemberExpressionReceiver(
      calleeNode, adapter, sourceCode,
    );
    const evidence = lookupEvidence(provenanceMap, receiver);
    if (evidence) return evidence;
  }

  return null;
}

/**
 * S5f — a call whose callee is unprovenanced but whose *argument* is a
 * DB-provenanced expression (`enhancePrisma(PrismaClient)`) forwards the handle,
 * so the call result is a DB handle (a wrapper constructor / factory). Restricted
 * to a plain-identifier callee so member-expression calls like `JSON.stringify(db)`
 * or `console.log(db)` — whose result is a string / undefined, not a handle — are
 * not swept in.
 */
function tryProvenancedArgument(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  provenanceMap: Map<string, ProvenanceEvidence>,
  localFunctions?: ReadonlySet<string>,
): ProvenanceEvidence | null {
  // S5f is only sound for *external* factories (`enhancePrisma(PrismaClient)`).
  // A local function that merely takes a handle does not therefore return one —
  // e.g. `loadCallGraphData(indexHandle)` returns an in-memory graph, not a
  // handle — and its return is resolved by `detectDbReturningFunctions`. Refusing
  // to forward through a locally-declared function breaks the cascade that labels
  // plain Maps/Sets as DB handles (the source of the index-code N+1 false
  // positives). `localFunctions` is undefined in the `detectDbReturningFunctions`
  // return-check, where S5f's canonical imported-factory case must still fire.
  if (localFunctions) {
    const calleeNode = getCallExpressionCallee(node, adapter);
    if (calleeNode?.type === 'identifier') {
      const calleeName = adapter.getNodeText(calleeNode, sourceCode);
      if (calleeName && localFunctions.has(calleeName)) return null;
    }
  }

  const argsNode = adapter.getChildren(node).find((c) => c.type === 'arguments');
  if (!argsNode) return null;
  for (const arg of adapter.getChildren(argsNode)) {
    if (arg.type === '(' || arg.type === ')' || arg.type === ',') continue;
    const evidence = tryPropagateFromExpression(arg, adapter, sourceCode, provenanceMap, localFunctions);
    if (evidence) {
      return {
        identifier: evidence.identifier,
        reason: 'wrapper',
        source: `higher-order wrapper forwards DB handle \`${evidence.identifier}\``,
        chain: evidence.chain,
      };
    }
  }
  return null;
}

/**
 * Split a variable_declarator into its name and value child nodes.
 */
function splitVariableDeclarator(
  node: ASTNode,
  adapter: LanguageAdapter,
): {
  nameNode: ASTNode | null;
  valueNode: ASTNode | null;
} {
  const children = adapter.getChildren(node);
  let nameNode: ASTNode | null = null;
  let valueNode: ASTNode | null = null;
  let pastEquals = false;

  for (const child of children) {
    if (child.type === '=' || child.type === 'equals') {
      pastEquals = true;
      continue;
    }
    if (child.type === ':') continue;
    if (child.type === 'type_annotation') continue;

    if (!pastEquals && !nameNode) {
      // First non-syntax child is the name/pattern
      if (
        child.type === 'identifier' ||
        child.type === 'object_pattern' ||
        child.type === 'array_pattern'
      ) {
        nameNode = child;
      }
    } else if ((pastEquals || nameNode) && !valueNode) {
      // First non-syntax child after `=` or after the name is the value. Both
      // grammars collapse here: with an explicit `=` child (`pastEquals`) the
      // value follows it; without one (e.g. TypeScript tree-sitter), the
      // expression after the name is the value.
      if (child.type !== 'type_annotation') {
        valueNode = child;
      }
    }
  }

  return { nameNode, valueNode };
}

/**
 * Extract all variable names from a destructuring or identifier pattern.
 *   - identifier → [name]
 *   - object_pattern → [prop1, prop2, ...] rule 4
 *   - array_pattern → [elem1, elem2, ...] rule 5
 */
function extractPatternNames(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string[] {
  const names: string[] = [];
  collectPatternNames(node, adapter, sourceCode, names);
  return names;
}

/** Recursively collect identifier names from a destructuring pattern node. */
function collectPatternNames(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  names: string[],
): void {
  if (node.type === 'identifier') {
    const name = adapter.getNodeText(node, sourceCode);
    if (name) names.push(name);
    return;
  }

  if (node.type === 'object_pattern') {
    for (const child of adapter.getChildren(node)) {
      if (child.type === '{' || child.type === '}' || child.type === ',') continue;
      if (child.type === 'shorthand_property_identifier') {
        const name = adapter.getNodeText(child, sourceCode);
        if (name) names.push(name);
      } else if (child.type === 'pair_pattern') {
        // pair_pattern children: [property, value] — collect from value side
        const pairChildren = adapter.getChildren(child);
        if (pairChildren.length >= 2) {
          collectPatternNames(pairChildren[1], adapter, sourceCode, names);
        }
      } else if (child.type === 'rest_pattern') {
        collectChildren(child, adapter, sourceCode, names);
      } else {
        collectPatternNames(child, adapter, sourceCode, names);
      }
    }
    return;
  }

  if (node.type === 'array_pattern') {
    for (const child of adapter.getChildren(node)) {
      if (child.type === '[' || child.type === ']' || child.type === ',') continue;
      collectPatternNames(child, adapter, sourceCode, names);
    }
    return;
  }

  // assignment_pattern — default value in destructuring, collect from left side
  if (node.type === 'assignment_pattern') {
    const children = adapter.getChildren(node);
    if (children.length >= 1) {
      collectPatternNames(children[0], adapter, sourceCode, names);
    }
  }
}

function collectChildren(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  names: string[],
): void {
  for (const child of adapter.getChildren(node)) {
    if (child.type === 'identifier') {
      const name = adapter.getNodeText(child, sourceCode);
      if (name) names.push(name);
    } else {
      collectChildren(child, adapter, sourceCode, names);
    }
  }
}

/**
 * Resolve a member/selector chain's object child to its receiver text: a bare
 * identifier or nested member/selector returns its source text (so
 * `env.DB.prepare` yields "env.DB", not "env"); a `this`/`super` child returns
 * `thisSuperResult` (null for the receiver walker, 'this' for the root walker);
 * any other child returns null.
 *
 * A `call_expression` child is the fluent/builder-chain case (`db.selectFrom(…)
 * .selectAll().execute()` — the object of `.execute` is a call): descend into
 * the call's *callee* and resolve that, so the root receiver is reached through
 * the chain rather than dropped. Without this, every ORM whose queries are
 * builder chains (kysely, drizzle, knex, prisma fluent API) resolves to `null`
 * at the first call boundary.
 */
function resolveReceiverText(
  firstChild: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  thisSuperResult: string | null,
): string | null {
  if (firstChild.type === 'call_expression') {
    const callee = getCallExpressionCallee(firstChild, adapter);
    if (!callee) return null;
    return resolveReceiverText(callee, adapter, sourceCode, thisSuperResult);
  }
  if (
    firstChild.type === 'identifier' ||
    firstChild.type === 'member_expression' ||
    firstChild.type === 'selector_expression'
  ) {
    return adapter.getNodeText(firstChild, sourceCode);
  }
  if (firstChild.type === 'this' || firstChild.type === 'super') {
    return thisSuperResult;
  }
  return null;
}

/**
 * Extract the "receiver" identifier from a member expression chain.
 * For `db.prepare` → "db"
 * For `this.db.prepare` → "db" (walk to the deepest non-member identifier)
 *
 * @param node the member/selector expression node
 * @param adapter the language adapter used to walk child nodes
 * @param sourceCode the file source text for reading node text
 * @returns the receiver identifier text, or `null`
 */
export function getMemberExpressionReceiver(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  // Walk down the member expression chain to find the root object
  let current = node;
  while (
    current.type === 'member_expression' ||
    current.type === 'selector_expression'
  ) {
    const children = adapter.getChildren(current);
    const object = children.find(
      (c) => c.type !== '.' && c.type !== 'property_identifier' && c.type !== 'field_identifier',
    );
    // The object of this member expression should be the first child
    const firstChild = children[0];
    if (
      firstChild &&
      firstChild.type !== '.' &&
      firstChild.type !== 'property_identifier' && firstChild.type !== 'field_identifier'
    ) {
      return resolveReceiverText(firstChild, adapter, sourceCode, null);
    }
    break;
  }
  return null;
}

/**
 * Get the callee of a call expression (everything before arguments).
 *
 * Handles the two tree-sitter shapes the data-access analyzer and wrapper FP
 * guards must agree on: a bare `identifier`, a `member_expression`/`selector`,
 * and — for `await fn<T>(...)` — an `await_expression` wrapping the callee plus
 * a `type_arguments` child (skipped, not mistaken for the callee).
 * @param node The call-expression node whose callee to extract.
 * @param adapter The language adapter for child traversal.
 * @returns The callee node, or null when none is found.
 */
export function getCallExpressionCallee(
  node: ASTNode,
  adapter: LanguageAdapter,
): ASTNode | null {
  for (const child of adapter.getChildren(node)) {
    if (child.type === 'arguments') break;
    // await_expression wraps the actual callee — recurse into it
    if (child.type === 'await_expression') {
      const inner = getCallExpressionCallee(child, adapter);
      if (inner) return inner;
      continue;
    }
    if (
      child.type === 'identifier' ||
      child.type === 'member_expression' ||
      child.type === 'selector_expression' ||
      child.type === 'call_expression'
    ) {
      return child;
    }
  }
  return null;
}

/** Find first child (recursively excluding punctuation) matching one of the types. */
function findChildOfType(
  node: ASTNode,
  types: string[],
): ASTNode | null {
  for (const child of node.children ?? []) {
    if (types.includes(child.type)) return child;
    const found = findChildOfType(child, types);
    if (found) return found;
  }
  return null;
}

/** Extract the identifier name from a node (handles member_expression chains). */
function extractIdentifierName(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  if (node.type === 'identifier') {
    return adapter.getNodeText(node, sourceCode);
  }
  if (node.type === 'member_expression') {
    // Get the deepest identifier in the chain
    const firstChild = node.children?.[0];
    if (firstChild) {
      return extractIdentifierName(firstChild, adapter, sourceCode);
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// AST Walking
// ═══════════════════════════════════════════════════════════════════════════

type ASTVisitor = (node: ASTNode, parent: ASTNode | null) => void;

/** Depth-first walk of the AST, calling the visitor for each node. */
function walkAST(root: ASTNode, visitor: ASTVisitor): void {
  function walk(node: ASTNode, parent: ASTNode | null): void {
    visitor(node, parent);
    for (const child of node.children ?? []) {
      walk(child, node);
    }
  }
  walk(root, null);
}

// ═══════════════════════════════════════════════════════════════════════════
// Provenance Context (the combined result consumed by analyzers)
// ═══════════════════════════════════════════════════════════════════════════

export interface BuildProvenanceContextOptions {
  mode: DetectionMode;
  /**
   * Cross-file resolution seeds — the per-file provenanced identifiers produced
   * by the phase model's `computeReceiverProvenance` (package import /
   * declaration / propagation / wrapper / cross-file import). Merged into the
   * import seeds before propagation; this is the declaration-based replacement
   * for the deleted name-list fallback (Spec 69 §10).
   */
  seedProvenance?: ReadonlyMap<string, ProvenanceEvidence>;
  dbBindingNames?: string[];
  /**
   * Known DB wrapper function names — e.g. d1Query, d1Exec.
   * These are project-specific functions that wrap D1/DB API calls
   * (e.g. function d1Query(sql) { return d1.prepare(sql).all(); }).
   * When imported from a local module (not a known DB package), provenance
   * can't trace through the import chain.  These names provide a hybrid-mode
   * fallback: any call to an identifier matching this list is treated as
   * DB-provenanced.
   */
  dbWrapperNames?: string[];
  /** Validator package list override (defaults to VALIDATOR_PACKAGES) */
  validatorPackageList?: string[];
  /**
   * The corpus's named SQL dialect for R3 (sql-argument) handle inference. When
   * non-null, a call whose argument parses as SQL under this dialect proves its
   * receiver a DB handle (Spec 70 criterion 8) — the replacement for the deleted
   * type-name handle tests (criterion 9). Absent (null/undefined), the R3 step
   * abstains: `identifyHandle` reports `unproven` rather than guessing a dialect.
   */
  sqlDialect?: Dialect | null;
}

/**
 * Build a ProvenanceContext for a file.
 *
 * This is the main entry point — call once per file before analysis.
 * Combines import extraction, propagation, and mode-based fallback.
 * @param adapter
 * @param ast
 * @param options
 * @param sourceCode
 * @returns
 */
export function buildProvenanceContext(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  options: BuildProvenanceContextOptions,
): ProvenanceContext {
  const mode = options.mode;

  // 1. Extract seed identifiers from imports
  const dbSeeds = extractDBProvenancedImports(ast, adapter);
  const validatorSeeds = extractValidatorProvenancedImports(ast, adapter);

  // 1a. Merge cross-file resolution seeds (declaration-based, not name-based).
  //     These replace the deleted name-list fallback (Spec 69 §10): the
  //     `seedProvenance` map is the per-file DB-provenanced identifier set
  //     produced by `computeReceiverProvenance` for this file.
  if (options.seedProvenance) {
    for (const [name, evidence] of options.seedProvenance) {
      if (!dbSeeds.has(name)) dbSeeds.set(name, evidence);
    }
  }

  // 2. Propagate provenance through assignments
  let dbProvenanced = propagateProvenance(ast, adapter, sourceCode, dbSeeds);
  const validatorProvenanced = propagateProvenance(ast, adapter, sourceCode, validatorSeeds);

  // 2a. DB-shaped activity — receiver roots of DB/ORM call sites, proven or
  //     unproven. This is the file-gate signal, not a handle decision: it must
  //     run before the R3 dialect gate so a type-annotated handle with a dynamic
  //     SQL argument (unproven under criterion 9, no dialect to parse) still
  //     passes the gate and reaches the analyzers instead of being dropped.
  const dbActivity = collectDbActivity(ast, adapter, sourceCode, dbProvenanced);

  // 3. R3 — a call whose argument parses as SQL proves its receiver a handle
  //    (criterion 8). This is the replacement for the type-name handle tests
  //    criterion 9 deleted: `const db: D1Database = getDb()` no longer proves `db`
  //    by its annotation, but `db.query('SELECT …')` still does — by the parsed
  //    argument, not the name. Runs before wrapper detection so a wrapper body's
  //    `db.prepare('SELECT …')` is already visible as a DB call to
  //    `detectDbWrappers`. Runs even without a named dialect: `identifyHandle`
  //    parses the literal under DEFAULT_SQL_DIALECT when the dialect is null
  //    (Spec 70 R2), so a sibling's parseable literal still proves the receiver.
  dbProvenanced = applySqlArgumentInference(ast, adapter, sourceCode, dbProvenanced, options.sqlDialect ?? null);

  // 4. Wrapper detection (structural, not name-based): learn DB-wrapper function
  //    names from function bodies — a body that constructs/calls a DB driver.
  //    A bare call like `d1(sql)` then resolves as DB-provenanced and its SQL
  //    reaches the table rules instead of bypassing them.
  dbProvenanced = detectDbWrappers(ast, adapter, sourceCode, dbProvenanced);

  return {
    dbProvenanced,
    validatorProvenanced,
    mode,
    dbActivity,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// R3 — sql-argument handle inference (criterion 8)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Collect the receiver roots of DB-shaped call sites (a member/selector call
 * whose first argument is a static SQL string literal, or whose receiver root
 * resolves handle/unproven), *proven or unproven*. This is the file-gate signal
 * — see `ProvenanceContext.dbActivity` — not a handle decision (that is
 * `identifyHandle`'s job alone, criterion 2).
 *
 * The discriminator is the package discriminant — the receiver root's
 * disposition — not the method name: `join` is `Array.prototype.join` and also
 * `SQL JOIN`. A static SQL literal proves DB shape outright; a dynamic SQL
 * argument (`db.exec('DROP ' + x)`, `db.prepare(sql)`) is admitted by the
 * receiver's resolution (`db` → handle/unproven) while `array.join(',')` is
 * dropped because `array` resolves to a JS global (not-handle). Unlike R3
 * (`applySqlArgumentInference`) it needs no dialect. Runs unconditionally,
 * before R3's dialect gate.
 * @param ast - The file's parsed AST.
 * @param adapter - The language adapter (used for the callee walk and Go skip).
 * @param sourceCode - The file's source text (for node-text reads).
 * @param dbProvenanced - the propagated DB-provenanced map the receiver
 *   discriminant reads as its provenance seed.
 * @returns The set of DB-shaped receiver roots, or an empty set for Go.
 */
export function collectDbActivity(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
): Set<string> {
  const activity = new Set<string>();
  // Go resolves cross-file; a member-receiver root has no local binding to key
  // the gate on, and Go files are gated by their own import resolution instead.
  if (adapter.name === 'go') return activity;

  const env: RootResolutionEnv = {
    provenance: dbProvenanced,
    bindings: buildBindingEnv(ast, adapter, sourceCode),
    interfaceFields: extractInterfaceFields(ast, adapter, sourceCode),
    adapter,
    sourceCode,
  };

  walkAST(ast.root, (node) => {
    if (node.type !== 'call_expression') return;
    const callee = getCallExpressionCallee(node, adapter);
    if (!callee) return;
    if (callee.type !== 'member_expression' && callee.type !== 'selector_expression') return;
    const root = resolveReceiverRoot(callee, adapter, sourceCode);
    if (root === null) return;
    // A static SQL literal proves DB shape regardless of the receiver's package
    // (`db.query('SELECT …')`). A dynamic SQL argument is admitted by the
    // package discriminant: the receiver's disposition — not the method name —
    // distinguishes `db.prepare(sql)` (handle/unproven) from `array.join(',')`
    // (root `Array` → not-handle).
    if (extractStaticSqlArgument(node, adapter, sourceCode) !== null) {
      activity.add(root);
      return;
    }
    if (classifyRootIdentifier(root, env) !== 'not-handle') activity.add(root);
  });

  return activity;
}

/**
 * R3: a call whose argument parses as SQL proves its receiver a DB handle.
 * Folds the one entry point `identifyHandle` (criterion 2: no second decision
 * path) over DB-shaped call sites and adds every receiver it proves a handle to
 * `dbProvenanced`. This is the replacement for the type-name handle tests
 * criterion 9 deleted: a receiver typed `D1Database` / `MockDB` is no longer
 * proven by its annotation, but `db.query('SELECT …')` still is — by the parsed
 * argument, not the name.
 *
 * The declaration-resolution arm of `identifyHandle` re-runs here, but it is
 * harmless and already the same evidence `propagateProvenance` produced: for a
 * type-annotated receiver it now returns `unproven` (criterion 9), and
 * `combineVerdicts`' `handle > not-handle > unproven` precedence lets the
 * sql-argument proof win. A receiver already in the map is left untouched.
 *
 * @param ast - the parsed file AST whose call sites R3 folds over.
 * @param adapter - the language adapter (name, extraction helpers) for the file.
 * @param sourceCode - the raw file source, for callee/method text extraction.
 * @param dbProvenanced - the running receiver→evidence map to extend in place.
 * @param sqlDialect - the corpus's named SQL dialect (or null), threaded to the SQL parser.
 * @returns the same `dbProvenanced` map, now also carrying every receiver R3 proved.
 */
export function applySqlArgumentInference(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  dbProvenanced: Map<string, ProvenanceEvidence>,
  sqlDialect: Dialect | null,
): Map<string, ProvenanceEvidence> {
  if (adapter.name === 'go') return dbProvenanced; // Go resolves cross-file; no TS env here.

  const env: RootResolutionEnv = {
    provenance: dbProvenanced,
    bindings: buildBindingEnv(ast, adapter, sourceCode),
    interfaceFields: extractInterfaceFields(ast, adapter, sourceCode),
    adapter,
    sourceCode,
  };

  walkAST(ast.root, (node) => {
    if (node.type !== 'call_expression') return;
    const callee = getCallExpressionCallee(node, adapter);
    if (!callee) return;

    // Only member-expression calls carry the receiver whose handle-ness R3
    // proves. A bare-identifier call (`query('…')`) has no receiver to add.
    if (callee.type !== 'member_expression' && callee.type !== 'selector_expression') return;

    const method = extractMemberExpressionProperty(callee, adapter, sourceCode);
    if (!method) return;
    // The SQL argument — not the method name — is the admission proof. R3 folds
    // `identifyHandle` over every member call; a null static literal simply can't
    // prove a handle, so it falls through. No method-name set is consulted.
    const root = resolveReceiverRoot(callee, adapter, sourceCode);
    if (root === null) return;
    const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode) ?? root;

    const sqlArgument = extractStaticSqlArgument(node, adapter, sourceCode);
    if (sqlArgument === null) return;

    const thisField = receiverRootIsThis(callee, adapter);
    const thisFieldType = thisField
      ? resolveThisFieldType(root, findEnclosingClassHeritage(ast, adapter, node, sourceCode))
      : null;

    const verdict = identifyHandle(
      {
        format: 'typescript',
        root,
        receiver,
        method,
        sqlArgument,
        thisField,
        thisFieldType,
      },
      {
        imports: new Map(),
        typeAnnotations: new Map(),
        bindings: new Map(),
        withinFileProvenance: new Map(),
        sqlDialect,
        resolution: { dialect: 'ts', env },
      },
    );

    if (verdict.kind === 'handle' && !dbProvenanced.has(root)) {
      dbProvenanced.set(root, {
        identifier: root,
        reason: 'sql-argument',
        source: 'SQL argument parses as a statement (Spec 70 R3)',
        chain: [],
      });
    }
  });

  return dbProvenanced;
}

/**
 * A serializable R3 site — one member-expression call whose static SQL argument
 * is a parseable literal, exactly the sites `applySqlArgumentInference` folds
 * `identifyHandle` over. `format` is absent because the R3 path is always
 * `typescript` (Go resolves cross-file and has no TS `RootResolutionEnv`). The
 * receiver-provenance corpus consumers carry this per file and re-run
 * `identifyHandle` corpus-side with the seeded provenance + rehydrated bindings.
 */
export interface R3Site {
  readonly root: string;
  readonly receiver: string;
  readonly method: string;
  readonly sqlArgument: string;
  readonly thisField: boolean;
  /** The resolved type of `this.<root>` from the enclosing class's base-class
   *  heritage (`extends WorkflowEntrypoint<Env>` → `this.env` is `Env`), or null
   *  when the site is not a `this` reference or has no heritage contract (Spec 70
   *  Q3). */
  readonly thisFieldType: string | null;
}

/**
 * Extract the R3 sites of a TS-family file — the member calls whose static SQL
 * argument proves their receiver a handle (Spec 70 criterion 8). This is the
 * provenance-free extraction half of {@link applySqlArgumentInference}: the same
 * candidate filter (DB/ORM shape) and the same static-argument test, but it
 * records the site instead of folding `identifyHandle`. The corpus-side
 * `applyR3FromSites` mirror re-runs the verdict once the seeded provenance and
 * bindings are known.
 * @param ast - The file's parsed AST.
 * @param adapter - The language adapter (used for the callee walk and Go skip).
 * @param sourceCode - The file's source text (for static-argument reads).
 * @returns The recorded R3 sites, or `[]` for Go.
 */
export function extractR3Sites(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): R3Site[] {
  if (adapter.name === 'go') return []; // Go resolves cross-file; no TS env here.

  const sites: R3Site[] = [];
  walkAST(ast.root, (node) => {
    if (node.type !== 'call_expression') return;
    const callee = getCallExpressionCallee(node, adapter);
    if (!callee) return;

    // Only member-expression calls carry the receiver whose handle-ness R3
    // proves. A bare-identifier call (`query('…')`) has no receiver to add.
    if (callee.type !== 'member_expression' && callee.type !== 'selector_expression') return;

    const method = extractMemberExpressionProperty(callee, adapter, sourceCode);
    if (!method) return;
    // The SQL argument — not the method name — is the admission proof. R3 folds
    // `identifyHandle` over every member call; a null static literal simply can't
    // prove a handle, so it falls through. No method-name set is consulted.
    const root = resolveReceiverRoot(callee, adapter, sourceCode);
    if (root === null) return;
    const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode) ?? root;

    const sqlArgument = extractStaticSqlArgument(node, adapter, sourceCode);
    if (sqlArgument === null) return;

    const thisField = receiverRootIsThis(callee, adapter);
    const thisFieldType = thisField
      ? resolveThisFieldType(root, findEnclosingClassHeritage(ast, adapter, node, sourceCode))
      : null;

    sites.push({
      root,
      receiver,
      method,
      sqlArgument,
      thisField,
      thisFieldType,
    });
  });

  return sites;
}

/** True when a member/selector chain bottoms out at `this`/`super`. */
function receiverRootIsThis(callee: ASTNode, adapter: LanguageAdapter): boolean {
  let current: ASTNode = callee;
  while (current.type === 'member_expression' || current.type === 'selector_expression') {
    const children = adapter.getChildren(current);
    const object = children.find(
      (c) => c.type !== '.' && c.type !== 'property_identifier' && c.type !== 'field_identifier',
    );
    if (!object) return false;
    current = object;
  }
  return current.type === 'this' || current.type === 'super';
}

/**
 * The statically-present SQL text of a call's first argument (string/template
 * literal), unquoted — or null when the first argument is not a literal or the
 * template carries a `${…}` substitution (dynamic). Mirrors the literal-argument
 * slice of the data-access analyzer's `extractStaticSql`; the tagged-template
 * and variable-assignment cases are not R3's concern here because a member
 * receiver already names the handle.
 */
function extractStaticSqlArgument(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  const children = adapter.getChildren(node);
  const args = children.find((c) => {
    const t = adapter.getNodeType(c);
    return t === 'arguments' || t === 'argument_list';
  });
  if (!args) return null;
  for (const arg of adapter.getChildren(args)) {
    const t = adapter.getNodeType(arg);
    if (t === '(' || t === ')' || t === ',') continue;
    if (t === 'string' || t === 'template_string') {
      if (t === 'template_string') {
        const kids = adapter.getChildren(arg) ?? [];
        if (kids.some((c) => adapter.getNodeType(c) === 'template_substitution')) return null;
      }
      const raw = adapter.getNodeText(arg, sourceCode) ?? '';
      return stripSqlQuotes(raw);
    }
    return null; // first non-trivia argument is not a literal → cannot parse.
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Wrapper detection — learn DB-wrapper function names from function bodies
// ═══════════════════════════════════════════════════════════════════════════

/** Function-node types whose bodies may define a DB wrapper. */
const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function_declaration',
  'generator_function_expression',
]);

/**
 * Learn DB-wrapper function names from function bodies and merge them into the
 * provenance map.
 *
 * A wrapper is a named function whose own body performs a DB operation — either
 * a `fetch` to the Cloudflare D1 HTTP query API, or a call that delegates to an
 * already DB-provenanced identifier/receiver. Adding the wrapper's name to
 * `dbProvenanced` lets `isDBProvenanced` treat a bare call like `d1(sql)` as a
 * DB call, so its SQL argument reaches the table rules (unknown-table /
 * stale-table-reference) and the data-access rules instead of bypassing them.
 *
 * This is structural evidence, not name matching — the function's body literally
 * talks to a database — so it is only run in hybrid mode (alongside the name
 * fallbacks), never strict `provenance`/`names` modes.
 *
 * @param ast The parsed file AST.
 * @param adapter The language adapter for the file's syntax.
 * @param sourceCode The raw source text.
 * @param dbProvenanced The current provenance map (mutated in place and returned).
 * @returns The provenance map with any learned wrapper names added.
 */
/** Shared predicate shape: does this node's own body wrap a DB operation? */
type WrapperPredicate = (
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>,
  bindings: ReadonlyMap<string, Binding>,
) => boolean;

/** A wrapper-detection spec: which node types to scan, the body predicate, and
 *  the provenance source label. */
interface WrapperSpec {
  nodeTypes: ReadonlySet<string>;
  isWrapper: WrapperPredicate;
  source: string;
}

/** Learn DB-wrapper names from nodes of `spec.nodeTypes` whose bodies wrap a DB
 *  operation, merging each learned name into `dbProvenanced`. */
function learnWrapperNames(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  dbProvenanced: Map<string, ProvenanceEvidence>,
  spec: WrapperSpec,
  bindings: ReadonlyMap<string, Binding>,
): Map<string, ProvenanceEvidence> {
  const nodes = adapter.findNodes(ast, {
    custom: (node: ASTNode) => spec.nodeTypes.has(node.type),
  });

  for (const node of nodes) {
    const name = adapter.getNodeName(node);
    if (!name) continue;
    if (dbProvenanced.has(name)) continue;
    if (!spec.isWrapper(node, adapter, sourceCode, dbProvenanced, bindings)) continue;
    dbProvenanced.set(name, {
      identifier: name,
      reason: 'wrapper',
      source: spec.source,
      chain: [],
    });
  }

  return dbProvenanced;
}

/** Class-node types that may wrap a DB handle (Spec 69 §10 — cross-file anchor). */
const WRAPPER_CLASS_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'class',
]);

/**
 * Learn DB-wrapper names and merge them into the provenance map.
 *
 * A wrapper is a named function/class whose own body performs a DB operation —
 * either a `fetch` to the Cloudflare D1 HTTP query API, or a call that delegates
 * to an already DB-provenanced identifier/receiver. Adding the wrapper's name to
 * `dbProvenanced` lets `isDBProvenanced` treat a bare call like `d1(sql)` as a
 * DB call, so its SQL argument reaches the table rules (unknown-table /
 * stale-table-reference) and the data-access rules instead of bypassing them.
 *
 * The class form (`options.classes`) is the object-form of the function form: its
 * body (fields + methods + constructor) constructs or calls a DB driver, so the
 * class *is* a DB handle — e.g. `export class Database { constructor() {
 * this.sql = neon(url) } query(t) { return this.sql(t) } }`. Class bodies are
 * scanned *through* method bodies (the driver call lives in the constructor) but
 * never into nested classes or nested function declarations — an inner named
 * function's DB op is not mis-attributed to the outer class.
 *
 * This is structural evidence, not name matching, so it is only run in hybrid
 * mode (alongside the name fallbacks), never strict `provenance`/`names` modes.
 *
 * @param ast the parsed file AST
 * @param adapter the language adapter used to walk nodes
 * @param sourceCode the file source text for reading node text
 * @param dbProvenanced the provenance map to merge learned wrapper names into
 * @param options when `classes` is true, also scan wrapper classes
 * @returns the provenance map with wrapper names added
 */
export function detectDbWrappers(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  dbProvenanced: Map<string, ProvenanceEvidence>,
  options?: { classes?: boolean },
): Map<string, ProvenanceEvidence> {
  const bindings = buildBindingEnv(ast, adapter, sourceCode);
  learnWrapperNames(ast, adapter, sourceCode, dbProvenanced, {
    nodeTypes: FUNCTION_NODE_TYPES,
    isWrapper: isDbWrapperBody,
    source: 'function body performs a DB operation',
  }, bindings);
  if (options?.classes) {
    learnWrapperNames(ast, adapter, sourceCode, dbProvenanced, {
      nodeTypes: WRAPPER_CLASS_TYPES,
      isWrapper: isDbWrapperClass,
      source: 'class body constructs or calls a DB driver',
    }, bindings);
  }
  return dbProvenanced;
}

/**
 * Form-5 (Spec 69 §10 S5f) — function return resolution.
 *
 * A call to an in-repo function resolves to its *returned construction*,
 * transitively: `export function getDB() { return new Database() }` proves
 * `getDB` is a DB handle because the returned expression is already provenanced —
 * the identifier's name is irrelevant. It is the binding form the two
 * `cli-integration` fixtures need: `const db = getDB()` in an importing file
 * resolves through the export fixed point (a provenanced `getDB` export is seeded
 * in importers) and then propagates via the existing rule 2 (call to a provenanced
 * identifier).
 *
 * This deliberately does NOT learn to accept mocks: a `getDB(): MockDB` with no
 * provenanced client anywhere in its chain is honestly not a handle, and stays
 * unprovenanced.
 *
 * @param ast the parsed file AST
 * @param adapter the language adapter used to find function nodes
 * @param sourceCode the file source text for reading return expressions
 * @param dbProvenanced the provenance map to merge learned names into
 * @returns the provenance map with DB-returning function names added
 */
export function detectDbReturningFunctions(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  dbProvenanced: Map<string, ProvenanceEvidence>,
): Map<string, ProvenanceEvidence> {
  const functionNodes = adapter.findNodes(ast, {
    custom: (node: ASTNode) => FUNCTION_NODE_TYPES.has(node.type),
  });

  for (const fn of functionNodes) {
    const name = adapter.getNodeName(fn);
    if (!name || dbProvenanced.has(name)) continue;

    // A `return` whose expression is an already-provenanced construction
    // (`return new Database(...)`, `return db`, `return drizzle(...)`).
    if (functionReturnsProvenanced(fn, adapter, sourceCode, dbProvenanced)) {
      dbProvenanced.set(name, {
        identifier: name,
        reason: 'propagation',
        source: 'returns a DB-provenanced construction',
        chain: [],
      });
    }
  }

  return dbProvenanced;
}

/**
 * True when any `return` statement in a function body returns an expression that
 * is itself a DB-provenanced construction — a provenanced identifier, a
 * `new`/call whose constructor/callee is provenanced, or a member expression on a
 * provenanced receiver.
 */
function functionReturnsProvenanced(
  fn: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>,
): boolean {
  let found = false;
  walkAST(fn, (node) => {
    if (found || node.type !== 'return_statement') return;
    const arg = adapter.getChildren(node).find((c) => c.type !== 'return');
    if (!arg) return;
    if (tryPropagateFromExpression(arg, adapter, sourceCode, dbProvenanced as Map<string, ProvenanceEvidence>)) {
      found = true;
    }
  });
  return found;
}

/**
 * Decide whether a class's own body performs a DB operation: a D1 REST fetch, a
 * call delegating to an already DB-provenanced identifier/receiver, or a
 * `new`/call to a DB-provenanced constructor/function (the driver a wrapper
 * class *owns*). Method bodies are included (the constructor is where the driver
 * call lives); nested classes and nested function declarations are excluded.
 */
function isDbWrapperClass(
  cls: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>,
  bindings: ReadonlyMap<string, Binding>,
): boolean {
  for (const expr of collectClassCallExpressions(cls, adapter)) {
    if (expr.type === 'new_expression') {
      const ctor = findChildOfType(expr, ['identifier', 'member_expression']);
      if (ctor) {
        const ctorName = extractIdentifierName(ctor, adapter, sourceCode);
        if (ctorName && dbProvenanced.has(ctorName)) return true;
      }
      continue;
    }
    if (isD1RestCall(expr, adapter, sourceCode)) return true;
    if (delegatesToProvenanced(expr, adapter, sourceCode, dbProvenanced, bindings)) return true;
  }
  return false;
}

/**
 * Collect `call_expression`/`new_expression` nodes within a class body, descending
 * through method bodies but never into nested classes or nested function
 * declarations (so an inner function's DB op doesn't make the class a wrapper).
 */
function collectClassCallExpressions(cls: ASTNode, adapter: LanguageAdapter): ASTNode[] {
  const expressions: ASTNode[] = [];
  const NESTED_SKIP = new Set([
    'class_declaration',
    'abstract_class_declaration',
    'class',
    'function_declaration',
    'function_expression',
    'arrow_function',
    'generator_function_declaration',
    'generator_function_expression',
  ]);
  const walk = (node: ASTNode): void => {
    for (const child of adapter.getChildren(node)) {
      if (NESTED_SKIP.has(child.type)) continue;
      if (child.type === 'call_expression' || child.type === 'new_expression') {
        expressions.push(child);
      }
      walk(child);
    }
  };
  walk(cls);
  return expressions;
}

/**
 * Decide whether a function's own body performs a DB operation: a D1 REST fetch,
 * or a call delegating to an already DB-provenanced receiver/identifier.
 * Nested function bodies are excluded so an inner function's DB op is not
 * mis-attributed to an outer wrapper.
 */
function isDbWrapperBody(
  fn: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>,
  bindings: ReadonlyMap<string, Binding>,
): boolean {
  const calls = collectOwnCallExpressions(fn, adapter);
  for (const call of calls) {
    if (isD1RestCall(call, adapter, sourceCode)) return true;
    if (delegatesToProvenanced(call, adapter, sourceCode, dbProvenanced, bindings)) return true;
  }
  return false;
}

/**
 * Collect call_expression nodes within `fn`'s body, not descending into nested
 * function declarations/expressions (so an inner function's DB op doesn't make
 * the outer function look like a wrapper).
 */
function collectOwnCallExpressions(fn: ASTNode, adapter: LanguageAdapter): ASTNode[] {
  const calls: ASTNode[] = [];
  const walk = (node: ASTNode): void => {
    for (const child of adapter.getChildren(node)) {
      if (FUNCTION_NODE_TYPES.has(child.type)) continue;
      if (child.type === 'call_expression') calls.push(child);
      walk(child);
    }
  };
  walk(fn);
  return calls;
}

/**
 * True when `call` is a `fetch(...)` to the Cloudflare D1 HTTP query API
 * (`…/d1/database/<id>/query`). That endpoint is specific enough that a match
 * is conclusive evidence the surrounding function is a D1 wrapper.
 */
function isD1RestCall(call: ASTNode, adapter: LanguageAdapter, sourceCode: string): boolean {
  const callee = getCallExpressionCallee(call, adapter);
  if (!callee) return false;
  const calleeText = adapter.getNodeText(callee, sourceCode) ?? '';
  if (calleeText !== 'fetch' && !calleeText.endsWith('.fetch')) return false;
  const callText = adapter.getNodeText(call, sourceCode) ?? '';
  return callText.includes('/d1/database/');
}

/**
 * True when `call` delegates to an identifier or member-receiver that is already
 * DB-provenanced (e.g. `db.prepare(...)` inside a `d1Query(sql)` wrapper).
 */
function delegatesToProvenanced(
  call: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>,
  bindings: ReadonlyMap<string, Binding>,
): boolean {
  const callee = getCallExpressionCallee(call, adapter);
  if (!callee) return false;

  if (callee.type === 'identifier') {
    const name = adapter.getNodeText(callee, sourceCode);
    return name !== null && dbProvenanced.has(name);
  }

  if (callee.type === 'member_expression' || callee.type === 'selector_expression') {
    const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode);
    if (!receiver) return false;
    const receiverProvenanced =
      dbProvenanced.has(receiver) ||
      // Compound receivers ("env.DB", "db.users") — match any dotted segment.
      receiver.split('.').some((part) => dbProvenanced.has(part));
    if (!receiverProvenanced) return false;
    // The receiver root's declaration — not the method name — decides whether
    // this is a DB operation (`db.prepare(…)`) or an in-memory mutation on a
    // provenanced *result* (`provenancedMap.set(k, v)`, `rows.map(…)`):
    // `join` is both `Array.prototype.join` and `SQL JOIN`, so a method name
    // cannot discriminate. Provenance is deliberately left out of the env so the
    // receiver's own declaration (an array/Map/Set/JS-global/primitive →
    // not-handle) is consulted rather than its propagated provenance.
    const root = resolveReceiverRoot(callee, adapter, sourceCode);
    if (root === null) return false;
    const env: RootResolutionEnv = {
      provenance: new Map(),
      bindings,
      adapter,
      sourceCode,
    };
    return classifyRootIdentifier(root, env) !== 'not-handle';
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-call-site dialect (Spec 70)
// ═══════════════════════════════════════════════════════════════════════════

/** The SQL dialect a DB-driver package's evidence names, or null when the
 *  evidence carries no package or the package names no single dialect. */
function dialectForEvidence(evidence: ProvenanceEvidence | undefined): Dialect | null {
  if (!evidence?.packageName) return null;
  return dialectForPackage(evidence.packageName);
}

/**
 * Resolve the SQL dialect a call site should parse its SQL argument under, from
 * the package its receiver traces to (Spec 70 — per-site dialect). The dialect
 * is a property of the *located fact*, not the repo: `pool.query(…)` where
 * `pool` resolves to `pg` is postgres, `conn.query(…)` where `conn` resolves to
 * `mysql2` is mysql. A repo with two drivers is therefore not "ambiguous" for a
 * site whose receiver resolves to one of them — that site names its dialect and
 * parses honestly.
 *
 * Returns null when the receiver carries no package (a wrapper, a type
 * annotation, an in-repo module, a cross-dialect ORM like `knex`) or when that
 * package names no single dialect — the caller then falls back to repo-level
 * detection (`detectDialect`), and abstains only when that is also null.
 *
 * @param node The call-expression node whose callee is under test.
 * @param adapter The language adapter for child traversal.
 * @param sourceCode The file source text (for reading node text).
 * @param provenanceContext The resolved provenance context for this file.
 * @returns The receiver's dialect, or null when the receiver doesn't resolve to one.
 */
export function resolveSiteDialect(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  provenanceContext: ProvenanceContext | undefined,
): Dialect | null {
  if (!provenanceContext) return null;
  const calleeNode = getCallExpressionCallee(node, adapter);
  if (!calleeNode) return null;

  // Bare-identifier call (a wrapper like `d1(sql)`) → the identifier's package.
  if (calleeNode.type === 'identifier') {
    const name = adapter.getNodeText(calleeNode, sourceCode);
    if (!name) return null;
    return dialectForEvidence(provenanceContext.dbProvenanced.get(name));
  }

  // Member-expression call (`pool.query(...)`) → the receiver's package. Match the
  // full receiver text and each dotted segment, mirroring
  // `isMemberExpressionDBProvenanced` (`env.DB` / `db.users` / `this.db`).
  if (calleeNode.type === 'member_expression' || calleeNode.type === 'selector_expression') {
    const receiver = getMemberExpressionReceiver(calleeNode, adapter, sourceCode);
    if (!receiver) return null;
    for (const candidate of [receiver, ...receiver.split('.')]) {
      const dialect = dialectForEvidence(provenanceContext.dbProvenanced.get(candidate));
      if (dialect) return dialect;
    }
  }

  return null;
}

/**
 * Check if an identifier is validator-provenanced (R4 infrastructure).
 *
 * This will be consumed by Spec 15's validator-bypass detection.
 * @param context
 * @param identifier
 * @returns
 */
export function isValidatorProvenanced(
  identifier: string,
  context: ProvenanceContext,
): boolean {
  return context.validatorProvenanced.has(identifier);
}

// ═══════════════════════════════════════════════════════════════════════════
// Inference (R2 — to be wired during R2 implementation)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Infer additional DB receivers by tracing identifiers that call DB methods
 * back through assignment chains to provenanced sources.
 *
 * This is the conjunctive inference guard in action: an identifier is only
 * inferred if it (a) appears as a receiver of a known DB call method AND
 * (b) can be traced back to a provenanced source through assignments.
 *
 * Deferred: full implementation in R2 step.
 * @param adapter
 * @param fileAst
 * @param provenancedSet
 * @param sourceCode
 * @returns
 */
export function inferReceivers(
  provenancedSet: Map<string, ProvenanceEvidence>,
  fileAst: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): InferredReceiverSet {
  const inferred: InferredReceiverSet = { identifiers: [], evidence: [] };
  const seen = new Set<string>();

  // Step 1: Build an assignment graph — name → source text of initializer
  const assignmentGraph = buildAssignmentGraph(fileAst, adapter, sourceCode);

  const ctx: InferReceiverContext = {
    adapter, sourceCode, provenancedSet, assignmentGraph, seen, inferred,
  };

  // Step 2: Walk all call expressions whose callee is a member expression
  walkAST(fileAst.root, (node) => inferReceiverFromCall(node, ctx));

  return inferred;
}

/** Shared context threaded through the per-call receiver-inference walk. */
interface InferReceiverContext {
  adapter: LanguageAdapter;
  sourceCode: string;
  provenancedSet: Map<string, ProvenanceEvidence>;
  assignmentGraph: Map<string, string>;
  seen: Set<string>;
  inferred: InferredReceiverSet;
}

/** Infer a receiver from a single call_expression node, if it qualifies. */
function inferReceiverFromCall(node: ASTNode, ctx: InferReceiverContext): void {
  const { adapter, sourceCode, provenancedSet, assignmentGraph, seen, inferred } = ctx;
  if (node.type !== 'call_expression') return;

  const callee = getCallExpressionCallee(node, adapter);
  if (!callee || (callee.type !== 'member_expression' && callee.type !== 'selector_expression')) return;

  const methodName = extractMemberExpressionProperty(callee, adapter, sourceCode);
  if (!methodName || extractStaticSqlArgument(node, adapter, sourceCode) === null) return;

  const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode);
  if (!receiver) return;

  // Already provenanced → first-class, not inferred; already added → skip
  if (provenancedSet.has(receiver) || seen.has(receiver)) return;

  // Step 3: Trace receiver through assignment chain to a provenanced source
  const traced = traceAssignmentChain(receiver, assignmentGraph, provenancedSet);

  if (traced.found) {
    seen.add(receiver);
    inferred.identifiers.push(receiver);
    inferred.evidence.push({
      identifier: receiver,
      reason: `calls .${methodName}() traced to ${traced.chains[0]} — ${traced.reason}`,
    });
  }
}

/** Bundled state for the reverse assignment-graph builders. */
interface AssignmentGraphContext {
  graph: Map<string, string>;
  adapter: LanguageAdapter;
  sourceCode: string;
}

/**
 * Build a reverse assignment graph from the AST.
 * Maps variable name → the text of its initializer expression.
 * Handles: const/let/var declarations, parameter defaults, class fields.
 */
function buildAssignmentGraph(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): Map<string, string> {
  const ctx: AssignmentGraphContext = {
    graph: new Map<string, string>(),
    adapter,
    sourceCode,
  };

  walkAST(ast.root, (node, parent) => {
    recordVariableDeclarator(node, ctx);
    recordParameterDefault(node, parent, ctx);
    recordClassField(node, ctx);
  });

  return ctx.graph;
}

/** Record `const/let/var x = <expr>` into the assignment graph. */
function recordVariableDeclarator(
  node: ASTNode,
  ctx: AssignmentGraphContext,
): void {
  if (node.type !== 'variable_declarator') return;
  const { nameNode, valueNode } = splitVariableDeclarator(node, ctx.adapter);
  if (!nameNode || !valueNode) return;
  const names = extractPatternNames(nameNode, ctx.adapter, ctx.sourceCode);
  const valueText = ctx.adapter.getNodeText(valueNode, ctx.sourceCode);
  for (const name of names) {
    if (!ctx.graph.has(name)) ctx.graph.set(name, valueText);
  }
}

/** Record parameter defaults (`function foo(x = <expr>)`) into the graph. */
function recordParameterDefault(
  node: ASTNode,
  parent: ASTNode | null,
  ctx: AssignmentGraphContext,
): void {
  if (node.type !== 'assignment_pattern' || parent?.type !== 'formal_parameters') {
    return;
  }
  const children = ctx.adapter.getChildren(node);
  if (children.length < 2) return;
  const leftNode = children[0];
  const rightNode = children[1];
  if (leftNode.type !== 'identifier') return;
  const paramName = ctx.adapter.getNodeText(leftNode, ctx.sourceCode);
  const valueText = ctx.adapter.getNodeText(rightNode, ctx.sourceCode);
  if (!ctx.graph.has(paramName)) ctx.graph.set(paramName, valueText);
}

/** Record class-field initializers (`fieldName = <expr>`) into the graph. */
function recordClassField(
  node: ASTNode,
  ctx: AssignmentGraphContext,
): void {
  if (
    node.type !== 'public_field_definition' &&
    node.type !== 'field_definition'
  ) {
    return;
  }
  const children = ctx.adapter.getChildren(node);
  const nameChild = children.find((c) => c.type === 'property_identifier');
  const valueChild = children.find(
    (c) =>
      c.type !== 'property_identifier' &&
      c.type !== 'decorator' &&
      c.type !== 'private' &&
      c.type !== 'public' &&
      c.type !== 'protected' &&
      c.type !== 'static' &&
      c.type !== 'readonly' &&
      c.type !== 'abstract' &&
      c.type !== '=',
  );
  if (!nameChild || !valueChild) return;
  const fieldName = ctx.adapter.getNodeText(nameChild, ctx.sourceCode);
  const valueText = ctx.adapter.getNodeText(valueChild, ctx.sourceCode);
  if (!ctx.graph.has(fieldName)) ctx.graph.set(fieldName, valueText);
}

/**
 * Trace a receiver identifier through the assignment graph to see if it
 * ultimately resolves to a provenanced source.
 */
function traceAssignmentChain(
  receiver: string,
  assignmentGraph: Map<string, string>,
  provenancedSet: Map<string, ProvenanceEvidence>,
): { found: boolean; chains: string[]; reason: string } {
  const visited = new Set<string>();
  const chain: string[] = [receiver];
  let current = receiver;
  let depth = 0;
  const MAX_DEPTH = 10;

  while (depth < MAX_DEPTH) {
    // Check if current is directly provenanced
    if (provenancedSet.has(current)) {
      return {
        found: true,
        chains: chain,
        reason: provenancedSet.get(current)!.source,
      };
    }

    const initText = assignmentGraph.get(current);
    if (initText) {
      const idents = extractTopLevelIdentifiers(initText);
      for (const ident of idents) {
        if (provenancedSet.has(ident)) {
          chain.push(current);
          return {
            found: true,
            chains: chain,
            reason: provenancedSet.get(ident)!.source,
          };
        }
      }
    }

    if (!initText || visited.has(initText)) break;
    visited.add(initText);

    const next = findNextTraceIdentifier(initText, assignmentGraph, visited);
    if (!next) break;
    chain.push(next);
    current = next;
    depth++;
  }

  return { found: false, chains: [], reason: '' };
}

/** Find the next assignment-graph identifier to trace, if any. */
function findNextTraceIdentifier(
  initText: string,
  assignmentGraph: Map<string, string>,
  visited: Set<string>,
): string | null {
  const idents = extractTopLevelIdentifiers(initText);
  for (const ident of idents) {
    if (assignmentGraph.has(ident) && !visited.has(ident)) {
      return ident;
    }
  }
  return null;
}

/**
 * Extract top-level identifier names from an expression text.
 * E.g., "db.prepare(sql)" → ["db"], "getConnection()" → ["getConnection"]
 */
function extractTopLevelIdentifiers(text: string): string[] {
  // Strip member access and arguments to get the root identifier
  // Match the first identifier before any '.' or '('
  const match = text.match(/^[\p{L}_$][\p{L}\p{N}_$]*/u);
  if (match && match[0]) {
    return [match[0]];
  }
  return [];
}

/**
 * Extract the property name from a member expression node.
 * For `db.prepare` → "prepare", for `db.sql.prepare` → "prepare"
 *
 * @param node the member/selector expression node
 * @param adapter the language adapter used to read children
 * @param sourceCode the file source text for reading node text
 * @returns the property identifier text, or `null`
 */
export function extractMemberExpressionProperty(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  const children = adapter.getChildren(node);
  // The property is the last non-dot child
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.type === 'property_identifier' || child.type === 'field_identifier') {
      return adapter.getNodeText(child, sourceCode);
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TS within-file-provenance split — the extract arm (Spec 70 Item 4 / Item 3)
// ═══════════════════════════════════════════════════════════════════════════
//
// `extractTsWithinFileProvenance` projects everything `computeTsWithinFileProvenance`
// reads from a single file's AST into a serializable `TsWithinFileProvenanceExtract`
// (see tsExpressionDescriptor.ts). The classify arm re-runs the fixed point over the
// projection with no AST. The two are pinned byte-identical by the parity spec.
//
// Every helper below is the *structural* half — provenance-free — so it may run at
// extract time. The semantic half (which name resolves to which evidence) is
// deferred to classify, where the provenance map is known.

/** Project an `await` expression: the first non-`await` child carries the value. */
function describeAwaitExpression(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): TsExpressionDescriptor {
  for (const child of adapter.getChildren(node)) {
    if (child.type === 'await') continue;
    return { kind: 'await', operand: describeTsExpression(child, adapter, sourceCode) };
  }
  return { kind: 'await', operand: null };
}

/** Project a `new` expression: the leftmost identifier of its constructor. */
function describeNewExpression(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): TsExpressionDescriptor {
  const ctor = findChildOfType(node, ['identifier', 'member_expression']);
  return { kind: 'new', ctorName: ctor ? extractIdentifierName(ctor, adapter, sourceCode) : null };
}

/** Project a call expression: the callee (via `getCallExpressionCallee`) + its args. */
function describeCallExpression(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): TsExpressionDescriptor {
  const calleeNode = getCallExpressionCallee(node, adapter);
  const callee = calleeNode ? describeTsExpression(calleeNode, adapter, sourceCode) : null;
  const argsNode = adapter.getChildren(node).find((c) => c.type === 'arguments');
  const args: TsExpressionDescriptor[] = [];
  if (argsNode) {
    for (const arg of adapter.getChildren(argsNode)) {
      if (arg.type === '(' || arg.type === ')' || arg.type === ',') continue;
      args.push(describeTsExpression(arg, adapter, sourceCode));
    }
  }
  return { kind: 'call', callee, args };
}

/** Project a member expression: receiver (object) + property + full source text. */
function describeMemberExpression(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): TsExpressionDescriptor {
  const children = adapter.getChildren(node);
  const receiver = children[0] ? describeTsExpression(children[0], adapter, sourceCode) : null;
  let property: string | null = null;
  for (const child of children) {
    if (child.type === 'property_identifier' || child.type === 'field_identifier') {
      property = adapter.getNodeText(child, sourceCode);
      break;
    }
  }
  return { kind: 'member', receiver, property, text: adapter.getNodeText(node, sourceCode) };
}

/**
 * Project a value-expression node into a {@link TsExpressionDescriptor}. Mirrors
 * the *structural* dispatch of `tryPropagateFromExpression`: `await` → `new` →
 * `call` → `identifier` → `member`, and anything else collapses to `unproven`.
 */
function describeTsExpression(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): TsExpressionDescriptor {
  switch (node.type) {
    case 'await_expression':
      return describeAwaitExpression(node, adapter, sourceCode);
    case 'new_expression':
      return describeNewExpression(node, adapter, sourceCode);
    case 'call_expression':
      return describeCallExpression(node, adapter, sourceCode);
    case 'identifier':
      return { kind: 'identifier', name: adapter.getNodeText(node, sourceCode) };
    case 'member_expression':
      return describeMemberExpression(node, adapter, sourceCode);
    default:
      return { kind: 'unproven' };
  }
}

/** Child types excluded when locating a class-field initializer (mirrors `propagateClassField`). */
const CLASS_FIELD_EXCLUDED = new Set([
  'property_identifier',
  'decorator',
  'accessibility_modifier',
  'private',
  'public',
  'protected',
  'static',
  'readonly',
  'abstract',
  'type_annotation',
]);

/**
 * Project a single file's AST into the serializable {@link TsWithinFileProvenanceExtract}
 * that `classifyTsWithinFileProvenance` re-runs the provenance fixed point over.
 *
 * Everything here is provenance-free (structural reads of the AST + source text),
 * so it can run once at parse time and be carried as a file fact. The semantic
 * resolution — which name a value resolves to under the current provenance map —
 * is deferred to the classify arm.
 * @param ast - The file's parsed AST.
 * @param adapter - The language adapter (drives the walk + node-text reads).
 * @param sourceCode - The file's source text (for structural reads).
 * @returns The provenance-free `TsWithinFileProvenanceExtract` projection.
 */
export function extractTsWithinFileProvenance(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
): TsWithinFileProvenanceExtract {
  const seeds = extractDBProvenancedImports(ast, adapter);
  const localFunctions = collectLocalFunctionNames(ast, adapter, sourceCode);
  const bindings = buildBindingEnv(ast, adapter, sourceCode);
  const interfaceFields = extractInterfaceFields(ast, adapter, sourceCode);

  // ── Propagation rules, in `walkAST` pre-order ─────────────────────────────
  const propagationRules: PropagationRule[] = [];
  walkAST(ast.root, (node, parent) => {
    if (node.type === 'variable_declarator') {
      const { nameNode, valueNode } = splitVariableDeclarator(node, adapter);
      if (!nameNode) return;
      const names = extractPatternNames(nameNode, adapter, sourceCode);
      const value = valueNode ? describeTsExpression(valueNode, adapter, sourceCode) : null;
      propagationRules.push({ kind: 'variable-declarator', names, value });
      return;
    }

    if (node.type === 'assignment_pattern' && parent?.type === 'formal_parameters') {
      const children = adapter.getChildren(node);
      if (children.length < 2 || children[0].type !== 'identifier') return;
      propagationRules.push({
        kind: 'default-parameter',
        name: adapter.getNodeText(children[0], sourceCode),
        value: describeTsExpression(children[1], adapter, sourceCode),
      });
      return;
    }

    if (node.type === 'public_field_definition' || node.type === 'field_definition') {
      const children = adapter.getChildren(node);
      const nameChild = children.find((c) => c.type === 'property_identifier');
      if (!nameChild) return;
      const valueChild = children.find((c) => !CLASS_FIELD_EXCLUDED.has(c.type));
      if (!valueChild) return;
      propagationRules.push({
        kind: 'class-field',
        field: adapter.getNodeText(nameChild, sourceCode),
        value: describeTsExpression(valueChild, adapter, sourceCode),
      });
      return;
    }

    if (node.type === 'assignment_expression') {
      const children = adapter.getChildren(node);
      const lhs = children.find(
        (c) => c.type === 'member_expression' || c.type === 'selector_expression',
      );
      if (!lhs) return;
      const lhsChildren = adapter.getChildren(lhs);
      const obj = lhsChildren.find((c) => c.type === 'this' || c.type === 'super');
      if (!obj) return;
      const prop = lhsChildren.find(
        (c) => c.type === 'property_identifier' || c.type === 'field_identifier',
      );
      if (!prop) return;
      const fieldName = adapter.getNodeText(prop, sourceCode);
      if (!fieldName) return;
      const rhs = children[children.length - 1];
      if (!rhs || rhs.type === 'member_expression' || rhs.type === 'selector_expression') return;
      propagationRules.push({
        kind: 'member-assignment',
        field: fieldName,
        value: describeTsExpression(rhs, adapter, sourceCode),
      });
      return;
    }
  });

  // ── Wrapper functions, wrapper classes, returning functions ────────────────
  // One `findNodes` pass for functions (wrappers + returning) and one for classes,
  // matching the order `detectDbWrappers` / `detectDbReturningFunctions` consume.
  const wrapperFunctions: { name: string; ownCalls: OwnCall[] }[] = [];
  const returningFunctions: { name: string; returnExprs: TsExpressionDescriptor[] }[] = [];

  const functionNodes = adapter.findNodes(ast, {
    custom: (n: ASTNode) => FUNCTION_NODE_TYPES.has(n.type),
  });
  for (const fn of functionNodes) {
    const name = adapter.getNodeName(fn);
    if (!name) continue;

    const ownCalls: OwnCall[] = collectOwnCallExpressions(fn, adapter).map((call) => ({
      callee: getCallExpressionCallee(call, adapter)
        ? describeTsExpression(getCallExpressionCallee(call, adapter)!, adapter, sourceCode)
        : null,
      isD1Rest: isD1RestCall(call, adapter, sourceCode),
    }));
    wrapperFunctions.push({ name, ownCalls });

    const returnExprs: TsExpressionDescriptor[] = [];
    walkAST(fn, (n) => {
      if (n.type !== 'return_statement') return;
      const arg = adapter.getChildren(n).find((c) => c.type !== 'return');
      if (!arg) return;
      returnExprs.push(describeTsExpression(arg, adapter, sourceCode));
    });
    returningFunctions.push({ name, returnExprs });
  }

  const wrapperClasses: { name: string; classCalls: ClassCall[] }[] = [];
  const classNodes = adapter.findNodes(ast, {
    custom: (n: ASTNode) => WRAPPER_CLASS_TYPES.has(n.type),
  });
  for (const cls of classNodes) {
    const name = adapter.getNodeName(cls);
    if (!name) continue;
    const classCalls: ClassCall[] = collectClassCallExpressions(cls, adapter).map((expr) => {
      if (expr.type === 'new_expression') {
        const ctor = findChildOfType(expr, ['identifier', 'member_expression']);
        return { kind: 'new', ctorName: ctor ? extractIdentifierName(ctor, adapter, sourceCode) : null };
      }
      const calleeNode = getCallExpressionCallee(expr, adapter);
      return {
        kind: 'call',
        callee: calleeNode ? describeTsExpression(calleeNode, adapter, sourceCode) : null,
        isD1Rest: isD1RestCall(expr, adapter, sourceCode),
      };
    });
    wrapperClasses.push({ name, classCalls });
  }

  return { seeds, bindings, localFunctions, propagationRules, wrapperFunctions, wrapperClasses, returningFunctions, interfaceFields };
}
