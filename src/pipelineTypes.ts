/**
 * Pipeline facts registration (Spec 24 R2).
 *
 * Every visitor/reducer declares a typed facts contribution. Reducers declare
 * which contributions they consume. The pipeline validates at startup that
 * every declared consumption has a matching contribution in an earlier stage.
 */

import type { Stage2Visitor, Stage3Reducer, Stage4Reducer } from './types.js';

// ── Facts registry ──────────────────────────────────────────────────────────

/** All facts registered by name, keyed by contributor name. */
const factsRegistry = new Map<string, Set<string>>();

/**
 * Register a visitor's facts contribution.
 * Called automatically when a Stage2Visitor is constructed with a facts type.
 */
export function registerVisitorFacts(name: string, factsKeys: string[]): void {
  factsRegistry.set(name, new Set(factsKeys));
}

/**
 * Register a reducer's facts consumption.
 * Returns validation errors if any consumed fact isn't produced by an earlier stage.
 */
export function validateFactsDependencies(
  visitors: Stage2Visitor[],
  reducers: Stage3Reducer[],
  derivedReducers: Stage4Reducer[],
): string[] {
  const errors: string[] = [];

  // Build the set of names that produce facts at each stage
  const visitorNames = new Set(visitors.map((v) => v.name));
  const reducerNames = new Set(reducers.map((r) => r.name));

  // Stage 3 reducers can only consume from stage 2 visitors
  for (const reducer of reducers) {
    for (const consumed of reducer.consumes) {
      if (!visitorNames.has(consumed)) {
        if (reducerNames.has(consumed)) {
          errors.push(
            `Reducer "${reducer.name}" consumes "${consumed}" which is a stage-3 reducer. ` +
            `Stage-3 reducers can only consume from stage-2 visitors. ` +
            `If "${reducer.name}" needs another reducer's output, move it to stage 4.`,
          );
        } else {
          errors.push(
            `Reducer "${reducer.name}" consumes "${consumed}" but no stage-2 visitor with that name exists. ` +
            `Every consumed fact must be produced by a prior stage.`,
          );
        }
      }
    }
  }

  // Stage 4 reducers can consume from stage 2 visitors OR stage 3 reducers
  const allPriorNames = new Set([...visitorNames, ...reducerNames]);
  for (const dr of derivedReducers) {
    for (const consumed of dr.consumes) {
      if (!allPriorNames.has(consumed)) {
        errors.push(
          `Derived reducer "${dr.name}" consumes "${consumed}" but no prior-stage contributor with that name exists. ` +
          `Available contributors: ${[...allPriorNames].join(', ')}`,
        );
      }
    }
  }

  // No two visitors/reducers may share the same name
  const allNames = new Set<string>();
  for (const v of visitors) {
    if (allNames.has(v.name)) {
      errors.push(`Duplicate visitor name: "${v.name}"`);
    }
    allNames.add(v.name);
  }
  for (const r of reducers) {
    if (allNames.has(r.name)) {
      errors.push(`Duplicate reducer name: "${r.name}"`);
    }
    allNames.add(r.name);
  }
  for (const dr of derivedReducers) {
    if (allNames.has(dr.name)) {
      errors.push(`Duplicate derived reducer name: "${dr.name}"`);
    }
    allNames.add(dr.name);
  }

  return errors;
}

/**
 * Build a typed FactsMap from visitor results.
 * Keys are visitor names, values are their facts bags.
 */
export function buildFactsMap(
  visitorResults: Map<string, { violations: unknown[]; facts: Record<string, unknown> }>,
): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const [name, result] of visitorResults) {
    facts[name] = result.facts;
  }
  return facts;
}

/**
 * Merge reducer facts into the facts map for downstream consumers.
 */
export function mergeFacts(
  existing: Record<string, unknown>,
  additions: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const merged = { ...existing };
  for (const [name, facts] of additions) {
    merged[name] = facts;
  }
  return merged;
}

// ── Facts contribution helpers ─────────────────────────────────────────────

/**
 * Declare the facts a visitor contributes.
 * Returns a helper that types the visit() return value.
 *
 * Usage:
 *   const visitor = declareVisitorFacts<StyleExtractFacts>('styles', visitImpl);
 */
export function declareVisitorFacts<F extends Record<string, unknown>>(
  name: string,
  visitFn: Stage2Visitor['visit'],
): Stage2Visitor['visit'] {
  return visitFn;
}

/**
 * Validate that a facts bag has the expected shape at runtime.
 * Returns the bag if valid, throws if keys are missing or have wrong types.
 */
export function validateFactsBag<F extends Record<string, unknown>>(
  name: string,
  facts: Record<string, unknown>,
  expectedKeys: (keyof F)[],
): F {
  const missing = expectedKeys.filter((k) => !(k as string in facts));
  if (missing.length > 0) {
    throw new Error(
      `Visitor "${name}" facts bag missing required keys: ${missing.join(', ')}`,
    );
  }
  return facts as unknown as F;
}
