/**
 * Handle identification — the seam.
 *
 * Standing correction `specs/correction-seams-not-placement.md`: one concept,
 * one seam, declared as a type, with a compile-time residue check. Handle
 * identification ("is this receiver a DB handle?") is answered by exactly one
 * entry point built from two walk-time evidence sources. A third source —
 * `external-classifier` — re-disposes `unproven` sites after the audit from a
 * separate `classify` command, never from the walk. No rule and no processor
 * decides handle-ness any other way.
 *
 * ─── Shape ───
 *
 *   combineVerdicts(EVIDENCE_SOURCES.map(s => s.evaluate(site, facts)))
 *
 * Two walk-time evidence sources, registered against `WalkTimeEvidenceSourceId`:
 *
 *   - `sql-argument`            — the call's argument is literally SQL, so the
 *                                 receiver must be a DB handle. Can only prove
 *                                 `handle` or stay silent (`unproven`) — the
 *                                 narrowing is compile-enforced on `evaluate`.
 *   - `declaration-resolution`  — the receiver's declaration resolves to a DB
 *                                 handle (package import, type annotation, or
 *                                 binding). The only source that can prove
 *                                 `not-handle`, so `not-handle.via` is narrowed
 *                                 to it in the type.
 *
 * `external-classifier` is a third `via` value (a full member of
 * `EvidenceSourceId`) reserved for post-audit attribution: its implementation is
 * *not* in `EVIDENCE_SOURCES` and is *not* called from `identifyHandle` or
 * anything downstream, so the walk stays synchronous. The `classify` command
 * folds its verdict through `combineVerdicts` with the same invariant.
 *
 * `declaration-resolution` is itself a nested seam: one `ResolutionImplementation`
 * per `Format`, registered against `RESOLUTION_IMPLEMENTATIONS`. A caller asks the
 * interface and never learns which implementation answered — no caller names a
 * format, and no format name appears above an implementation's own module.
 */

import type { Format } from '../phase/types.js';
import type { Dialect } from '../mcp-tools/discoveryQueries.js';
import type { AST, LanguageAdapter } from '../languages/types.js';
import { classifyRootIdentifier, deriveMemberPath, deriveThisMemberPath, type RootResolutionEnv } from './receiverRoot.js';
import {
  classifyGoRootIdentifier,
  buildGoImportMap,
  buildGoBindingEnv,
  classifyGoBindings,
  describeGoUnprovenCause,
  type GoResolutionEnv,
  type GoBinding,
} from '../languages/go/goResolution.js';
import { parseSql, DEFAULT_SQL_DIALECT } from '../languages/sql/sqlAst.js';
import { extractTsWithinFileProvenance, type ProvenanceEvidence } from './provenance.js';
import { classifyTsWithinFileProvenance, type TsWithinFileProvenanceExtract } from './tsExpressionDescriptor.js';

// ─── Verdict ─────────────────────────────────────────────────────────────────

/**
 * The three ways handle-ness can be attributed. Two are walk-time evidence
 * sources registered in {@link EVIDENCE_SOURCES}; `external-classifier` is a
 * third `via` value a post-audit `classify` command attaches when a provider
 * re-disposes an `unproven` site. It is not consulted during the walk — see
 * {@link WalkTimeEvidenceSourceId}.
 */
export type EvidenceSourceId = 'sql-argument' | 'declaration-resolution' | 'external-classifier';

/**
 * The sources {@link EVIDENCE_SOURCES} actually registers and {@link identifyHandle}
 * folds at walk time. `external-classifier` is deliberately excluded: the
 * classifier is never consulted during an audit, so nothing in the AST walk
 * becomes asynchronous. The `classify` command folds its verdict through the same
 * {@link combineVerdicts} after the audit.
 */
export type WalkTimeEvidenceSourceId = Exclude<EvidenceSourceId, 'external-classifier'>;

/**
 * The verdict. `not-handle.via` is `'declaration-resolution'` — not the wider
 * `EvidenceSourceId` — because only that source can disprove handle-ness:
 * `sql-argument` sees a non-SQL argument and stays `unproven` rather than
 * asserting the receiver is not a handle. The same invariant covers
 * `external-classifier`: a classifier can prove or abstain, never `not-handle`,
 * and its `handle` carries the provider's confidence and opaque provenance so
 * "inferred" reads apart from "proven". That asymmetry is in the type, not a
 * comment.
 */
export type HandleVerdict =
  | { readonly kind: 'handle'; readonly via: WalkTimeEvidenceSourceId }
  | {
      readonly kind: 'handle';
      readonly via: 'external-classifier';
      /** The classifier's confidence in [0, 1]. */
      readonly confidence: number;
      /** Opaque provider provenance — stored, never interpreted. */
      readonly provenance: unknown;
    }
  | { readonly kind: 'not-handle'; readonly via: 'declaration-resolution' }
  | { readonly kind: 'unproven'; readonly reason: string };

/**
 * What a prove-or-abstain source may return: `handle`, or `unproven`. It can
 * never return `not-handle`. This is the invariant "only resolution disproves;
 * inference proves or abstains" in type form: `sql-argument` (walk-time) and the
 * `external-classifier` mapper below both have this shape, and only
 * `declaration-resolution` — which resolved a declaration and found something
 * that is not a database — may assert `not-handle`.
 */
export type ProveOrAbstainVerdict = Extract<HandleVerdict, { readonly kind: 'handle' | 'unproven' }>;

/** The verdict each walk-time source id is permitted to return. */
export type SourceVerdict<S extends WalkTimeEvidenceSourceId> =
  S extends 'sql-argument' ? ProveOrAbstainVerdict : HandleVerdict;

// ─── Call site ───────────────────────────────────────────────────────────────

/** A query-shaped call whose handle-ness is being resolved. */
export interface CallSite {
  /** The format the parse phase assigned the file. */
  readonly format: Format;
  /** Base identifier of the receiver chain (e.g. `db`, `this.env.DB`). */
  readonly root: string;
  /** Full member-chain text including the method (e.g. `db.prepare`, `prisma.user.findMany`). */
  readonly receiver: string;
  /** Terminal method name (e.g. `prepare`, `query`, `findMany`). */
  readonly method: string;
  /** A statically-present SQL string/template argument, else `null`. */
  readonly sqlArgument: string | null;
  /** Whether the receiver chain bottoms out at `this`/`super` (a `this.<field>` reference). */
  readonly thisField: boolean;
  /** The enclosing class's base-class heritage text (`WorkflowEntrypoint<Env>`),
   *  or null when the field is not a `this` reference or the enclosing class has
   *  no base class (Spec 70 Q3). Resolved at fold time via the env's
   *  `resolveHeritageField` — the raw `extends` text is carried, not a pre-resolved
   *  type. Absent on older/foreign call sites. */
  readonly thisHeritage?: string | null;
}

// ─── Resolution facts ────────────────────────────────────────────────────────

/**
 * The deep per-format resolution environment behind the flat facts. The flat
 * string maps above are the *semantic* vocabulary (imports / type text / value
 * text / provenance / package manifest); the environment is the deep,
 * AST-adjacent input the classifier actually walks — `classifyValue` reads
 * value-node structure the flat maps cannot express. Code formats carry it;
 * non-code formats carry `null` (a CSS/JSON/SQL file has no executable
 * receiver, so it resolves `not-handle` without an environment).
 */
export type ResolutionEnv =
  | { readonly dialect: 'ts'; readonly env: RootResolutionEnv }
  | { readonly dialect: 'go'; readonly env: GoResolutionEnv }
  | { readonly dialect: 'none'; readonly env: null };

/**
 * The facts a resolution implementation reads. Shaped to the two formats'
 * shared vocabulary; the ecosystem data (package sets, handle types, ORM
 * methods) is *not* here — it lives behind the owning implementation. The flat
 * maps are the Part 2 surface (ecosystem data moves behind the interface and
 * populates them); `resolution` is the deep environment the classifier reads
 * today, because `classifyValue` walks value-node structure the flat maps
 * cannot express.
 */
export interface ResolutionFacts {
  /** identifier → module specifier, from the file's imports. */
  readonly imports: ReadonlyMap<string, string>;
  /** identifier → declared type text (let/const/param/class-field annotations). */
  readonly typeAnnotations: ReadonlyMap<string, string>;
  /** identifier → bound value text (assignments, destructuring, params). */
  readonly bindings: ReadonlyMap<string, string>;
  /** identifier → evidence source text (within-file provenance). */
  readonly withinFileProvenance: ReadonlyMap<string, string>;
  /** The deep resolution environment (TS / Go / none) the classifier reads. */
  readonly resolution: ResolutionEnv;
  /** The corpus's named SQL dialect, or `null` when it cannot be determined. The
   *  `sql-argument` source reads this to parse a SQL literal; when it is `null`
   *  the source still attempts the parse under {@link DEFAULT_SQL_DIALECT}, and
   *  only on failure reports `cannot-fire` naming both the failure and the
   *  undetermined dialect. Determined from the project's dependency manifest. */
  readonly sqlDialect: Dialect | null;
}

// ─── Evidence source ─────────────────────────────────────────────────────────

export interface EvidenceSource<S extends WalkTimeEvidenceSourceId> {
  readonly id: S;
  evaluate(site: CallSite, facts: ResolutionFacts): SourceVerdict<S>;
}

/** The registry: exactly one source per id, total over `WalkTimeEvidenceSourceId`. */
export type EvidenceSources = {
  readonly [S in WalkTimeEvidenceSourceId]: EvidenceSource<S>;
};

// ─── Resolution implementation (nested seam) ─────────────────────────────────

export type RootDisposition = 'handle' | 'not-handle' | 'unproven';

export interface ResolvedRoot {
  readonly root: string;
  readonly disposition: RootDisposition;
  readonly reason: string;
}

/**
 * The within-file provenance projection one {@link ResolutionImplementation}
 * extracts from a file's AST and re-classifies with no AST. Spec 70 Item 4 /
 * Item 3: this is the serializable seam the phase model's `within-file-provenance`
 * file fact reads, so the corpus fixed point re-derives a file's DB-provenanced
 * names without re-parsing it. Tagged by `kind` so a `classify` call can
 * correlate its extract back to the owning format (the seam is not generic).
 *
 *   • `ts` — the TypeScript family (typescript/tsx/javascript): the fixed-point
 *            projection `TsWithinFileProvenanceExtract` (tsExpressionDescriptor.ts).
 *   • `go` — the Go import + binding maps, classified by `classifyGoBindings`.
 *   • `none` — a non-code format (css/scss/json/sql/markup): no executable
 *            receiver, so its within-file provenance is the empty map.
 */
export type WithinFileProvenanceExtract =
  | { readonly kind: 'ts'; readonly projection: TsWithinFileProvenanceExtract }
  | { readonly kind: 'go'; readonly projection: GoWithinFileProvenanceExtract }
  | { readonly kind: 'none' };

/** The Go extract: the package-name→import-path map and the name→binding map
 *  `classifyGoBindings` reads. Both are already serializable projections (the
 *  `GoBinding.value` is a {@link GoValueDescriptor}, never a live node). */
export interface GoWithinFileProvenanceExtract {
  readonly imports: ReadonlyMap<string, string>;
  readonly bindings: ReadonlyMap<string, GoBinding>;
}

export interface ResolutionImplementation {
  readonly format: Format;
  resolveRoot(site: CallSite, facts: ResolutionFacts): ResolvedRoot;
  /**
   * Extract a file's within-file provenance projection (AST → serializable
   * descriptor). The result carries no live node, so it may outlive the file's
   * AST. Mirrors the extract half of the Go split (`buildGoImportMap` +
   * `buildGoBindingEnv`) and the TS extract arm `extractTsWithinFileProvenance`.
   */
  extract(ast: AST, adapter: LanguageAdapter, sourceCode: string): WithinFileProvenanceExtract;
  /**
   * Re-derive the file's within-file provenance from the projection — no AST, no
   * adapter, no source text. `extraSeeds` carries names provenanced *outside*
   * this file (cross-file import resolution); `goPackageBindings` carries Go
   * package-scope symbols from sibling `.go` files. `classify(extract(ast, …))`
   * must equal `computeTsWithinFileProvenance(ast, …)` for the same file.
   */
  classify(
    extract: WithinFileProvenanceExtract,
    extraSeeds?: ReadonlyMap<string, ProvenanceEvidence>,
    goPackageBindings?: ReadonlyMap<string, GoBinding>,
  ): Map<string, ProvenanceEvidence>;
}

export type ResolutionImplementations = {
  readonly [F in Format]: ResolutionImplementation;
};

// ─── Combination rule ────────────────────────────────────────────────────────

/**
 * Fold the evidence sources' verdicts into one, exhaustive over `HandleVerdict`
 * with no `default` arm. The precedence is `handle` > `not-handle` > `unproven`:
 *
 *   - any `handle` wins and records which source proved it;
 *   - else any `not-handle` wins (only `declaration-resolution` can produce it,
 *     so this arm is decided by that one source);
 *   - else `unproven` carrying the union of reasons.
 *
 * @param verdicts — the verdicts from the walk-time evidence sources, in
 *                   registration order.
 * @returns the folded verdict: any `handle` (with its `via`), else `not-handle`,
 *          else `unproven` carrying the union of non-empty reasons.
 */
export function combineVerdicts(verdicts: readonly HandleVerdict[]): HandleVerdict {
  const unprovenReasons: string[] = [];
  let notHandle: HandleVerdict | null = null;

  for (const verdict of verdicts) {
    if (verdict.kind === 'handle') {
      return verdict; // handle wins immediately, records `via`
    }
    if (verdict.kind === 'not-handle') {
      notHandle = verdict;
      continue;
    }
    // unproven
    unprovenReasons.push(verdict.reason);
  }

  if (notHandle !== null) {
    return notHandle; // not-handle beats unproven
  }

  // An empty reason is a source *staying silent* rather than asserting an
  // unproven cause (`sql-argument` sees no SQL argument). Drop those so the
  // combined reason is the union of the sources that actually have a cause.
  const reasons = [...new Set(unprovenReasons)].filter((r) => r.length > 0);
  return {
    kind: 'unproven',
    reason: reasons.length === 0 ? 'no evidence source produced a verdict' : reasons.join('; '),
  };
}

// ─── Unproven-cause description (the TS/Go pair collapsed into one) ─────────

/**
 * The shared shape a resolution implementation reduces its per-format binding to
 * before describing *why* a root stayed `unproven`. TS `Binding` and Go
 * `GoBinding` are both structurally assignable to it; the extra Go field
 * (`returnTypeText`) and the `ASTNode`/`RawNode` value nodes are irrelevant to a
 * reason string (only their truthiness is read).
 */
export interface UnprovenBinding {
  readonly kind: string;
  readonly source?: string;
  readonly typeText?: string;
  readonly value?: unknown;
}

/**
 * The one word the TS/Go `field` reason genuinely differs on: a bare declaration
 * (no initializer) is a `class field` in TS and a `struct field` in Go. The
 * initializer case (`field initializer`) is identical in both, so it is not a
 * parameter.
 */
export type UnprovenFieldWording = string;

/** The TS word for an unproven, un-annotated `field` declaration. */
export const TYPESCRIPT_FIELD_WORDING: UnprovenFieldWording = 'class field';

/** The Go word for an unproven, un-annotated `field` declaration. */
export const GO_FIELD_WORDING: UnprovenFieldWording = 'struct field';

/**
 * Why a root classified `unproven` could not be resolved to handle or
 * not-handle. The single implementation behind the two `resolveRoot`s; the
 * former `unprovenCause` / `goUnprovenCause` pair ceased to exist as a pair and
 * its two halves became one function parameterized on the one `field` word that
 * differs.
 *
 * @param root — the receiver's base identifier being described.
 * @param provenance — the `has(key)` predicate over the file's DB-provenance set.
 * @param binding — the root's binding in the file scope chain, or `undefined`.
 * @param fieldNoValueWord — the format's word for an un-annotated field
 *                           (`class field` / `struct field`).
 * @returns a human-readable reason the root stayed `unproven`.
 */
export function describeUnprovenCause(
  root: string,
  provenance: { readonly has: (key: string) => boolean },
  binding: UnprovenBinding | undefined,
  fieldNoValueWord: UnprovenFieldWording,
): string {
  if (provenance.has(root)) return 'resolved to a DB handle (misclassified)';
  if (!binding) return 'has no binding in the file scope chain';
  switch (binding.kind) {
    case 'import':
      return `imports from '${binding.source ?? '?'}' — an unrecognized package (not in the database-packages manifest)`;
    case 'parameter':
      return binding.typeText ? `parameter type \`${binding.typeText}\` is indeterminate` : 'is an un-annotated parameter';
    case 'variable':
      if (binding.typeText) return `declared type \`${binding.typeText}\` is indeterminate`;
      return binding.value ? 'is an un-annotated factory return' : 'is an un-annotated declaration';
    case 'field':
      if (binding.typeText) return `field type \`${binding.typeText}\` is indeterminate`;
      return binding.value ? 'is an un-annotated field initializer' : `is an un-annotated ${fieldNoValueWord}`;
    case 'function':
    case 'method':
      return 'is a function reference without a DB return type';
    case 'class':
      return 'is a class reference without DB provenance';
    case 'type':
      return 'is a local type name';
    default:
      return 'is indeterminate';
  }
}

// ─── Resolution implementations (nested seam) ────────────────────────────────

const NON_CODE_FORMATS = ['css', 'scss', 'json', 'sql', 'markup'] as const;

/** A non-code file has no executable receiver, so its root is `not-handle` and
 *  its within-file provenance is the empty map. */
function nonCodeResolution(format: (typeof NON_CODE_FORMATS)[number]): ResolutionImplementation {
  return {
    format,
    resolveRoot(site) {
      return {
        root: site.root,
        disposition: 'not-handle',
        reason: `a ${format} file carries no executable receiver, so \`${site.root}\` is not a DB handle`,
      };
    },
    extract() {
      return { kind: 'none' };
    },
    classify() {
      return new Map();
    },
  };
}

/**
 * The TypeScript-family implementation, shared by `typescript`/`tsx`/`javascript`.
 * The three formats differ only by file extension; their receiver resolution is
 * identical, so one implementation serves all three keys.
 */
const typescriptResolution: ResolutionImplementation = {
  format: 'typescript',
  resolveRoot(site, facts) {
    if (facts.resolution.dialect !== 'ts') {
      return { root: site.root, disposition: 'unproven', reason: 'missing TypeScript resolution environment' };
    }
    const env = facts.resolution.env;
    // Clear the ambient-rejection + import-resolution out-params before
    // classifying — the reason below reads them only when this classification
    // set them, never a stale value from a prior site sharing the env.
    env.ambientRejectionReason = undefined;
    env.importResolutionReason = undefined;
    const classified = classifyRootIdentifier(site.root, env, 0, {
      thisField: site.thisField,
      memberPath: site.thisField
        ? deriveThisMemberPath(site.root, site.receiver)
        : deriveMemberPath(site.root, site.receiver, false),
      thisHeritage: site.thisHeritage,
    });
    // The package discriminant (not the method name) decides the disposition: an
    // unrecognized root is `unproven` (cannot-fire), never downgraded by method
    // shape — `join` is `Array.prototype.join` and also `SQL JOIN`.
    const disposition = classified;
    return {
      root: site.root,
      disposition,
      reason:
        disposition === 'unproven'
          ? env.ambientRejectionReason ?? env.importResolutionReason ?? describeUnprovenCause(site.root, env.provenance, env.bindings.get(site.root), TYPESCRIPT_FIELD_WORDING)
          : disposition,
    };
  },
  extract(ast, adapter, sourceCode) {
    return { kind: 'ts', projection: extractTsWithinFileProvenance(ast, adapter, sourceCode) };
  },
  classify(extract, extraSeeds = new Map()) {
    if (extract.kind !== 'ts') {
      throw new Error(`TypeScript resolution classified a ${extract.kind} within-file extract`);
    }
    return classifyTsWithinFileProvenance(extract.projection, extraSeeds);
  },
};

/** The Go implementation. */
const goResolution: ResolutionImplementation = {
  format: 'go',
  resolveRoot(site, facts) {
    if (facts.resolution.dialect !== 'go') {
      return { root: site.root, disposition: 'unproven', reason: 'missing Go resolution environment' };
    }
    const env = facts.resolution.env;
    const classified = classifyGoRootIdentifier(site.root, env);
    // The package discriminant (not the method name) decides the disposition: an
    // unrecognized root is `unproven` (cannot-fire), never downgraded by method
    // shape — `join` is `Array.prototype.join` and also `SQL JOIN`.
    const disposition = classified;
    return {
      root: site.root,
      disposition,
      reason:
        disposition === 'unproven'
          ? describeGoUnprovenCause(site.root, env)
          : disposition,
    };
  },
  extract(ast, adapter, sourceCode) {
    return {
      kind: 'go',
      projection: {
        imports: buildGoImportMap(ast, adapter),
        bindings: buildGoBindingEnv(ast, adapter, sourceCode),
      },
    };
  },
  classify(extract, extraSeeds = new Map(), goPackageBindings) {
    if (extract.kind !== 'go') {
      throw new Error(`Go resolution classified a ${extract.kind} within-file extract`);
    }
    // `classifyGoBindings` seeds DB packages + classifies every binding; the
    // cross-file `extraSeeds` merge is the one step `computeTsWithinFileProvenance`
    // applied *outside* `buildGoWithinFileProvenance`, so it is reproduced here.
    const prov = classifyGoBindings(extract.projection.imports, extract.projection.bindings, goPackageBindings);
    for (const [name, evidence] of extraSeeds) {
      if (!prov.has(name)) prov.set(name, evidence);
    }
    return prov;
  },
};

export const RESOLUTION_IMPLEMENTATIONS: ResolutionImplementations = {
  typescript: typescriptResolution,
  tsx: typescriptResolution,
  javascript: typescriptResolution,
  go: goResolution,
  css: nonCodeResolution('css'),
  scss: nonCodeResolution('scss'),
  json: nonCodeResolution('json'),
  sql: nonCodeResolution('sql'),
  markup: nonCodeResolution('markup'),
};

// ─── Evidence sources ────────────────────────────────────────────────────────

/**
 * `sql-argument`: the call's argument parses as a SQL statement, so the receiver
 * must be a DB handle. It can only prove `handle`; on an absent argument it
 * stays *silent* — `unproven` with an empty reason that `combineVerdicts` drops,
 * so it never contributes a cause to the cannot-fire report.
 *
 * Spec 70 R3: the proof is the parsed format, not a method-name or package list.
 * `site.sqlArgument` is the extracted SQL string (already stripped of its
 * surrounding quotes/backticks); it proves `handle` only when {@link parseSql}
 * accepts it. Spec 70 R2 says parsing a literal does not require *proving* the
 * site's dialect first — one grammar is named and the parse is attempted under
 * it — so the source parses under the corpus's named dialect
 * (`facts.sqlDialect`), or under {@link DEFAULT_SQL_DIALECT} when that is `null`.
 * An argument that does *not* parse is a genuine `unproven` with a reason — "I
 * was handed SQL-shaped text and could not read it" — which surfaces as
 * `cannot-fire`, never `clean` (criterion 3). When the dialect was undetermined,
 * that reason names **both** the parse failure and the undetermined dialect (the
 * failure may be dialect-specific syntax), rather than abstaining before the
 * parse. A string that never reaches a data-access call site is not parsed at
 * all (R5), so a non-SQL string argument on a non-query-shaped call is not this
 * source's concern.
 */
const sqlArgumentSource: EvidenceSource<'sql-argument'> = {
  id: 'sql-argument',
  evaluate(site, facts) {
    if (site.sqlArgument === null) return { kind: 'unproven', reason: '' };
    const parsed = parseSql(site.sqlArgument, facts.sqlDialect ?? DEFAULT_SQL_DIALECT);
    if (parsed.ok) return { kind: 'handle', via: 'sql-argument' };
    if (facts.sqlDialect === null) {
      return {
        kind: 'unproven',
        reason: `node-sql-parser could not parse the SQL argument under the default ${DEFAULT_SQL_DIALECT} grammar, and the dialect is undetermined — the failure may be dialect-specific syntax: ${parsed.reason}`,
      };
    }
    return { kind: 'unproven', reason: `node-sql-parser could not parse the SQL argument under ${facts.sqlDialect}: ${parsed.reason}` };
  },
};

/**
 * `declaration-resolution`: the receiver's declaration resolves to a DB handle
 * (package import, type annotation, or binding). The only source that can prove
 * `not-handle`. It delegates to the format's `ResolutionImplementation`.
 */
const declarationResolutionSource: EvidenceSource<'declaration-resolution'> = {
  id: 'declaration-resolution',
  evaluate(site, facts) {
    const resolved = RESOLUTION_IMPLEMENTATIONS[site.format].resolveRoot(site, facts);
    switch (resolved.disposition) {
      case 'handle':
        return { kind: 'handle', via: 'declaration-resolution' };
      case 'not-handle':
        return { kind: 'not-handle', via: 'declaration-resolution' };
      case 'unproven':
        return { kind: 'unproven', reason: resolved.reason };
    }
  },
};

export const EVIDENCE_SOURCES: EvidenceSources = {
  'sql-argument': sqlArgumentSource,
  'declaration-resolution': declarationResolutionSource,
};

// ─── The entry point ──────────────────────────────────────────────────────────

/**
 * The single handle-identification entry point: fold both evidence sources.
 *
 * @param site — the query-shaped call site whose handle-ness is being resolved.
 * @param facts — the flat + deep resolution facts the sources read.
 * @returns the combined `HandleVerdict` from both walk-time sources.
 */
export function identifyHandle(site: CallSite, facts: ResolutionFacts): HandleVerdict {
  return combineVerdicts([
    EVIDENCE_SOURCES['sql-argument'].evaluate(site, facts),
    EVIDENCE_SOURCES['declaration-resolution'].evaluate(site, facts),
  ]);
}

// ─── External classifier (post-audit; never part of the walk) ────────────────
//
// The external classifier is a third way to attribute handle-ness, but it is not
// consulted during an audit: `identifyHandle`, `classifyUnprovenQueryReceivers`,
// and everything downstream stay synchronous. A separate `code-audit classify`
// command reads the persisted `unproven` dispositions, calls a provider, and
// folds the result through {@link combineVerdicts} with the same invariant. Only
// the pure, synchronous confidence→verdict mapping and its configuration live
// here — the async provider call never appears in these types.

/**
 * The provider-neutral result a classifier returns: a confidence plus an opaque
 * provenance blob the tool stores and never interprets. No vendor concept
 * appears here, in {@link ExternalClassifierConfig}, or in the verdict types —
 * the provider's own shape stays entirely behind the transport adapter in the
 * `classify` command.
 */
export interface ClassifierResult {
  /** The classifier's confidence that the receiver is a DB handle, nominally [0, 1]. */
  readonly confidence: number;
  /** Opaque provider provenance — stored on the verdict, never interpreted. */
  readonly provenance: unknown;
}

/**
 * Classifier configuration. The threshold is required and has no default: it
 * must come from the calibration run's separation data. A classifier configured
 * without a threshold is refused loudly by {@link validateExternalClassifierConfig}
 * — never silently defaulted to a guessed number.
 */
export interface ExternalClassifierConfig {
  readonly threshold: number;
}

/** The accurate disposition when no classifier is configured: the question cannot
 *  be answered, so the source abstains with this exact reason. */
export const NO_EXTERNAL_CLASSIFIER: HandleVerdict = {
  kind: 'unproven',
  reason: 'no external classifier configured',
};

/**
 * The single upper threshold (the "band") the tool applies to a classifier's
 * confidence. At or above it the site is attributed `handle` with the confidence
 * and provenance; below it the source abstains — with the confidence recorded in
 * the reason so the near-miss is visible, not discarded. A low confidence is
 * absence of evidence, not evidence of absence: this mapper proves or abstains,
 * never `not-handle`.
 *
 * @param result — the classifier's confidence plus opaque provenance.
 * @param threshold — the handle threshold; at or above it the site is `handle`.
 * @returns `handle` (with confidence + provenance) at/above threshold, else
 *          `unproven` with the confidence recorded in the reason.
 */
export function externalClassifierVerdict(result: ClassifierResult, threshold: number): ProveOrAbstainVerdict {
  const { confidence, provenance } = result;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return {
      kind: 'unproven',
      reason: `external classifier confidence ${confidence} is out of range [0, 1]`,
    };
  }
  if (confidence < threshold) {
    return {
      kind: 'unproven',
      reason: `external classifier confidence ${confidence} is below the handle threshold ${threshold}`,
    };
  }
  return { kind: 'handle', via: 'external-classifier', confidence, provenance };
}

/**
 * Validate classifier configuration, refusing loudly on a missing or non-finite
 * threshold. Returns the config on success; throws otherwise. The threshold has
 * no default — a guessed number would be a silent wrong answer at the
 * configuration layer.
 *
 * @param config — the raw, unvalidated classifier configuration.
 * @returns the validated `ExternalClassifierConfig` with a finite `threshold` in
 *          [0, 1].
 */
export function validateExternalClassifierConfig(config: unknown): ExternalClassifierConfig {
  if (typeof config !== 'object' || config === null) {
    throw new Error('external classifier config must be an object with a `threshold`');
  }
  const threshold = (config as { readonly threshold?: unknown }).threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('external classifier `threshold` is required and must be a finite number in [0, 1]');
  }
  return { threshold };
}

// ─── Compile-time residue checks ──────────────────────────────────────────────
//
// Both registries are total. `Exclude<Discriminant, keyof typeof REGISTRY>` is
// `never` only when every discriminant has a registration; the `const … = true`
// assignments fail the build the moment one is missing.

type _UnregisteredEvidenceSource = Exclude<WalkTimeEvidenceSourceId, keyof typeof EVIDENCE_SOURCES>;
const _allEvidenceSourcesRegistered: _UnregisteredEvidenceSource extends never ? true : never = true;

type _UnimplementedFormat = Exclude<Format, keyof typeof RESOLUTION_IMPLEMENTATIONS>;
const _allFormatsImplemented: _UnimplementedFormat extends never ? true : never = true;

// Liveness seeds — each names a discriminant and is legal only while the residue
// above is `never`. Remove one registration, the residue widens to that name,
// the assignment compiles, and the `@ts-expect-error` goes unused → the build
// fails. Same idiom as `phase/seeded-defects.ts`, colocated so the seam's
// totality is checked wherever the seam is compiled.

// @ts-expect-error — an unregistered walk-time source would make this a non-never type
const _missingEvidenceSource: Exclude<WalkTimeEvidenceSourceId, keyof typeof EVIDENCE_SOURCES> = 'sql-argument';

// @ts-expect-error — an unimplemented format would make this a non-never type
const _missingFormat: Exclude<Format, keyof typeof RESOLUTION_IMPLEMENTATIONS> = 'go';

// @ts-expect-error — a prove-or-abstain source cannot disprove handle-ness (narrowing liveness)
const _proveOrAbstainCannotDisprove: ProveOrAbstainVerdict = { kind: 'not-handle', via: 'declaration-resolution' };

void _allEvidenceSourcesRegistered;
void _allFormatsImplemented;
void _missingEvidenceSource;
void _missingFormat;
void _proveOrAbstainCannotDisprove;
