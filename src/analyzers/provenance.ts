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

/** DB call methods — the fixed API surface (language-invariant) */
export const DB_CALL_METHODS: ReadonlySet<string> = new Set([
  'exec',
  'prepare',
  'batch',
  'run',
  'all',
  'first',
  'query',
  'get',
  'each',
  'raw',
  'values',
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
 */
export function propagateProvenance(
  ast: AST,
  adapter: LanguageAdapter,
  sourceCode: string,
  seedMap: Map<string, ProvenanceEvidence>,
): Map<string, ProvenanceEvidence> {
  // Work on a copy so we can add newly-provenanced identifiers during the walk
  const provenanceMap = new Map(seedMap);
  // Keep iterating until no new identifiers are discovered (handles chains)
  let changed = true;
  let iterations = 0;
  const MAX_ITERATIONS = 10; // safety valve for circular references

  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;

    walkAST(ast.root, (node, parent) => {
      // ── Rule 1 & 2 & 3 & 8: variable declarations ──
      if (node.type === 'variable_declarator') {
        const { nameNode, valueNode, typeAnnotationNode } =
          splitVariableDeclarator(node, adapter);

        if (!nameNode) return;

        // Rule 8: type annotation — let x: D1Database
        if (typeAnnotationNode && nameNode.type === 'identifier') {
          const typeText = adapter.getNodeText(typeAnnotationNode, sourceCode).trim();
          if (DB_TYPES.has(typeText)) {
            const name = adapter.getNodeText(nameNode, sourceCode);
            if (!provenanceMap.has(name)) {
              provenanceMap.set(name, {
                identifier: name,
                reason: 'type',
                source: `type annotation ${typeText}`,
                chain: [],
              });
              changed = true;
            }
            // Type-provenanced names count as DB-provenanced for further propagation
          }
        }

        if (valueNode) {
          const propagated = tryPropagateFromExpression(
            valueNode,
            adapter,
            sourceCode,
            provenanceMap,
          );

          if (propagated) {
            // Extract the variable name(s) from the name node
            const varNames = extractPatternNames(nameNode, adapter, sourceCode);
            for (const varName of varNames) {
              if (!provenanceMap.has(varName)) {
                provenanceMap.set(varName, {
                  identifier: varName,
                  reason: 'propagation',
                  source: propagated.source,
                  chain: [...propagated.chain, propagated.identifier],
                });
                changed = true;
              }
            }
          }
        }
        return;
      }

      // ── Rule 6: default parameters ──
      if (
        node.type === 'assignment_pattern' &&
        parent?.type === 'formal_parameters'
      ) {
        const children = adapter.getChildren(node);
        // assignment_pattern has [left, right]
        if (children.length >= 2) {
          const leftNode = children[0];
          const rightNode = children[1];

          if (leftNode.type === 'identifier') {
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
              changed = true;
            }
          }
        }
        return;
      }

      // ── Rule 7: class field initialization ──
      if (
        node.type === 'public_field_definition' ||
        node.type === 'field_definition'
      ) {
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
            changed = true;
          }
        }
        return;
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
    // Walk children before arguments to get the callee
    const calleeNode = getCallExpressionCallee(node, adapter);
    if (calleeNode) {
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
          calleeNode,
          adapter,
          sourceCode,
        );
        if (receiver && provenanceMap.has(receiver)) {
          return provenanceMap.get(receiver)!;
        }
      }
    }
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

  function collect(node: ASTNode): void {
    if (node.type === 'identifier') {
      const name = adapter.getNodeText(node, sourceCode);
      if (name) names.push(name);
    } else if (node.type === 'object_pattern') {
      // Each child is a shorthand_property_identifier, pair_pattern, or rest_pattern
      for (const child of adapter.getChildren(node)) {
        if (
          child.type === '{' ||
          child.type === '}' ||
          child.type === ','
        ) {
          continue;
        }
        if (child.type === 'shorthand_property_identifier') {
          const name = adapter.getNodeText(child, sourceCode);
          if (name) names.push(name);
        } else if (child.type === 'pair_pattern') {
          // pair_pattern children: [property, value]
          // Extract from the value side (which might be an identifier or nested pattern)
          const pairChildren = adapter.getChildren(child);
          if (pairChildren.length >= 2) {
            collect(pairChildren[1]);
          }
        } else if (child.type === 'rest_pattern') {
          collectChildren(child, adapter, sourceCode, names);
        } else {
          collect(child);
        }
      }
    } else if (node.type === 'array_pattern') {
      for (const child of adapter.getChildren(node)) {
        if (child.type === '[' || child.type === ']' || child.type === ',') {
          continue;
        }
        collect(child);
      }
    } else if (node.type === 'assignment_pattern') {
      // Default value in destructuring — collect from the left side
      const children = adapter.getChildren(node);
      if (children.length >= 1) {
        collect(children[0]);
      }
    }
  }

  collect(node);
  return names;
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
  while (current.type === 'member_expression') {
    const children = adapter.getChildren(current);
    const object = children.find(
      (c) => c.type !== '.' && c.type !== 'property_identifier',
    );
    // The object of this member expression should be the first child
    const firstChild = children[0];
    if (
      firstChild &&
      firstChild.type !== '.' &&
      firstChild.type !== 'property_identifier'
    ) {
      if (firstChild.type === 'member_expression') {
        current = firstChild;
        continue;
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
  /** Validator package list override (defaults to VALIDATOR_PACKAGES) */
  validatorPackageList?: string[];
}

/**
 * Build a ProvenanceContext for a file.
 *
 * This is the main entry point — call once per file before analysis.
 * Combines import extraction, propagation, and mode-based fallback.
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
    dbProvenanced = addNameListFallbacks(
      dbProvenanced,
      sourceCode,
      options.dbReceiverNames ?? [],
      options.dbBindingNames ?? [],
    );
  }

  // 4. In names mode, use ONLY name lists
  if (mode === 'names') {
    dbProvenanced = buildNamesOnlyProvenance(
      sourceCode,
      options.dbReceiverNames ?? [],
      options.dbBindingNames ?? [],
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
function addNameListFallbacks(
  provenanceMap: Map<string, ProvenanceEvidence>,
  sourceCode: string,
  dbReceiverNames: string[],
  dbBindingNames: string[],
): Map<string, ProvenanceEvidence> {
  const result = new Map(provenanceMap);

  // Scan for DB receiver names used as identifiers
  for (const name of dbReceiverNames) {
    if (result.has(name)) continue; // already provenanced — provenance wins
    // Check if this name appears as an identifier in the source
    if (identifierAppearsInSource(sourceCode, name)) {
      result.set(name, {
        identifier: name,
        reason: 'fallback',
        source: `name list match: dbReceiverNames contains "${name}"`,
        chain: [],
      });
    }
  }

  // Scan for binding names like env.DB
  for (const binding of dbBindingNames) {
    if (sourceCode.includes(binding)) {
      // Extract the property after the dot, e.g. "DB" from "env.DB"
      const dotIdx = binding.lastIndexOf('.');
      const shortName = dotIdx >= 0 ? binding.substring(dotIdx + 1) : binding;
      // Also add the full binding path
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

  return result;
}

/**
 * Build a provenance map using ONLY name lists (for names mode).
 */
function buildNamesOnlyProvenance(
  sourceCode: string,
  dbReceiverNames: string[],
  dbBindingNames: string[],
): Map<string, ProvenanceEvidence> {
  return addNameListFallbacks(
    new Map(),
    sourceCode,
    dbReceiverNames,
    dbBindingNames,
  );
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
 */
export function isDBProvenanced(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  context: ProvenanceContext,
  dbCallMethods?: ReadonlySet<string>,
): boolean {
  if (node.type !== 'call_expression') return false;

  const methods = dbCallMethods ?? DB_CALL_METHODS;
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
  if (calleeNode.type === 'member_expression') {
    return isMemberExpressionDBProvenanced(
      calleeNode,
      adapter,
      sourceCode,
      context,
      methods,
    );
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
function isMemberExpressionDBProvenanced(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  context: ProvenanceContext,
  methods: ReadonlySet<string>,
): boolean {
  // Walk the member expression chain to find the root
  let rootReceiver: string | null = null;
  let current: ASTNode = node;

  while (current.type === 'member_expression') {
    const children = adapter.getChildren(current);
    const firstChild = children[0];
    if (!firstChild) break;

    if (firstChild.type === 'identifier') {
      rootReceiver = adapter.getNodeText(firstChild, sourceCode);
      break;
    }
    if (firstChild.type === 'member_expression') {
      current = firstChild;
      continue;
    }
    // this.db.prepare → root is a chain on `this`, check `this.xxx`
    if (firstChild.type === 'this' || firstChild.type === 'super') {
      rootReceiver = 'this';
      break;
    }
    break;
  }

  if (!rootReceiver) return false;

  // In names mode, check the method name directly
  if (context.mode === 'names') {
    return isDBMethodCall(node, adapter, sourceCode, context, methods);
  }

  // Check if the root receiver is DB-provenanced
  if (!context.dbProvenanced.has(rootReceiver)) {
    if (rootReceiver !== 'this') return false;
    // For `this.xxx`, check if the method chain itself suggests DB usage
    return isDBMethodOnThis(node, adapter, sourceCode, context, methods);
  }

  // Check that the method is in the DB call/ORM API
  return isDBMethodCall(node, adapter, sourceCode, context, methods);
}

/**
 * Check if a call through a member expression uses a DB method
 * (exec, prepare, all, etc.) or an ORM method (find, insert, etc.).
 */
function isDBMethodCall(
  node: ASTNode,
  _adapter: LanguageAdapter,
  _sourceCode: string,
  _context: ProvenanceContext,
  methods: ReadonlySet<string>,
): boolean {
  // Walk the member expression chain and check each property
  let current: ASTNode = node;
  while (current.type === 'member_expression') {
    const children = current.children ?? [];
    // The property is typically the second or third child
    for (const child of children) {
      if (child.type === 'property_identifier') {
        const propName = child.type === 'property_identifier'
          ? _adapter.getNodeText(child, _sourceCode)
          : null;
        if (propName && (methods.has(propName) || ORM_METHODS.has(propName))) {
          return true;
        }
      }
    }
    // Go deeper if there's a nested member expression
    const firstChild = children[0];
    if (firstChild?.type === 'member_expression') {
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
function isDBMethodOnThis(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
  _context: ProvenanceContext,
  methods: ReadonlySet<string>,
): boolean {
  // Walk the chain: this.db.prepare → check if any property matches DB methods
  let current: ASTNode = node;
  while (current.type === 'member_expression') {
    const children = adapter.getChildren(current);
    for (const child of children) {
      if (child.type === 'property_identifier') {
        const propName = adapter.getNodeText(child, sourceCode);
        if (propName && (methods.has(propName) || ORM_METHODS.has(propName))) {
          return true;
        }
      }
    }
    const firstChild = children[0];
    if (firstChild?.type === 'member_expression') {
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

  // Step 2: Walk all call expressions whose callee is a member expression
  walkAST(fileAst.root, (node) => {
    if (node.type !== 'call_expression') return;

    const callee = getCallExpressionCallee(node, adapter);
    if (!callee || callee.type !== 'member_expression') return;

    // Extract method name (the property being called)
    const methodName = extractMemberExpressionProperty(
      callee,
      adapter,
      sourceCode,
    );
    if (!methodName || !DB_CALL_METHODS.has(methodName)) return;

    // Get the receiver identifier
    const receiver = getMemberExpressionReceiver(callee, adapter, sourceCode);
    if (!receiver) return;

    // Already in the provenanced set → skip (already first-class, not inferred)
    if (provenancedSet.has(receiver)) return;

    // Already added to inferred
    if (seen.has(receiver)) return;

    // Step 3: Trace receiver through assignment chain to see if it reaches
    // a provenanced source
    const traced = traceAssignmentChain(
      receiver,
      assignmentGraph,
      provenancedSet,
    );

    if (traced.found) {
      seen.add(receiver);
      inferred.identifiers.push(receiver);
      inferred.evidence.push({
        identifier: receiver,
        reason: `calls .${methodName}() traced to ${traced.chains[0]} — ${traced.reason}`,
      });
    }
  });

  return inferred;
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
  const graph = new Map<string, string>();

  walkAST(ast.root, (node, parent) => {
    // const/let/var x = <expr>
    if (node.type === 'variable_declarator') {
      const { nameNode, valueNode } = splitVariableDeclarator(node, adapter);
      if (nameNode && valueNode) {
        const names = extractPatternNames(nameNode, adapter, sourceCode);
        const valueText = adapter.getNodeText(valueNode, sourceCode);
        for (const name of names) {
          if (!graph.has(name)) graph.set(name, valueText);
        }
      }
      return;
    }

    // Parameter defaults: function foo(x = <expr>)
    if (
      node.type === 'assignment_pattern' &&
      parent?.type === 'formal_parameters'
    ) {
      const children = adapter.getChildren(node);
      if (children.length >= 2) {
        const leftNode = children[0];
        const rightNode = children[1];
        if (leftNode.type === 'identifier') {
          const paramName = adapter.getNodeText(leftNode, sourceCode);
          const valueText = adapter.getNodeText(rightNode, sourceCode);
          if (!graph.has(paramName)) graph.set(paramName, valueText);
        }
      }
      return;
    }

    // Class field: fieldName = <expr>
    if (
      node.type === 'public_field_definition' ||
      node.type === 'field_definition'
    ) {
      const children = adapter.getChildren(node);
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
          c.type !== 'abstract' &&
          c.type !== '=',
      );
      if (nameChild && valueChild) {
        const fieldName = adapter.getNodeText(nameChild, sourceCode);
        const valueText = adapter.getNodeText(valueChild, sourceCode);
        if (!graph.has(fieldName)) graph.set(fieldName, valueText);
      }
      return;
    }
  });

  return graph;
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

    // Also check if any identifier in the initializer text matches a provenanced source
    const initText = assignmentGraph.get(current);
    if (initText) {
      // Extract identifiers from the initializer text and check against provenanced set
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

    // Move to the next link in the chain
    if (!initText || visited.has(initText)) break;
    visited.add(initText);

    // Try to find a next identifier to trace
    const idents = extractTopLevelIdentifiers(initText);
    let foundNext = false;
    for (const ident of idents) {
      if (assignmentGraph.has(ident) && !visited.has(ident)) {
        chain.push(ident);
        current = ident;
        foundNext = true;
        break;
      }
    }
    if (!foundNext) break;
    depth++;
  }

  return { found: false, chains: [], reason: '' };
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
    if (child.type === 'property_identifier') {
      return adapter.getNodeText(child, sourceCode);
    }
  }
  return null;
}
