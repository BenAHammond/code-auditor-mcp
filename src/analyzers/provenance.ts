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

// ═══════════════════════════════════════════════════════════════════════════
// Constants — the universal vocabulary (package names are language-invariant)
// ═══════════════════════════════════════════════════════════════════════════

/** Database packages — spec R1.1 */
export const DB_PACKAGES: ReadonlySet<string> = new Set([
  'better-sqlite3',
  'drizzle-orm',
  '@prisma/client',
  'pg',
  'mysql2',
  'postgres',
  'kysely',
  'knex',
  'mongodb',
  'mongoose',
  '@libsql/client',
  '@planetscale/database',
  '@neondatabase/serverless',
  '@vercel/postgres',
  'bun:sqlite',
  'node:sqlite',
]);

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

/** Known DB type names — spec R1.1 (propagation rule 8) */
export const DB_TYPES: ReadonlySet<string> = new Set([
  'D1Database',
  'D1PreparedStatement',
  'D1Result',
  'Database',
  'Pool',
  'PrismaClient',
  'Kysely',
  'Connection',
  'SqliteDatabase',
  'BetterSQLite3Database',
]);

/**
 * DB call methods — the fixed API surface (language-invariant).
 *
 * Spec 33 Item 11 FP category 5: the bare-identifier hybrid fallback in
 * `isDBProvenanced` treated any `get(...)` / `each(...)` / `values(...)` call
 * as a DB query, flagging lodash-style object accessors (e.g.
 * `@directus/utils`'s `get(item, ...)`) as sql-injection. Those three names
 * are also common non-DB methods (lodash `get`, jQuery/iterator
 * `each`, Map/WebSocket `.values()`), so they are removed from the fallback —
 * mirroring the `get`/`each` trim in CHANGELOG 3.4.9 (DB_CALL_METHOD_NAMES).
 *
 * `query` is deliberately RETAINED: it is a genuine query-execution method on
 * mysql2, pg, node-postgres, D1 and Planetscale (`.query(...)`), and the
 * spec-19 data-access fixtures exercise it as a canonical DB entry point.
 * Removing it would turn real SQL-injection positives into false negatives.
 *
 * `raw` is deliberately retained: it is a genuine raw-execution method on
 * D1 prepared statements, Knex, and Kysely, and the Item-6 taint-tracking
 * fixtures exercise it as the canonical raw-SQL entry point.
 */
export const DB_CALL_METHODS: ReadonlySet<string> = new Set([
  'exec',
  'prepare',
  'batch',
  'run',
  'all',
  'first',
  'query',
  'raw',
]);

/** ORM method patterns — fixed API surface for ORM recognition (Spec 21 R1) */
export const ORM_METHODS: ReadonlySet<string> = new Set([
  'find',
  'findOne',
  'findMany',
  'findFirst',
  'findUnique',
  'select',
  'insert',
  'insertMany',
  'update',
  'updateOne',
  'updateMany',
  'delete',
  'deleteOne',
  'deleteMany',
  'from',
  'where',
  'join',
  'leftJoin',
  'rightJoin',
  'innerJoin',
  'create',
  'createMany',
  'aggregate',
  'count',
  'distinct',
  'execute',
  'query',
]);

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type ProvenanceReason = 'package' | 'binding' | 'type' | 'propagation' | 'fallback';

export interface ProvenanceEvidence {
  identifier: string;
  reason: ProvenanceReason;
  /** Human-readable source of provenance, e.g. "import from better-sqlite3" */
  source: string;
  /** Chain of propagation — each hop records the intermediate identifier */
  chain: string[];
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
 * Extract all DB-provenanced identifiers from a file's import statements.
 *
 * An import like `import Database from 'better-sqlite3'` produces
 * `Database` as DB-provenanced with reason "package".
 * @param adapter
 * @param ast
 * @returns
 */
export function extractDBProvenancedImports(
  ast: AST,
  adapter: LanguageAdapter,
): Map<string, ProvenanceEvidence> {
  const seedMap = new Map<string, ProvenanceEvidence>();
  const imports = adapter.extractImports(ast);

  for (const imp of imports) {
    const specifier = imp.source;
    if (!matchesDBPackage(specifier)) continue;

    for (const spec of imp.specifiers) {
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
        });
      }
    }
  }

  return seedMap;
}

/**
 * Extract all validator-provenanced identifiers from a file's imports.
 * Same pattern as extractDBProvenancedImports but for validator packages.
 * @param adapter
 * @param ast
 * @returns
 */
export function extractValidatorProvenancedImports(
  ast: AST,
  adapter: LanguageAdapter,
): Map<string, ProvenanceEvidence> {
  const seedMap = new Map<string, ProvenanceEvidence>();
  const imports = adapter.extractImports(ast);

  for (const imp of imports) {
    const specifier = imp.source;
    if (!matchesValidatorPackage(specifier)) continue;

    for (const spec of imp.specifiers) {
      const localName = spec.alias ?? spec.name;
      const label = spec.isDefault
        ? `default import from ${specifier}`
        : spec.isNamespace
          ? `namespace import from ${specifier}`
          : `named import from ${specifier}`;

      if (!seedMap.has(localName)) {
        seedMap.set(localName, {
          identifier: localName,
          reason: 'package',
          source: label,
          chain: [],
        });
      }
    }
  }

  return seedMap;
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
  const { nameNode, valueNode, typeAnnotationNode } =
    splitVariableDeclarator(node, ctx.adapter);

  if (!nameNode) return false;

  let mutated = false;

  // Rule 8: type annotation — let x: D1Database
  if (typeAnnotationNode) {
    mutated = propagateFromTypeAnnotation(nameNode, typeAnnotationNode, ctx);
  }

  if (valueNode) {
    mutated = propagateFromValue(nameNode, valueNode, ctx) || mutated;
  }

  return mutated;
}

/** Rule 8: type annotation — `let x: D1Database`. */
function propagateFromTypeAnnotation(
  nameNode: ASTNode,
  typeAnnotationNode: ASTNode,
  ctx: PropagationContext,
): boolean {
  if (nameNode.type !== 'identifier') return false;
  const typeText = ctx.adapter.getNodeText(typeAnnotationNode, ctx.sourceCode).trim();
  if (!DB_TYPES.has(typeText)) return false;
  const name = ctx.adapter.getNodeText(nameNode, ctx.sourceCode);
  if (ctx.provenanceMap.has(name)) return false;
  ctx.provenanceMap.set(name, {
    identifier: name,
    reason: 'type',
    source: `type annotation ${typeText}`,
    chain: [],
  });
  return true;
}

/** Propagate provenance from a declarator's value expression into its names. */
function propagateFromValue(
  nameNode: ASTNode,
  valueNode: ASTNode,
  ctx: PropagationContext,
): boolean {
  const propagated = tryPropagateFromExpression(
    valueNode, ctx.adapter, ctx.sourceCode, ctx.provenanceMap,
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
  );
  if (propagated && !provenanceMap.has(paramName)) {
    provenanceMap.set(paramName, {
      identifier: paramName,
      reason: 'propagation',
      source: `default parameter = ${propagated.source}`,
      chain: [...propagated.chain, propagated.identifier],
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
): boolean {
  const children = adapter.getChildren(node);
  // Typically [name, value] or [decorators..., name, value]
  const nameChild = children.find(
    (c) => c.type === 'property_identifier',
  );
  const valueChild = children.find(
    (c) =>
      c.type !== 'property_identifier' &&
      c.type !== 'decorator' &&
      c.type !== 'private' &&
      c.type !== 'public' &&
      c.type !== 'protected' &&
      c.type !== 'static' &&
      c.type !== 'readonly' &&
      c.type !== 'abstract',
  );

  if (nameChild && valueChild) {
    const fieldName = adapter.getNodeText(nameChild, sourceCode);
    const propagated = tryPropagateFromExpression(
      valueChild,
      adapter,
      sourceCode,
      provenanceMap,
    );
    if (propagated && !provenanceMap.has(fieldName)) {
      provenanceMap.set(fieldName, {
        identifier: fieldName,
        reason: 'propagation',
        source: `class field initialized from ${propagated.source}`,
        chain: [...propagated.chain, propagated.identifier],
      });
      return true;
    }
  }
  return false;
}

/**
 * Apply the single-file propagation rules for one AST node, mutating the
 * provided provenance map. Returns true if any new identifier was added.
 *
 * Rules 1-8 (spec R1): variable declarations (1-3, 8), default parameters
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
    return propagateDefaultParameter(node, adapter, sourceCode, provenanceMap);
  }

  if (
    node.type === 'public_field_definition' ||
    node.type === 'field_definition'
  ) {
    return propagateClassField(node, adapter, sourceCode, provenanceMap);
  }

  return false;
}

/**
 * Propagate provenance through assignments, destructuring, parameters,
 * class fields, and type annotations within a single file.
 *
 * The 8 single-file propagation rules (spec R1):
 *   1. new Expression → variable
 *   2. DB-provenanced call return → variable
 *   3. member expression on DB receiver → variable
 *   4. object destructuring from DB source
 *   5. array destructuring from DB source
 *   6. default parameter with DB value
 *   7. class field initialized with DB value
 *   8. type annotation with known DB type
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
  const ctx: PropagationContext = { adapter, sourceCode, provenanceMap };
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
): ProvenanceEvidence | null {
  // ── Rule 1: new Database(...) ──
  if (node.type === 'new_expression') {
    const constructorNode = findChildOfType(node, [
      'identifier',
      'member_expression',
    ]);
    if (constructorNode) {
      const name = extractIdentifierName(constructorNode, adapter, sourceCode);
      if (name && provenanceMap.has(name)) {
        return provenanceMap.get(name)!;
      }
    }
  }

  // ── Rule 2: drizzle(env.DB) — call where callee is DB-provenanced ──
  // ── Rule 3: db.prepare(sql) — member expression call on DB receiver ──
  if (node.type === 'call_expression') {
    const viaCall = tryCallProvenance(node, adapter, sourceCode, provenanceMap);
    if (viaCall) return viaCall;
  }

  // ── Simple identifier reference (for destructuring sources) ──
  if (node.type === 'identifier') {
    const name = adapter.getNodeText(node, sourceCode);
    if (name && provenanceMap.has(name)) {
      return provenanceMap.get(name)!;
    }
  }

  // ── Member expression on DB-provenanced source (for non-call uses) ──
  if (node.type === 'member_expression') {
    const receiver = getMemberExpressionReceiver(node, adapter, sourceCode);
    if (receiver && provenanceMap.has(receiver)) {
      return provenanceMap.get(receiver)!;
    }
  }

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
): ProvenanceEvidence | null {
  const calleeNode = getCallExpressionCallee(node, adapter);
  if (!calleeNode) return null;

  // Case: simple identifier call — drizzle(...)
  if (calleeNode.type === 'identifier') {
    const name = adapter.getNodeText(calleeNode, sourceCode);
    if (name && provenanceMap.has(name)) {
      return provenanceMap.get(name)!;
    }
  }

  // Case: member expression — db.prepare(...)
  if (calleeNode.type === 'member_expression') {
    const receiver = getMemberExpressionReceiver(
      calleeNode, adapter, sourceCode,
    );
    if (receiver && provenanceMap.has(receiver)) {
      return provenanceMap.get(receiver)!;
    }
  }

  return null;
}

/**
 * Split a variable_declarator into its name, value, and type annotation
 * child nodes.
 */
function splitVariableDeclarator(
  node: ASTNode,
  adapter: LanguageAdapter,
): {
  nameNode: ASTNode | null;
  valueNode: ASTNode | null;
  typeAnnotationNode: ASTNode | null;
} {
  const children = adapter.getChildren(node);
  let nameNode: ASTNode | null = null;
  let valueNode: ASTNode | null = null;
  let typeAnnotationNode: ASTNode | null = null;
  let pastEquals = false;

  for (const child of children) {
    if (child.type === '=' || child.type === 'equals') {
      pastEquals = true;
      continue;
    }
    if (child.type === ':') continue;
    if (child.type === 'type_annotation') {
      typeAnnotationNode = child;
      continue;
    }

    if (!pastEquals && !nameNode) {
      // First non-syntax child is the name/pattern
      if (
        child.type === 'identifier' ||
        child.type === 'object_pattern' ||
        child.type === 'array_pattern'
      ) {
        nameNode = child;
      }
    } else if (pastEquals && !valueNode) {
      // First non-syntax child after equals is the value
      if (child.type !== 'type_annotation') {
        valueNode = child;
      }
    } else if (!pastEquals && nameNode && !valueNode) {
      // No '=' child in this grammar (e.g., TypeScript tree-sitter);
      // the expression AFTER the name is the value.
      if (child.type !== 'type_annotation') {
        valueNode = child;
      }
    }
  }

  return { nameNode, valueNode, typeAnnotationNode };
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
 * Extract the "receiver" identifier from a member expression chain.
 * For `db.prepare` → "db"
 * For `this.db.prepare` → "db" (walk to the deepest non-member identifier)
 */
function getMemberExpressionReceiver(
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
      if (
        firstChild.type === 'member_expression' ||
        firstChild.type === 'selector_expression'
      ) {
        // Compound receiver: env.DB.prepare → receiver is "env.DB", not "env".
        // Return the full text of the inner member expression so fallback
        // entries like dbBindingNames: ['env.DB'] match the provenance check.
        return adapter.getNodeText(firstChild, sourceCode);
      }
      if (firstChild.type === 'identifier') {
        return adapter.getNodeText(firstChild, sourceCode);
      }
      // e.g., this.db → member_expression(this, db)
      if (firstChild.type === 'this' || firstChild.type === 'super') {
        // This is a member expression on `this` — check the property side
        // We need to check if `this.X` is provenanced... but `this` itself isn't.
        // For propagation, this means looking at the full chain.
        // For now, return null — this is handled by the caller
        return null;
      }
    }
    break;
  }
  return null;
}

/**
 * Get the callee of a call expression (everything before arguments).
 */
function getCallExpressionCallee(
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
  /** Name lists used in hybrid/names fallback modes */
  dbReceiverNames?: string[];
  dbBindingNames?: string[];
  dbCallMethods?: string[];
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
  const validatorSeeds =
    options.mode !== 'names'
      ? extractValidatorProvenancedImports(ast, adapter)
      : new Map<string, ProvenanceEvidence>();

  // 2. Propagate provenance through assignments
  let dbProvenanced = propagateProvenance(ast, adapter, sourceCode, dbSeeds);
  let validatorProvenanced =
    mode !== 'names'
      ? propagateProvenance(ast, adapter, sourceCode, validatorSeeds)
      : new Map<string, ProvenanceEvidence>();

  // 3. Fallback: in hybrid mode, add identifiers that match name lists
  //    but weren't caught by provenance (R3)
  if (mode === 'hybrid') {
    dbProvenanced = addNameListFallbacks(dbProvenanced, sourceCode, {
      dbReceiverNames: options.dbReceiverNames ?? [],
      dbBindingNames: options.dbBindingNames ?? [],
      dbWrapperNames: options.dbWrapperNames ?? [],
    });
  }

  // 4. In names mode, use ONLY name lists
  if (mode === 'names') {
    dbProvenanced = buildNamesOnlyProvenance(
      sourceCode,
      options.dbReceiverNames ?? [],
      options.dbBindingNames ?? [],
      options.dbWrapperNames ?? [],
    );
  }

  return {
    dbProvenanced,
    validatorProvenanced,
    mode,
  };
}

/**
 * Add fallback provenance entries for identifiers that match name lists
 * but weren't caught by the provenance chain (R3 hybrid mode).
 *
 * These entries carry `reason: 'fallback'` — visible in config detection
 * so users can audit and tighten their chains.
 */
/**
 * Name-list inputs for fallback provenance. Bundles the three configured name
 * lists so the fallback builder takes a single name-lists object rather than
 * three trailing positional arrays.
 */
interface NameLists {
  dbReceiverNames: string[];
  dbBindingNames: string[];
  dbWrapperNames: string[];
}

function addNameListFallbacks(
  provenanceMap: Map<string, ProvenanceEvidence>,
  sourceCode: string,
  nameLists: NameLists,
): Map<string, ProvenanceEvidence> {
  const { dbReceiverNames, dbBindingNames, dbWrapperNames } = nameLists;
  const result = new Map(provenanceMap);

  addIdentifierFallbacks(result, sourceCode, dbReceiverNames, 'dbReceiverNames');
  addBindingFallbacks(result, sourceCode, dbBindingNames);
  addIdentifierFallbacks(result, sourceCode, dbWrapperNames, 'dbWrapperNames');

  return result;
}

/** Add fallback entries for identifiers that appear in source but lack provenance. */
function addIdentifierFallbacks(
  result: Map<string, ProvenanceEvidence>,
  sourceCode: string,
  names: string[],
  label: string,
): void {
  for (const name of names) {
    if (result.has(name)) continue; // already provenanced — provenance wins
    if (identifierAppearsInSource(sourceCode, name)) {
      result.set(name, {
        identifier: name,
        reason: 'fallback',
        source: `name list match: ${label} contains "${name}"`,
        chain: [],
      });
    }
  }
}

/** Add fallback entries for binding names like `env.DB` (plus their short forms). */
function addBindingFallbacks(
  result: Map<string, ProvenanceEvidence>,
  sourceCode: string,
  bindings: string[],
): void {
  for (const binding of bindings) {
    if (!sourceCode.includes(binding)) continue;
    const dotIdx = binding.lastIndexOf('.');
    const shortName = dotIdx >= 0 ? binding.substring(dotIdx + 1) : binding;
    if (!result.has(binding)) {
      result.set(binding, {
        identifier: binding,
        reason: 'fallback',
        source: `name list match: dbBindingNames contains "${binding}"`,
        chain: [],
      });
    }
    if (shortName !== binding && !result.has(shortName)) {
      result.set(shortName, {
        identifier: shortName,
        reason: 'fallback',
        source: `from binding ${binding}`,
        chain: [],
      });
    }
  }
}

/**
 * Build a provenance map using ONLY name lists (for names mode).
 */
function buildNamesOnlyProvenance(
  sourceCode: string,
  dbReceiverNames: string[],
  dbBindingNames: string[],
  dbWrapperNames: string[],
): Map<string, ProvenanceEvidence> {
  return addNameListFallbacks(new Map(), sourceCode, {
    dbReceiverNames,
    dbBindingNames,
    dbWrapperNames,
  });
}

/** Check if an identifier name appears as a standalone identifier in source. */
function identifierAppearsInSource(
  sourceCode: string,
  name: string,
): boolean {
  // Use word boundary matching to avoid partial matches
  const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`);
  return pattern.test(sourceCode);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ═══════════════════════════════════════════════════════════════════════════
// Core detection — is this call DB-provenanced?
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bundled inputs for the DB-provenance decision helpers: the adapter and
 * source needed to read node text, the resolved provenance context, and the
 * (already defaulted) set of DB call methods.  Collapses the five positional
 * parameters the `isDB*` family used to thread through every call into one.
 */
interface DBProvenanceQuery {
  adapter: LanguageAdapter;
  sourceCode: string;
  context: ProvenanceContext;
  methods: ReadonlySet<string>;
}

/**
 * Determine if a call-expression node's callee is DB-provenanced.
 *
 * This replaces the old `isDBCallee()` / `isDbCallNode()` name-based
 * pattern matching in UniversalDataAccessAnalyzer.
 *
 * Checks:
 *   1. Simple identifier call → is the identifier DB-provenanced?
 *   2. Member expression call → is the receiver DB-provenanced AND is the
 *      method in the DB call method set?
 *   3. ORM patterns → receiver is DB-provenanced and method matches ORM API
 *
 * @param node  the call-expression node whose callee is under test
 * @param query  bundled adapter, source, provenance context, and DB methods
 * @returns  true if the call's callee resolves to a DB-provenanced target
 */
export function isDBProvenanced(node: ASTNode, query: DBProvenanceQuery): boolean {
  if (node.type !== 'call_expression') return false;

  const { adapter, sourceCode, context, methods } = query;
  const calleeNode = getCallExpressionCallee(node, adapter);
  if (!calleeNode) return false;

  // Case 1: Simple identifier call — e.g. query(...)
  if (calleeNode.type === 'identifier') {
    const name = adapter.getNodeText(calleeNode, sourceCode);
    if (name !== null && context.dbProvenanced.has(name)) {
      return true;
    }
    // Hybrid fallback: standalone calls to dbCallMethods (query, execute, etc.)
    // qualify as likely DB calls when provenance couldn't resolve the import.
    // This catches patterns like `import { query } from './db'` where './db' is
    // a local re-export of a known package — provenance can't see through it,
    // but the method name is strong evidence.
    if (context.mode === 'hybrid' && name !== null && methods.has(name)) {
      return true;
    }
    return false;
  }

  // Case 2: Member expression — e.g. db.prepare(...)
  if (calleeNode.type === 'member_expression' || calleeNode.type === 'selector_expression') {
    return isMemberExpressionDBProvenanced(calleeNode, query);
  }

  return false;
}

/**
 * Check if a member_expression call is DB-provenanced.
 *
 * Traverses the member chain to find the root receiver,
 * checks if it's in the provenance context, and verifies
 * the method matches the DB call/ORM API.
 */
function isMemberExpressionDBProvenanced(node: ASTNode, query: DBProvenanceQuery): boolean {
  const { adapter, sourceCode, context } = query;
  const rootReceiver = findRootReceiver(node, adapter, sourceCode);
  if (!rootReceiver) return false;

  // In names mode, check the method name directly
  if (context.mode === 'names') {
    return isDBMethodCall(node, query);
  }

  // Check if the root receiver is DB-provenanced.
  // Compound receivers (e.g. "db.users" or "env.DB") need to match both
  // the full text (for bindings like "env.DB") and each sub-identifier
  // (for receivers like "db.users" where "db" is in dbReceiverNames).
  const matchesProvenance = (r: string): boolean => {
    if (context.dbProvenanced.has(r)) return true;
    for (const part of r.split('.')) {
      if (context.dbProvenanced.has(part)) return true;
    }
    return false;
  };

  if (!matchesProvenance(rootReceiver)) {
    if (rootReceiver !== 'this') return false;
    // For `this.xxx`, check if the method chain itself suggests DB usage
    return isDBMethodOnThis(node, query);
  }

  // Check that the method is in the DB call/ORM API
  return isDBMethodCall(node, query);
}

/**
 * Walk a member/selector expression chain to its root receiver text.
 * Returns `'this'` for `this.xxx` chains and `null` when no root is found.
 */
function findRootReceiver(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): string | null {
  let current: ASTNode = node;

  while (current.type === 'member_expression' || current.type === 'selector_expression') {
    const children = adapter.getChildren(current);
    const firstChild = children[0];
    if (!firstChild) break;

    if (firstChild.type === 'identifier') {
      return adapter.getNodeText(firstChild, sourceCode);
    }
    if (firstChild.type === 'member_expression' || firstChild.type === 'selector_expression') {
      // Compound receiver: env.DB.prepare → root is "env.DB", not "env".
      // Returning the full text of the inner member expression ensures
      // fallback entries match (e.g. dbBindingNames: ['env.DB']).
      return adapter.getNodeText(firstChild, sourceCode);
    }
    // this.db.prepare → root is a chain on `this`, check `this.xxx`
    if (firstChild.type === 'this' || firstChild.type === 'super') {
      return 'this';
    }
    break;
  }

  return null;
}

/**
 * Check if a call through a member expression uses a DB method
 * (exec, prepare, all, etc.) or an ORM method (find, insert, etc.).
 */
function isDBMethodCall(node: ASTNode, query: DBProvenanceQuery): boolean {
  const { adapter, sourceCode, methods } = query;
  // Walk the member expression chain and check each property
  let current: ASTNode = node;
  while (
    current.type === 'member_expression' ||
    current.type === 'selector_expression'
  ) {
    const children = current.children ?? [];
    // The property is typically the second or third child
    for (const child of children) {
      if (
        child.type === 'property_identifier' ||
        child.type === 'field_identifier'
      ) {
        const propName = adapter.getNodeText(child, sourceCode);
        const lower = propName.toLowerCase();
        if (methods.has(lower) || ORM_METHODS.has(lower)) {
          return true;
        }
      }
    }
    // Go deeper if there's a nested member/selector expression
    const firstChild = children[0];
    if (
      firstChild?.type === 'member_expression' ||
      firstChild?.type === 'selector_expression'
    ) {
      current = firstChild;
    } else {
      break;
    }
  }
  return false;
}

/**
 * For `this.xxx.method()` calls — check if the method chain suggests
 * DB access. Used when the receiver is `this` (not directly DB-provenanced).
 */
function isDBMethodOnThis(node: ASTNode, query: DBProvenanceQuery): boolean {
  const { adapter, sourceCode, methods } = query;
  // Walk the chain: this.db.prepare → check if any property matches DB methods
  let current: ASTNode = node;
  while (
    current.type === 'member_expression' ||
    current.type === 'selector_expression'
  ) {
    const children = adapter.getChildren(current);
    for (const child of children) {
      if (
        child.type === 'property_identifier' ||
        child.type === 'field_identifier'
      ) {
        const propName = adapter.getNodeText(child, sourceCode);
        const lower = propName.toLowerCase();
        if (methods.has(lower) || ORM_METHODS.has(lower)) {
          return true;
        }
      }
    }
    const firstChild = children[0];
    if (
      firstChild?.type === 'member_expression' ||
      firstChild?.type === 'selector_expression'
    ) {
      current = firstChild;
    } else {
      break;
    }
  }
  return false;
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
  if (!methodName || !DB_CALL_METHODS.has(methodName.toLowerCase())) return;

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
 */
function extractMemberExpressionProperty(
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
