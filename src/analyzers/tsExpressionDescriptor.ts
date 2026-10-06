/**
 * TS within-file-provenance split — the classify arm + the serializable descriptor
 * (Spec 70 Item 4 / Item 3).
 *
 * `computeTsWithinFileProvenance` (receiverResolution.ts) reaches a fixed point
 * over a file's AST: package-import seeds → propagation → wrapper classes →
 * DB-returning functions, ≤10 passes. The phase model's collapse of the
 * double-parse needs that same result *without* a second parse, so the work is
 * split the way Go already splits it (`buildGoBindingEnv` = extract,
 * `classifyGoBindings` = classify):
 *
 *   • extract  — `extractTsWithinFileProvenance` (provenance.ts, where the AST
 *                walkers live) projects everything the fixed point reads into a
 *                serializable {@link TsWithinFileProvenanceExtract}.
 *   • classify — this module re-runs the fixed point over the projection, with no
 *                AST, no adapter, and no source text.
 *
 * The two are pinned byte-identical by `spec70-ts-within-file-parity.spec.ts`:
 * `classifyTsWithinFileProvenance(extractTsWithinFileProvenance(ast, …))` must
 * equal `computeTsWithinFileProvenance(ast, …)` for every fixture.
 *
 * The descriptor is a **closed set** — five structured shapes plus an `unproven`
 * residue — not a general expression serializer. It projects exactly the shapes
 * `tryPropagateFromExpression` / `tryCallProvenance` / `delegatesToProvenanced`
 * dispatch on, and nothing else.
 */

import { classifyRootIdentifier, type Binding, type RootResolutionEnv } from './receiverRoot.js';
import type { ProvenanceEvidence } from './provenance.js';

// ═══════════════════════════════════════════════════════════════════════════
// The descriptor (closed set)
// ═══════════════════════════════════════════════════════════════════════════

export type TsExpressionDescriptor =
  | { readonly kind: 'await'; readonly operand: TsExpressionDescriptor | null }
  | { readonly kind: 'new'; readonly ctorName: string | null }
  | { readonly kind: 'call'; readonly callee: TsExpressionDescriptor | null; readonly args: readonly TsExpressionDescriptor[] }
  | { readonly kind: 'identifier'; readonly name: string }
  | {
      readonly kind: 'member';
      readonly receiver: TsExpressionDescriptor | null;
      readonly property: string | null;
      /**
       * Full source text of this member node (`getNodeText`). `getMemberExpressionReceiver`
       * returns the *full text* of a compound receiver (`env.DB` → "env.DB", `this.db` →
       * "this.db"), and that text cannot be reconstructed from the structural chain once
       * `this`/`super` collapse to `unproven` — so it is folded here, provenance-free,
       * exactly like `isD1Rest` and `new.ctorName`.
       */
      readonly text: string;
    }
  | { readonly kind: 'unproven' }; // residue — literal/object/array/this/super/anything

// ─── Compile-time residue check ──────────────────────────────────────────────
//
// The descriptor is closed. `Exclude<kind, _HandledDescriptorKind>` is `'unproven'`
// only when every *structured* shape has a classify arm; the `const … = true`
// assignment fails the build the moment a structured kind is added to the union
// without one. Same idiom as `handleIdentification.ts` / `phase/seeded-defects.ts`.

type _HandledDescriptorKind = 'await' | 'new' | 'call' | 'identifier' | 'member';
type _UnhandledDescriptorKind = Exclude<TsExpressionDescriptor['kind'], _HandledDescriptorKind>;
const _residueIsOnlyUnproven: _UnhandledDescriptorKind extends 'unproven' ? true : never = true;

// @ts-expect-error — a structured kind lacking a classify arm would widen this to a non-never type
const _missingDescriptorArm: Exclude<_UnhandledDescriptorKind, 'unproven'> = 'unproven';

// ═══════════════════════════════════════════════════════════════════════════
// The extract projection
// ═══════════════════════════════════════════════════════════════════════════

/** A single-file propagation rule, projected in AST pre-order. */
export type PropagationRule =
  | { readonly kind: 'variable-declarator'; readonly names: readonly string[]; readonly value: TsExpressionDescriptor | null }
  | { readonly kind: 'default-parameter'; readonly name: string; readonly value: TsExpressionDescriptor }
  | { readonly kind: 'class-field'; readonly field: string; readonly value: TsExpressionDescriptor }
  | { readonly kind: 'member-assignment'; readonly field: string; readonly value: TsExpressionDescriptor };

/** One call inside a wrapper function's own body (nested functions excluded). */
export interface OwnCall {
  readonly callee: TsExpressionDescriptor | null;
  /** `isD1RestCall` folded at extract — provenance-free, so it is precomputed. */
  readonly isD1Rest: boolean;
}

/** One `new`/call expression inside a wrapper class body (nested classes/functions excluded). */
export type ClassCall =
  | { readonly kind: 'new'; readonly ctorName: string | null }
  | { readonly kind: 'call'; readonly callee: TsExpressionDescriptor | null; readonly isD1Rest: boolean };

export interface TsWithinFileProvenanceExtract {
  /** `extractDBProvenancedImports` — the DB-package import seeds. */
  readonly seeds: ReadonlyMap<string, ProvenanceEvidence>;
  /**
   * `buildBindingEnv` — the file's binding environment, projected at extract time
   * so the classify arm can run the package discriminant (`classifyRootIdentifier`)
   * over a receiver root's declaration with no AST. Carried whole rather than
   * reconstructed: `buildBindingEnv` already serializes every binding as a
   * `Binding`/`ValueDescriptor`, so re-deriving it from the propagation rules would
   * be a lossy replica.
   */
  readonly bindings: ReadonlyMap<string, Binding>;
  /** `collectLocalFunctionNames` — S5f refuses to forward through these. */
  readonly localFunctions: ReadonlySet<string>;
  /** The propagation rules, in `walkAST` pre-order. */
  readonly propagationRules: readonly PropagationRule[];
  /** Wrapper-function names + their own-call projections, in `findNodes` pre-order. */
  readonly wrapperFunctions: readonly { readonly name: string; readonly ownCalls: readonly OwnCall[] }[];
  /** Wrapper-class names + their class-call projections, in `findNodes` pre-order. */
  readonly wrapperClasses: readonly { readonly name: string; readonly classCalls: readonly ClassCall[] }[];
  /** Function names + their return-expression projections, in `findNodes` pre-order. */
  readonly returningFunctions: readonly { readonly name: string; readonly returnExprs: readonly TsExpressionDescriptor[] }[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Classify helpers — descriptor mirrors of the provenance.ts node walkers
// ═══════════════════════════════════════════════════════════════════════════

/** Mirror of `lookupEvidence`: evidence for `name`, or null when empty/unprovenanced. */
function lookupEvidence(
  provenanceMap: ReadonlyMap<string, ProvenanceEvidence>,
  name: string | null,
): ProvenanceEvidence | null {
  if (name && provenanceMap.has(name)) return provenanceMap.get(name)!;
  return null;
}

/**
 * Mirror of `resolveReceiverText` (the `getMemberExpressionReceiver` descent). A
 * bare identifier yields its name; a member yields its full source text (no further
 * descent — `getNodeText` of the object); a call descends into its callee; anything
 * else (`this`/`super`/literal — all `unproven` here) yields null.
 */
function resolveReceiverRootText(desc: TsExpressionDescriptor | null): string | null {
  if (!desc) return null;
  switch (desc.kind) {
    case 'identifier':
      return desc.name;
    case 'member':
      return desc.text;
    case 'call':
      return resolveReceiverRootText(desc.callee);
    default:
      return null;
  }
}

/**
 * Mirror of `resolveReceiverRoot`: resolve a member/call/identifier descriptor to
 * its leftmost root identifier, descending through builder-chain calls and
 * `this`/`super` first-segments. A `this`/`super` object collapses to `unproven`
 * in the descriptor, so it is recovered from the member's folded `text` — the
 * property after `this.`/`super.` is the same first segment `resolveReceiverRoot`
 * returns. A literal receiver resolves to null, matching the source.
 */
function resolveDescriptorRoot(desc: TsExpressionDescriptor | null): string | null {
  if (!desc) return null;
  switch (desc.kind) {
    case 'identifier':
      return desc.name;
    case 'member':
      if (desc.receiver?.kind === 'unproven') {
        const text = desc.text ?? '';
        if ((text.startsWith('this.') || text.startsWith('super.')) && desc.property) {
          return desc.property;
        }
        return null; // a literal receiver — not an identifier root
      }
      return resolveDescriptorRoot(desc.receiver);
    case 'call':
      return resolveDescriptorRoot(desc.callee);
    case 'await':
      return desc.operand ? resolveDescriptorRoot(desc.operand) : null;
    default:
      return null;
  }
}

/**
 * Mirror of `delegatesToProvenanced`: a call delegates when its callee is a
 * provenanced identifier, or a member whose receiver (full text or any dotted
 * segment) is provenanced *and* whose root's declaration is DB-shaped. The root
 * disposition comes from `classifyRootIdentifier` with an empty provenance env, so
 * the receiver's own declaration (a JS global / primitive / literal → not-handle)
 * is consulted rather than its propagated provenance — `join` is
 * `Array.prototype.join` and also `SQL JOIN`, so the method name cannot decide.
 */
function delegatesToProvenanced(
  callee: TsExpressionDescriptor | null,
  provenanceMap: ReadonlyMap<string, ProvenanceEvidence>,
  bindings: ReadonlyMap<string, Binding>,
): boolean {
  if (!callee) return false;

  if (callee.kind === 'identifier') {
    return provenanceMap.has(callee.name);
  }

  if (callee.kind === 'member') {
    const receiver = resolveReceiverRootText(callee.receiver);
    if (!receiver) return false;
    const receiverProvenanced =
      provenanceMap.has(receiver) ||
      // Compound receivers ("env.DB", "db.users") — match any dotted segment.
      receiver.split('.').some((part) => provenanceMap.has(part));
    if (!receiverProvenanced) return false;
    const root = resolveDescriptorRoot(callee);
    if (root === null) return false;
    const env = {
      provenance: new Map(),
      bindings,
      adapter: undefined,
      sourceCode: '',
    } as unknown as RootResolutionEnv;
    return classifyRootIdentifier(root, env) !== 'not-handle';
  }

  return false;
}

/** Mirror of `tryProvenancedArgument` (S5f — higher-order wrapper forwards a handle). */
function classifyProvenancedArgument(
  args: readonly TsExpressionDescriptor[],
  provenanceMap: ReadonlyMap<string, ProvenanceEvidence>,
  localFunctions: ReadonlySet<string> | undefined,
  calleeName: string,
): ProvenanceEvidence | null {
  if (localFunctions && calleeName && localFunctions.has(calleeName)) return null;

  for (const arg of args) {
    const evidence = classifyTsExpression(arg, provenanceMap, localFunctions);
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

/** Mirror of `tryCallProvenance` (rules 2/3 + S5f). */
function classifyCall(
  desc: Extract<TsExpressionDescriptor, { kind: 'call' }>,
  provenanceMap: ReadonlyMap<string, ProvenanceEvidence>,
  localFunctions: ReadonlySet<string> | undefined,
): ProvenanceEvidence | null {
  const callee = desc.callee;
  if (!callee) return null;

  if (callee.kind === 'identifier') {
    const evidence = lookupEvidence(provenanceMap, callee.name);
    if (evidence) return evidence;
    const argEvidence = classifyProvenancedArgument(desc.args, provenanceMap, localFunctions, callee.name);
    if (argEvidence) return argEvidence;
  }

  if (callee.kind === 'member') {
    const receiver = resolveReceiverRootText(callee.receiver);
    const evidence = lookupEvidence(provenanceMap, receiver);
    if (evidence) return evidence;
  }

  return null;
}

/**
 * Mirror of `tryPropagateFromExpression` over the descriptor. Returns the
 * DB-provenanced evidence the expression names, or null when it names none.
 */
function classifyTsExpression(
  desc: TsExpressionDescriptor,
  provenanceMap: ReadonlyMap<string, ProvenanceEvidence>,
  localFunctions: ReadonlySet<string> | undefined,
): ProvenanceEvidence | null {
  switch (desc.kind) {
    case 'await':
      return desc.operand ? classifyTsExpression(desc.operand, provenanceMap, localFunctions) : null;
    case 'new':
      return lookupEvidence(provenanceMap, desc.ctorName);
    case 'call':
      return classifyCall(desc, provenanceMap, localFunctions);
    case 'identifier':
      return lookupEvidence(provenanceMap, desc.name);
    case 'member':
      return lookupEvidence(provenanceMap, resolveReceiverRootText(desc.receiver));
    case 'unproven':
      return null;
  }
}

/** Mirror of `applyPropagationRule` over one projected rule. */
function classifyPropagationRule(
  rule: PropagationRule,
  provenanceMap: Map<string, ProvenanceEvidence>,
  localFunctions: ReadonlySet<string>,
): boolean {
  switch (rule.kind) {
    case 'variable-declarator': {
      if (!rule.value) return false;
      const propagated = classifyTsExpression(rule.value, provenanceMap, localFunctions);
      if (!propagated) return false;
      let mutated = false;
      for (const varName of rule.names) {
        if (!provenanceMap.has(varName)) {
          provenanceMap.set(varName, {
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
    case 'default-parameter': {
      const propagated = classifyTsExpression(rule.value, provenanceMap, localFunctions);
      if (propagated && !provenanceMap.has(rule.name)) {
        provenanceMap.set(rule.name, {
          identifier: rule.name,
          reason: 'propagation',
          source: `default parameter = ${propagated.source}`,
          chain: [...propagated.chain, propagated.identifier],
          packageName: propagated.packageName,
        });
        return true;
      }
      return false;
    }
    case 'class-field': {
      const propagated = classifyTsExpression(rule.value, provenanceMap, localFunctions);
      if (propagated && !provenanceMap.has(rule.field)) {
        provenanceMap.set(rule.field, {
          identifier: rule.field,
          reason: 'propagation',
          source: `class field initialized from ${propagated.source}`,
          chain: [...propagated.chain, propagated.identifier],
          packageName: propagated.packageName,
        });
        return true;
      }
      return false;
    }
    case 'member-assignment': {
      const propagated = classifyTsExpression(rule.value, provenanceMap, localFunctions);
      if (propagated && !provenanceMap.has(rule.field)) {
        provenanceMap.set(rule.field, {
          identifier: rule.field,
          reason: 'propagation',
          source: `this.${rule.field} assigned from ${propagated.source}`,
          chain: [...propagated.chain, propagated.identifier],
          packageName: propagated.packageName,
        });
        return true;
      }
      return false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The fixed point (classify)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mirror of `propagateProvenance` over the projection's rule list.
 * @param extract - The provenance-free within-file projection (rules + seeds).
 * @param provenanceMap - The starting provenance map to propagate into.
 * @returns The map after the propagation rules reach a fixed point.
 */
export function propagateProvenanceFromExtract(
  extract: TsWithinFileProvenanceExtract,
  provenanceMap: ReadonlyMap<string, ProvenanceEvidence>,
): Map<string, ProvenanceEvidence> {
  const map = new Map(provenanceMap);
  const localFunctions = extract.localFunctions;
  let changed = true;
  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;
    for (const rule of extract.propagationRules) {
      if (classifyPropagationRule(rule, map, localFunctions)) changed = true;
    }
  }

  return map;
}

/** Mirror of `detectDbWrappers` (functions then classes) over the projection. */
function detectDbWrappersFromExtract(
  extract: TsWithinFileProvenanceExtract,
  provenanceMap: Map<string, ProvenanceEvidence>,
): Map<string, ProvenanceEvidence> {
  detectDbWrapperFunctionsFromExtract(extract, provenanceMap);

  for (const cls of extract.wrapperClasses) {
    if (provenanceMap.has(cls.name)) continue;
    const isWrapper = cls.classCalls.some((cc) => {
      if (cc.kind === 'new') {
        return cc.ctorName !== null && provenanceMap.has(cc.ctorName);
      }
      return cc.isD1Rest || delegatesToProvenanced(cc.callee, provenanceMap, extract.bindings);
    });
    if (isWrapper) {
      provenanceMap.set(cls.name, {
        identifier: cls.name,
        reason: 'wrapper',
        source: 'class body constructs or calls a DB driver',
        chain: [],
      });
    }
  }

  return provenanceMap;
}

/**
 * Mirror of `detectDbWrappers`' *function* arm over the projection — the exact
 * step `buildProvenanceContext` runs (functions only, no classes). The build-side
 * provenance the four receiver consumers read stops at function wrappers; the
 * classify-side fixed point (`classifyTsWithinFileProvenance`) additionally scans
 * classes and returning functions, so the two need distinct mirrors.
 * @param extract - The provenance-free within-file projection (wrapper functions).
 * @param provenanceMap - The provenance map to fold wrapper names into.
 * @returns The map with any function wrappers marked provenanced.
 */
export function detectDbWrapperFunctionsFromExtract(
  extract: TsWithinFileProvenanceExtract,
  provenanceMap: Map<string, ProvenanceEvidence>,
): Map<string, ProvenanceEvidence> {
  for (const fn of extract.wrapperFunctions) {
    if (provenanceMap.has(fn.name)) continue;
    const isWrapper = fn.ownCalls.some(
      (call) => call.isD1Rest || delegatesToProvenanced(call.callee, provenanceMap, extract.bindings),
    );
    if (isWrapper) {
      provenanceMap.set(fn.name, {
        identifier: fn.name,
        reason: 'wrapper',
        source: 'function body performs a DB operation',
        chain: [],
      });
    }
  }
  return provenanceMap;
}

/** Mirror of `detectDbReturningFunctions` over the projection. */
function detectDbReturningFunctionsFromExtract(
  extract: TsWithinFileProvenanceExtract,
  provenanceMap: Map<string, ProvenanceEvidence>,
): Map<string, ProvenanceEvidence> {
  for (const fn of extract.returningFunctions) {
    if (provenanceMap.has(fn.name)) continue;
    // `functionReturnsProvenanced` calls `tryPropagateFromExpression` with NO
    // localFunctions argument, so S5f's local-function guard is absent here.
    const returnsProvenanced = fn.returnExprs.some(
      (expr) => classifyTsExpression(expr, provenanceMap, undefined) !== null,
    );
    if (returnsProvenanced) {
      provenanceMap.set(fn.name, {
        identifier: fn.name,
        reason: 'propagation',
        source: 'returns a DB-provenanced construction',
        chain: [],
      });
    }
  }
  return provenanceMap;
}

/**
 * Re-run `computeTsWithinFileProvenance`'s fixed point over a serializable
 * projection, with no AST. `classifyTsWithinFileProvenance(
 * extractTsWithinFileProvenance(ast, …), extraSeeds)` must equal
 * `computeTsWithinFileProvenance(ast, …, extraSeeds)` — pinned by the parity spec.
 * @param extract - The provenance-free within-file projection to classify.
 * @param extraSeeds - Additional cross-file provenanced names to seed the map with.
 * @returns The file's provenance map after the fixed point converges.
 */
export function classifyTsWithinFileProvenance(
  extract: TsWithinFileProvenanceExtract,
  extraSeeds: ReadonlyMap<string, ProvenanceEvidence> = new Map(),
): Map<string, ProvenanceEvidence> {
  const seeds = new Map(extract.seeds);
  for (const [name, evidence] of extraSeeds) {
    if (!seeds.has(name)) seeds.set(name, evidence);
  }

  let prov = new Map(seeds);
  const MAX_PASSES = 10;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const before = prov.size;
    prov = propagateProvenanceFromExtract(extract, prov);
    prov = detectDbWrappersFromExtract(extract, prov);
    prov = detectDbReturningFunctionsFromExtract(extract, prov);
    if (prov.size === before) break;
  }
  return prov;
}
