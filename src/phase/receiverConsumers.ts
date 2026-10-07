/**
 * Spec 70 Item 4 (step 3) — the corpus-side reductions for the four receiver
 * consumers, over the `receiver-activity` file fact + the `receiver-provenance`
 * fixed point.
 *
 * The collapse makes each receiver consumer a corpus producer: it reads (a) a raw
 * file fact extracted while the AST lived, and (b) the provenance fixed point, and
 * re-derives the file's `buildProvenanceContext().dbProvenanced` with no AST via
 * `classifyBuildProvenance`. This module holds the shared rehydration + the gate
 * mirror those reductions need, so each consumer's `process` is a thin projection
 * over pre-rehydrated provenance. The rehydrators are the inverse of the file
 * producers' serialization: `evidenceFromFact`/`tsExtractFromFact` rebuild the
 * `ProvenanceEvidence`/`TsWithinFileProvenanceExtract` the classify seam reads, and
 * `rehydrateReceiverActivity` rebuilds the `Binding`/`R3Site` inputs
 * `classifyBuildProvenance` folds R3 over.
 */

import picomatch from 'picomatch';
import type {
  DataAccessCallCandidate,
  DbCallCandidate,
  FunctionSpanFact,
  LoopQueryFact,
  LoopQueryRawCandidate,
  QuerySiteCandidatesFact,
  QuerySiteFact,
  ReceiverActivityFact,
  ReceiverProvenanceFact,
  ResolvedQuery,
  SchemaUsageCandidatesFact,
  SchemaUsageFact,
  StringFragmentFact,
  UnresolvedQuerySite,
  WithinFileProvenanceFact,
} from './types.js';
import type { ProvenanceEvidence, R3Site } from '../analyzers/provenance.js';
import type { Binding, RootResolutionEnv, SpecifierResolution, HeritageFieldResolver } from '../analyzers/receiverRoot.js';
import type { TsWithinFileProvenanceExtract } from '../analyzers/tsExpressionDescriptor.js';
import { classifyBuildProvenance, evidenceFromFact, rehydrateWithinFileProvenance, bindingFromFact } from './receiverProvenance.js';
import { DEFAULT_SCHEMA_CONFIG } from '../analyzers/universal/schema/config.js';
import type { Dialect } from '../mcp-tools/discoveryQueries.js';
import { identifyHandle, type HandleVerdict, type GoWithinFileProvenanceExtract } from '../analyzers/handleIdentification.js';
import { handleTypesForPackage } from '../analyzers/tsEcosystem.js';
import { parseSqlTables } from '../analyzers/universal/schema/codeAnalysis.js';
import type { TableReference } from '../analyzers/universal/schema/types.js';
import { dialectForPackage } from '../languages/sql/dialectDetection.js';
import {
  parseSql,
  DEFAULT_SQL_DIALECT,
  extractTableNames,
  whereFacts,
  isWriteStatement,
  isMassWriteStatement,
  isUpsertStatement,
  whereColumnRefs,
} from '../languages/sql/sqlAst.js';
import { rawInsertColumnsFromAst } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import type { GoResolutionEnv, GoBinding } from '../languages/go/goResolution.js';
import type { UnprovenQueryReceiver } from '../analyzers/receiverResolution.js';
import { describeUnprovenReceiver, resolveSpecifier, makeHeritageResolver, type TsconfigPathMap } from '../analyzers/receiverResolution.js';

// ── Specifier resolution (Spec 70 B1) ────────────────────────────────────────

/** A resolver bound to one importing file, threaded into the TS resolution env. */
type SpecifierResolver = (source: string) => SpecifierResolution | null;

/**
 * Build the single specifier-resolution seam the consumers thread into
 * `identifyHandle`'s TS env: one `filesByPath` set derived once from the
 * within-file facts, so the four specifier kinds (relative, tsconfig-`paths`,
 * bare vendor, and the `@/`/`~/` fallback) all answer through `resolveSpecifier`
 * (Spec 70 B1). Returns null when there is no project root to resolve against —
 * the env's `resolveImport` stays undefined and the classifier abstains as it did
 * before the seam was threaded.
 */
function makeSpecifierResolver(
  withinFacts: readonly WithinFileProvenanceFact[],
  projectRoot: string | undefined,
  tsconfig: TsconfigPathMap | undefined,
): ((source: string, importerPath: string) => SpecifierResolution | null) | null {
  if (!projectRoot) return null;
  const filesByPath = new Set(withinFacts.map((f) => f.file));
  // Memoize the resolution keyed on (source, importerPath) so a specifier that
  // resolved once in the run is never re-probed. `resolveSpecifier`'s vendor arm
  // walks up from the importer's directory doing `readFileSync`/`existsSync`
  // probes, and the same bare import is resolved once per candidate that
  // references it; without the cache that filesystem work is repeated for every
  // candidate across every file. The importer is part of the key because the
  // relative arm (and a monorepo's nested `node_modules`) resolve per-directory.
  const cache = new Map<string, SpecifierResolution | null>();
  return (source, importerPath) => {
    const key = `${source}\u0000${importerPath}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const resolved = resolveSpecifier(source, importerPath, filesByPath, projectRoot, tsconfig);
    cache.set(key, resolved);
    return resolved;
  };
}

// ── Rehydrators — fact → the corpus-side classify input, no translation ──────

/** Rehydrate one file's `receiver-activity` fact back to the three provenance
 *  inputs `classifyBuildProvenance` reads: the `Binding` map (`identifyHandle`'s
 *  declaration resolution), the `R3Site[]` (`applyR3FromSites`), and the DB-shaped
 *  activity set (`passesFileGate`'s `dbActivity` signal).
 * @param fact - The serialized `receiver-activity` fact (may be absent).
 * @returns The rehydrated bindings, R3 sites, and DB-activity set. */
export function rehydrateReceiverActivity(fact: ReceiverActivityFact | undefined): {
  bindings: Map<string, Binding>;
  r3Sites: R3Site[];
  dbActivity: Set<string>;
} {
  if (!fact) return { bindings: new Map(), r3Sites: [], dbActivity: new Set() };
  return {
    bindings: new Map(fact.bindings.map((b) => [b.name, bindingFromFact(b)])),
    r3Sites: fact.r3Sites.map((s) => ({
      root: s.root,
      receiver: s.receiver,
      method: s.method,
      sqlArgument: s.sqlArgument,
      thisField: s.thisField,
      thisHeritage: s.thisHeritage,
    })),
    dbActivity: new Set(fact.dbActivity),
  };
}

/** Rehydrate the `receiver-provenance` fact's `files` back to a per-file seed
 *  map — the exact `FileProvenance[file]` the legacy `file.receiverProvenance`
 *  carried, keyed by file path so a consumer can look up its seed.
 * @param fact - The serialized `receiver-provenance` fixed point.
 * @returns A per-file map of provenanced-name → evidence. */
export function rehydrateReceiverProvenance(fact: ReceiverProvenanceFact): Map<string, Map<string, ProvenanceEvidence>> {
  const byFile = new Map<string, Map<string, ProvenanceEvidence>>();
  for (const f of fact.files) {
    byFile.set(
      f.file,
      new Map(f.provenance.map((e) => [e.identifier, evidenceFromFact(e)])),
    );
  }
  return byFile;
}

/** Rehydrate the TS-family `within-file-provenance` facts back to a per-file
 *  `TsWithinFileProvenanceExtract` map (Go facts are skipped — the receiver
 *  consumers are TS-family-only).
 * @param withinFacts - The `within-file-provenance` facts (TS-family + Go).
 * @returns A per-file map of rehydrated `TsWithinFileProvenanceExtract` (Go skipped). */
export function rehydrateWithinTsExtracts(
  withinFacts: readonly WithinFileProvenanceFact[],
): Map<string, TsWithinFileProvenanceExtract> {
  const byFile = new Map<string, TsWithinFileProvenanceExtract>();
  for (const fact of withinFacts) {
    if (fact.format === 'go') continue;
    const rehydrated = rehydrateWithinFileProvenance(fact);
    if (rehydrated.kind === 'ts') byFile.set(fact.file, rehydrated.projection);
  }
  return byFile;
}

/** Rehydrate the Go `within-file-provenance` facts back to a per-file
 *  `GoWithinFileProvenanceExtract` map (TS facts are skipped). The Go extract is
 *  the binding + import env the Go arm of `identifyHandle` reads — `data-access-calls`
 *  is the one receiver consumer that runs for the `go` format, so its corpus
 *  producer needs the Go extracts in addition to the TS ones.
 * @param withinFacts - The `within-file-provenance` facts (TS-family + Go).
 * @returns A per-file map of rehydrated `GoWithinFileProvenanceExtract` (TS skipped). */
export function rehydrateWithinGoExtracts(
  withinFacts: readonly WithinFileProvenanceFact[],
): Map<string, GoWithinFileProvenanceExtract> {
  const byFile = new Map<string, GoWithinFileProvenanceExtract>();
  for (const fact of withinFacts) {
    if (fact.format !== 'go') continue;
    const rehydrated = rehydrateWithinFileProvenance(fact);
    if (rehydrated.kind === 'go') byFile.set(fact.file, rehydrated.projection);
  }
  return byFile;
}

/** Re-fold one file's DB-receiver environment from the rehydrated within-file
 *  extracts + the cross-file seed — the shared setup for the `data-access-calls`
 *  and `unproven-query-receivers` consumers. Go: the seed is the provenanced set
 *  and the extract supplies the binding/import env. TS: `classifyBuildProvenance`
 *  folds the seed + activity R3 sites + function wrappers into `dbProvenanced`,
 *  and the activity supplies the bindings. */
function foldReceiverEnvironment(opts: {
  file: string;
  isGo: boolean;
  tsExtracts: ReadonlyMap<string, TsWithinFileProvenanceExtract>;
  goExtracts: ReadonlyMap<string, GoWithinFileProvenanceExtract>;
  seeds: ReadonlyMap<string, Map<string, ProvenanceEvidence>>;
  activityByFile: ReadonlyMap<string, ReceiverActivityFact>;
  sqlDialect: Dialect | null;
}): {
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>;
  bindings: ReadonlyMap<string, Binding>;
  goEnv: GoResolutionEnv | undefined;
  interfaceFields: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined;
} {
  const { file, isGo, tsExtracts, goExtracts, seeds, activityByFile, sqlDialect } = opts;
  if (isGo) {
    const seed = seeds.get(file) ?? new Map<string, ProvenanceEvidence>();
    const goExtract = goExtracts.get(file);
    return {
      dbProvenanced: seed,
      bindings: new Map(),
      goEnv: {
        provenance: seed,
        bindings: goExtract?.bindings ?? new Map<string, GoBinding>(),
        imports: goExtract?.imports ?? new Map<string, string>(),
      },
      interfaceFields: undefined,
    };
  }
  const extract = tsExtracts.get(file);
  const activity = rehydrateReceiverActivity(activityByFile.get(file));
  return {
    dbProvenanced: extract
      ? classifyBuildProvenance(extract, seeds.get(file) ?? new Map(), activity.bindings, activity.r3Sites, sqlDialect)
      : new Map<string, ProvenanceEvidence>(),
    bindings: activity.bindings,
    goEnv: undefined,
    interfaceFields: extract?.interfaceFields,
  };
}

// ── The gate mirror ──────────────────────────────────────────────────────────

/**
 * The corpus-side mirror of `passesFileGate` for `mode !== 'names'` (the
 * producers always build `mode: 'hybrid'`). The `names` arm never runs, and
 * `hasSqlTag` — the one input the corpus producer cannot re-derive (it scans
 * source text) — arrives pre-extracted in the raw fact. The glob + provenance +
 * activity arms are byte-identical to the legacy gate.
 */
function passesFileGateRehydrated(
  filePath: string,
  hasSqlTag: boolean,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>,
  dbActivity: ReadonlySet<string>,
): boolean {
  const gateGlobs = DEFAULT_SCHEMA_CONFIG.fileGateGlobs ?? ['**/*.sql', '**/migrations/**'];
  if (gateGlobs.some((glob) => picomatch.isMatch(filePath, glob))) return true;
  if (dbProvenanced.size > 0) return true;
  if (dbActivity.size > 0) return true;
  return hasSqlTag;
}

// ── `query-sites` reduction ──────────────────────────────────────────────────

/**
 * The corpus `query-sites` producer: re-derive each file's gate (glob ||
 * dbProvenanced || dbActivity || hasSqlTag) from the raw `query-site-candidates`
 * fact + the provenance fixed point, and emit the sites of the files that pass.
 *
 * A file's `dbProvenanced` is re-derived by `classifyBuildProvenance` from its
 * within-file extract, its cross-file seed (`receiver-provenance`), and its
 * `receiver-activity` inputs. Files are iterated in the raw fact's (file-sorted)
 * order, so the emitted site array — and every finding derived from it — is
 * byte-identical to the legacy gated extraction.
 *
 * @param candidates the raw `query-site-candidates` facts (one per TS-family file)
 * @param withinFacts the `within-file-provenance` facts (TS-family)
 * @param provenance the `receiver-provenance` fixed point
 * @param activityFacts the `receiver-activity` facts
 * @param sqlDialect the corpus's named dialect, or null to skip R3
 * @returns the classified query-site facts (one per admitted TS-family site)
 */
export function classifyQuerySites(
  candidates: readonly QuerySiteCandidatesFact[],
  withinFacts: readonly WithinFileProvenanceFact[],
  provenance: ReceiverProvenanceFact,
  activityFacts: readonly ReceiverActivityFact[],
  sqlDialect: Dialect | null,
): QuerySiteFact[] {
  const extracts = rehydrateWithinTsExtracts(withinFacts);
  const seeds = rehydrateReceiverProvenance(provenance);
  const activityByFile = new Map(activityFacts.map((f) => [f.file, f]));

  const out: QuerySiteFact[] = [];
  for (const cand of candidates) {
    const extract = extracts.get(cand.file);
    // A file with no within-file extract (should not happen — both facts are
    // TS-family, emitted for the same files) cannot re-derive provenance; its
    // gate falls through to dbActivity/hasSqlTag/glob, matching a file with no
    // within-file DB seed.
    const activity = rehydrateReceiverActivity(activityByFile.get(cand.file));
    const dbProvenanced = extract
      ? classifyBuildProvenance(extract, seeds.get(cand.file) ?? new Map(), activity.bindings, activity.r3Sites, sqlDialect)
      : new Map<string, ProvenanceEvidence>();
    if (passesFileGateRehydrated(cand.file, cand.hasSqlTag, dbProvenanced, activity.dbActivity)) {
      out.push(...cand.sites);
    }
  }
  return out;
}

// ── `schema-usage` reduction ─────────────────────────────────────────────────

/** True when `loc` falls inside the span [start, end] (all 1-based line/column). */
function contains(
  start: { line: number; column: number },
  end: { line: number; column: number },
  loc: { line: number; column: number },
): boolean {
  const afterStart =
    start.line < loc.line || (start.line === loc.line && start.column <= loc.column);
  const beforeEnd = end.line > loc.line || (end.line === loc.line && end.column >= loc.column);
  return afterStart && beforeEnd;
}

/** True when `a` starts at or after `b` — the "innermost wins" tiebreak. */
function startsAtOrAfter(
  a: { line: number; column: number },
  b: { line: number; column: number },
): boolean {
  return a.line > b.line || (a.line === b.line && a.column >= b.column);
}

/** The corpus-side mirror of `dialectForEvidence` (private in provenance.ts):
 *  the SQL dialect a DB-driver package's evidence names, or null. */
function dialectForEvidence(evidence: ProvenanceEvidence | undefined): Dialect | null {
  if (!evidence?.packageName) return null;
  return dialectForPackage(evidence.packageName);
}

/** The corpus-side mirror of `resolveSiteDialect`'s member arm (provenance.ts):
 *  the receiver text's package, then each dotted segment, first non-null wins. */
function resolveSiteDialectFromReceiver(
  receiver: string | null,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>,
): Dialect | null {
  if (!receiver) return null;
  for (const candidate of [receiver, ...receiver.split('.')]) {
    const dialect = dialectForEvidence(dbProvenanced.get(candidate));
    if (dialect) return dialect;
  }
  return null;
}

/**
 * The corpus-side mirror of `findClosestNodeAt` + `findEnclosingFunctionIdentity`
 * (the legacy re-home), over the projected spans. For an in-function reference
 * the identity is the innermost enclosing function (the containing span with the
 * latest start); for a top-level reference it is the `string_fragment` containing
 * the reference — the deepest node `findClosestNodeAt` returns for a table name
 * inside a SQL string — whose start becomes the coordinate.
 */
function rehomeReference(
  ref: TableReference,
  filePath: string,
  functions: readonly FunctionSpanFact[],
  stringFragments: readonly StringFragmentFact[],
): SchemaUsageFact {
  const loc = ref.location;
  let fn: FunctionSpanFact | null = null;
  for (const f of functions) {
    const start = { line: f.startLine, column: f.startColumn };
    if (
      contains(start, { line: f.endLine, column: f.endColumn }, loc) &&
      (fn === null || startsAtOrAfter(start, { line: fn.startLine, column: fn.startColumn }))
    ) {
      fn = f;
    }
  }
  if (fn) {
    return {
      tableName: ref.table,
      filePath,
      functionName: fn.name,
      functionStartLine: fn.startLine,
      functionStartColumn: fn.startColumn,
      usageType: ref.type,
      line: loc.line,
      column: loc.column,
      rawQuery: ref.context,
      origin: ref.origin,
    };
  }

  let frag: StringFragmentFact | null = null;
  for (const fr of stringFragments) {
    const start = { line: fr.startLine, column: fr.startColumn };
    if (
      contains(start, { line: fr.endLine, column: fr.endColumn }, loc) &&
      (frag === null || startsAtOrAfter(start, { line: frag.startLine, column: frag.startColumn }))
    ) {
      frag = fr;
    }
  }
  return {
    tableName: ref.table,
    filePath,
    functionName: 'top-level',
    functionStartLine: frag?.startLine ?? null,
    functionStartColumn: frag?.startColumn ?? null,
    usageType: ref.type,
    line: loc.line,
    column: loc.column,
    rawQuery: ref.context,
    origin: ref.origin,
  };
}

/**
 * The corpus-side mirror of `dbCallVerdict`'s provenance-dependent admission
 * (`identifyHandle`). The raw producer already applied the structural gates
 * (callee shape, method gate, root gate, resolvable SQL); this re-folds the
 * handle verdict over the re-derived `dbProvenanced` + rehydrated bindings and
 * drops `not-handle` (and, for a bare-identifier call, a name that is neither
 * provenanced nor type-annotated). Returns the verdict plus the site dialect the
 * caller's `parseSqlTables` needs, or null when the call is not admitted.
 */
function admitDbCall(
  call: DbCallCandidate,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>,
  bindings: ReadonlyMap<string, Binding>,
  sqlDialect: Dialect | null,
  interfaceFields: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined,
  declaredTypePackages: ReadonlySet<string> | undefined,
  resolveImport: SpecifierResolver | undefined,
  resolveHeritageField: HeritageFieldResolver | undefined,
): { dialect: Dialect | null } | null {
  const siteDialect =
    call.calleeType === 'identifier'
      ? dialectForEvidence(dbProvenanced.get(call.name))
      : resolveSiteDialectFromReceiver(call.receiver, dbProvenanced);
  const dialect = siteDialect ?? sqlDialect ?? null;

  const env = { provenance: dbProvenanced, bindings, interfaceFields, declaredTypePackages, resolveImport, resolveHeritageField, adapter: undefined, sourceCode: '' } as unknown as RootResolutionEnv;
  const facts = {
    imports: new Map(),
    typeAnnotations: new Map(),
    bindings: new Map(),
    withinFileProvenance: new Map(),
    sqlDialect: dialect,
    resolution: { dialect: 'ts' as const, env },
  };

  if (call.calleeType === 'identifier') {
    const binding = bindings.get(call.name);
    const isProvenanced = dbProvenanced.has(call.name);
    const isTypeAnnotated = !!binding && !!binding.typeText;
    // A named import from a manifest DB package is a DB *signal* even when the
    // name isn't a handle — admit it so `identifyHandle` proves `not-handle`
    // rather than dropping the site for want of evidence (Spec 70).
    const isDbPackageImport =
      !!binding && binding.kind === 'import' && handleTypesForPackage(binding.source ?? '') !== undefined;
    if (!isProvenanced && !isTypeAnnotated && !isDbPackageImport) return null;
    const verdict = identifyHandle(
      {
        format: 'typescript',
        root: call.name,
        receiver: call.name,
        method: call.name,
        sqlArgument: call.sqlArgument,
        thisField: false,
      },
      facts,
    );
    return verdict.kind === 'not-handle' ? null : { dialect };
  }

  const verdict = identifyHandle(
    {
      format: 'typescript',
      root: call.root,
      receiver: call.receiver ?? call.root,
      method: call.method,
      sqlArgument: call.sqlArgument,
      thisField: call.thisField,
    },
    facts,
  );
  return verdict.kind === 'not-handle' ? null : { dialect };
}

/**
 * The corpus `schema-usage` producer: re-derive each file's gate and its
 * `dbProvenanced` from the raw `schema-usage-candidates` fact + the provenance
 * fixed point, then re-admit and re-home the provenance-dependent references
 * (tagged-template + DB-call) and append the provenance-free references the raw
 * producer already re-homed (ORM / query-builder / collection-adapter).
 *
 * The emitted array is the legacy `extractSchemaUsage` output, byte-identical:
 * strategy (1) tagged, (2) DB-call, (4) ORM, (5) query-builder, (6)
 * collection-adapter — in that order, gated the same way, re-homed the same way.
 *
 * @param candidates the raw `schema-usage-candidates` facts (one per TS-family file)
 * @param withinFacts the `within-file-provenance` facts (TS-family)
 * @param provenance the `receiver-provenance` fixed point
 * @param activityFacts the `receiver-activity` facts
 * @param sqlDialect the corpus's named dialect, or null to skip R3
 * @returns the classified schema-usage facts (strategies 1/2/4/5/6, in order)
 */
export function classifySchemaUsage(
  candidates: readonly SchemaUsageCandidatesFact[],
  withinFacts: readonly WithinFileProvenanceFact[],
  provenance: ReceiverProvenanceFact,
  activityFacts: readonly ReceiverActivityFact[],
  sqlDialect: Dialect | null,
  declaredTypePackages: ReadonlySet<string> | undefined,
  projectRoot?: string,
  tsconfig?: TsconfigPathMap,
): SchemaUsageFact[] {
  const extracts = rehydrateWithinTsExtracts(withinFacts);
  const seeds = rehydrateReceiverProvenance(provenance);
  const activityByFile = new Map(activityFacts.map((f) => [f.file, f]));
  const resolver = makeSpecifierResolver(withinFacts, projectRoot, tsconfig);
  const heritageResolver = makeHeritageResolver(projectRoot, declaredTypePackages) ?? undefined;

  const out: SchemaUsageFact[] = [];
  for (const cand of candidates) {
    const extract = extracts.get(cand.file);
    const activity = rehydrateReceiverActivity(activityByFile.get(cand.file));
    const dbProvenanced = extract
      ? classifyBuildProvenance(extract, seeds.get(cand.file) ?? new Map(), activity.bindings, activity.r3Sites, sqlDialect)
      : new Map<string, ProvenanceEvidence>();
    if (!passesFileGateRehydrated(cand.file, cand.hasSqlTag, dbProvenanced, activity.dbActivity)) {
      continue;
    }

    const sourceCode = cand.sourceCode;
    const resolveImport = resolver ? (source: string) => resolver(source, cand.file) : undefined;

    // (1) Tagged-template SQL — re-admit by the tag's package dialect, parse.
    for (const t of cand.tagged) {
      const siteDialect = dialectForEvidence(dbProvenanced.get(t.tagName));
      const dialect = siteDialect ?? sqlDialect ?? null;
      const parsed = parseSqlTables(t.templateText, t.location, sourceCode, undefined, dialect, null);
      for (const ref of parsed.references) {
        out.push(rehomeReference(ref, cand.file, cand.functions, cand.stringFragments));
      }
    }

    // (2) DB-call patterns — re-admit via `identifyHandle`, then parse. An
    // unresolved candidate (`sqlText === null`) contributes no table references
    // here; its `unresolved` record is re-derived by `classifyUnresolvedQuerySites`.
    for (const call of cand.dbCalls) {
      if (call.sqlText === null) continue;
      const admitted = admitDbCall(call, dbProvenanced, activity.bindings, sqlDialect, extract?.interfaceFields, declaredTypePackages, resolveImport, heritageResolver);
      if (!admitted) continue;
      const parsed = parseSqlTables(call.sqlText, call.location, sourceCode, undefined, admitted.dialect, null);
      for (const ref of parsed.references) {
        out.push(rehomeReference(ref, cand.file, cand.functions, cand.stringFragments));
      }
    }

    // (4)(5)(6) ORM / query-builder / collection-adapter — re-homed raw-side.
    out.push(...cand.ormRefs, ...cand.queryBuilderRefs, ...cand.collectionAdapterRefs);
  }
  return out;
}

/**
 * Spec 70 1b — the corpus `unresolved-query` reduction. The legacy `schema-code`
 * visitor emitted `checkUnresolvedQueries` for DB-calls `findTableReferences`
 * admitted via `dbCallVerdict` (i.e. `identifyHandle` said "DB handle") but whose
 * SQL argument was held in an unresolvable identifier. The collapse re-derives
 * that surface with no AST: for each raw `schema-usage-candidates` fact, re-derive
 * `dbProvenanced` (as `classifySchemaUsage` does), re-apply the file gate, then
 * re-admit every `unresolved` candidate via `identifyHandle` — dropping any that
 * are not DB handles — and emit the `unresolved-query` site record.
 *
 * @param candidates the raw `schema-usage-candidates` facts (one per TS-family file)
 * @param withinFacts the `within-file-provenance` facts (TS-family)
 * @param provenance the `receiver-provenance` fixed point
 * @param activityFacts the `receiver-activity` facts
 * @param sqlDialect the corpus's named dialect, or null to skip R3
 * @returns the unresolved-query site records re-admitted via `identifyHandle`
 */
export function classifyUnresolvedQuerySites(
  candidates: readonly SchemaUsageCandidatesFact[],
  withinFacts: readonly WithinFileProvenanceFact[],
  provenance: ReceiverProvenanceFact,
  activityFacts: readonly ReceiverActivityFact[],
  sqlDialect: Dialect | null,
  declaredTypePackages: ReadonlySet<string> | undefined,
  projectRoot?: string,
  tsconfig?: TsconfigPathMap,
): UnresolvedQuerySite[] {
  const extracts = rehydrateWithinTsExtracts(withinFacts);
  const seeds = rehydrateReceiverProvenance(provenance);
  const activityByFile = new Map(activityFacts.map((f) => [f.file, f]));
  const resolver = makeSpecifierResolver(withinFacts, projectRoot, tsconfig);
  const heritageResolver = makeHeritageResolver(projectRoot, declaredTypePackages) ?? undefined;

  const out: UnresolvedQuerySite[] = [];
  for (const cand of candidates) {
    const extract = extracts.get(cand.file);
    const activity = rehydrateReceiverActivity(activityByFile.get(cand.file));
    const dbProvenanced = extract
      ? classifyBuildProvenance(extract, seeds.get(cand.file) ?? new Map(), activity.bindings, activity.r3Sites, sqlDialect)
      : new Map<string, ProvenanceEvidence>();
    if (!passesFileGateRehydrated(cand.file, cand.hasSqlTag, dbProvenanced, activity.dbActivity)) {
      continue;
    }

    const resolveImport = resolver ? (source: string) => resolver(source, cand.file) : undefined;
    for (const call of cand.dbCalls) {
      if (call.unresolved === null) continue;
      // Re-admit via `identifyHandle` — mirror the legacy `dbCallVerdict` gate so
      // a non-DB receiver (`page.$`, `$('.foo')`) never emits `unresolved-query`.
      const admitted = admitDbCall(call, dbProvenanced, activity.bindings, sqlDialect, extract?.interfaceFields, declaredTypePackages, resolveImport, heritageResolver);
      if (!admitted) continue;
      out.push({ file: cand.file, identifier: call.unresolved.identifier, location: call.unresolved.location });
    }
  }
  return out;
}

// ── `data-access-calls` + `loop-queries` reductions ──────────────────────────

/** The handle-verdict identity shared by both remaining receiver consumers —
 *  the corpus-side mirror of `handleVerdictForCall`'s `CallSite`, folded from the
 *  raw candidate's `handle*` fields. `format` is carried (loop candidates are
 *  TS-only; data-access candidates carry the raw producer's `format`). */
interface HandleIdentity {
  readonly format: 'typescript' | 'go';
  readonly calleeType: 'identifier' | 'member' | null;
  readonly name: string | null;
  readonly root: string | null;
  readonly receiver: string | null;
  readonly method: string | null;
  readonly thisField: boolean;
  readonly thisHeritage: string | null;
  readonly sqlArg: string | null;
  readonly siteReceiver: string | null;
}

/** The identity of one data-access-call candidate (the `handle*` fields). */
function dataAccessIdentity(cand: DataAccessCallCandidate): HandleIdentity {
  return {
    format: cand.format,
    calleeType: cand.handleCalleeType,
    name: cand.handleName,
    root: cand.handleRoot,
    receiver: cand.handleReceiver,
    method: cand.handleMethod,
    thisField: cand.handleThisField,
    thisHeritage: cand.handleThisHeritage,
    sqlArg: cand.handleSqlArg,
    siteReceiver: cand.handleSiteReceiver,
  };
}

/** The identity of one loop-query candidate (TS-only; `sqlArg` is the handle
 *  SQL-argument source, `handleSiteReceiver` the site-dialect receiver). */
function loopQueryIdentity(cand: LoopQueryRawCandidate): HandleIdentity {
  return {
    format: 'typescript',
    calleeType: cand.handleCalleeType,
    name: cand.handleName,
    root: cand.handleRoot,
    receiver: cand.handleReceiver,
    method: cand.handleMethod,
    thisField: cand.handleThisField,
    thisHeritage: cand.handleThisHeritage,
    sqlArg: cand.sqlArg,
    siteReceiver: cand.handleSiteReceiver,
  };
}

/**
 * The corpus-side mirror of `handleVerdictForCall` — re-fold `identifyHandle`
 * over the re-derived `dbProvenanced` + rehydrated bindings (TS) or the Go
 * resolution env (Go). The raw producer already applied every structural gate
 * (callee shape, method/root gate, template → enclosing-call resolution), so the
 * identity is already narrowed to a query-shaped call; what remains is the
 * provenance-dependent gate the identifier arm alone carries (a bare name that is
 * neither provenanced nor type-annotated is rejected before `identifyHandle`) and
 * the verdict itself. Returns the tri-state verdict, or null when the shape is
 * not query-shaped.
 */
/** A stable string key for one candidate's handle identity, for the shared
 *  verdict cache. `sqlArg` and `siteReceiver` are part of the key because both
 *  feed `identifyHandle` (the SQL-argument parse and the site-dialect parse). */
function handleIdentityKey(id: HandleIdentity): string {
  return [
    id.format,
    id.calleeType ?? '',
    id.name ?? '',
    id.root ?? '',
    id.receiver ?? '',
    id.method ?? '',
    id.thisField ? '1' : '0',
    id.thisHeritage ?? '',
    id.sqlArg ?? '',
    id.siteReceiver ?? '',
  ].join('\u0000');
}

function reFoldHandleVerdict(
  id: HandleIdentity,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>,
  bindings: ReadonlyMap<string, Binding>,
  goEnv: GoResolutionEnv | undefined,
  sqlDialect: Dialect | null,
  interfaceFields: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined,
  declaredTypePackages: ReadonlySet<string> | undefined,
  resolveImport: SpecifierResolver | undefined,
  resolveHeritageField: HeritageFieldResolver | undefined,
  file: string,
  verdictCache: Map<string, HandleVerdict | null> | undefined,
): HandleVerdict | null {
  const key = verdictCache ? `${file}\u0000${handleIdentityKey(id)}` : null;
  if (key !== null) {
    const hit = verdictCache!.get(key);
    if (hit !== undefined) return hit;
  }
  const result = foldHandleVerdict(id, dbProvenanced, bindings, goEnv, sqlDialect, interfaceFields, declaredTypePackages, resolveImport, resolveHeritageField);
  if (key !== null) verdictCache!.set(key, result);
  return result;
}

function foldHandleVerdict(
  id: HandleIdentity,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>,
  bindings: ReadonlyMap<string, Binding>,
  goEnv: GoResolutionEnv | undefined,
  sqlDialect: Dialect | null,
  interfaceFields: ReadonlyMap<string, ReadonlyMap<string, string>> | undefined,
  declaredTypePackages: ReadonlySet<string> | undefined,
  resolveImport: SpecifierResolver | undefined,
  resolveHeritageField: HeritageFieldResolver | undefined,
): HandleVerdict | null {
  if (id.format === 'go') {
    if (!goEnv || id.calleeType !== 'member' || !id.root || !id.method) return null;
    return identifyHandle(
      {
        format: 'go',
        root: id.root,
        receiver: id.receiver ?? id.root,
        method: id.method,
        sqlArgument: id.sqlArg,
        thisField: false,
      },
      {
        imports: new Map(),
        typeAnnotations: new Map(),
        bindings: new Map(),
        withinFileProvenance: new Map(),
        sqlDialect: sqlDialect ?? null,
        resolution: { dialect: 'go', env: goEnv },
      },
    );
  }

  if (id.calleeType === 'identifier') {
    const name = id.name;
    if (!name) return null;
    const binding = bindings.get(name);
    const isProvenanced = dbProvenanced.has(name);
    const isTypeAnnotated =
      !!binding &&
      (binding.kind === 'variable' || binding.kind === 'field' || binding.kind === 'parameter') &&
      !!binding.typeText;
    if (!isProvenanced && !isTypeAnnotated) return null;
    const dialect = dialectForEvidence(dbProvenanced.get(name)) ?? sqlDialect ?? null;
    const env = { provenance: dbProvenanced, bindings, interfaceFields, declaredTypePackages, resolveImport, resolveHeritageField, adapter: undefined, sourceCode: '' } as unknown as RootResolutionEnv;
    return identifyHandle(
      {
        format: 'typescript',
        root: name,
        receiver: name,
        method: name,
        sqlArgument: id.sqlArg,
        thisField: false,
      },
      {
        imports: new Map(),
        typeAnnotations: new Map(),
        bindings: new Map(),
        withinFileProvenance: new Map(),
        sqlDialect: dialect,
        resolution: { dialect: 'ts', env },
      },
    );
  }

  if (id.calleeType === 'member') {
    if (!id.root || !id.method) return null;
    const dialect = resolveSiteDialectFromReceiver(id.siteReceiver, dbProvenanced) ?? sqlDialect ?? null;
    const env = { provenance: dbProvenanced, bindings, interfaceFields, declaredTypePackages, resolveImport, resolveHeritageField, adapter: undefined, sourceCode: '' } as unknown as RootResolutionEnv;
    return identifyHandle(
      {
        format: 'typescript',
        root: id.root,
        receiver: id.receiver ?? id.root,
        method: id.method,
        sqlArgument: id.sqlArg,
        thisField: id.thisField,
        thisHeritage: id.thisHeritage,
      },
      {
        imports: new Map(),
        typeAnnotations: new Map(),
        bindings: new Map(),
        withinFileProvenance: new Map(),
        sqlDialect: dialect,
        resolution: { dialect: 'ts', env },
      },
    );
  }

  return null;
}

/** The corpus-side mirror of `classifyCallType` (private in the analyzer): a
 *  non-decision label — `sql` for a raw SQL query, `orm` for a query-builder
 *  shape, `unknown` otherwise. No rule reads it. */
function classifyCallType(isSqlQuery: boolean, isOrmCall: boolean): string {
  if (isSqlQuery) return 'sql';
  if (isOrmCall) return 'orm';
  return 'unknown';
}

/** The corpus-side mirror of `nextSymbol` (private in the analyzer): the next
 *  stable per-file symbol key for a (function, method) pair. */
function nextSymbol(fnName: string, method: string, ordinals: Map<string, number>): string {
  const base = `${fnName}:${method}`;
  const ordinal = (ordinals.get(base) ?? 0) + 1;
  ordinals.set(base, ordinal);
  return ordinal > 1 ? `${base}:${ordinal}` : base;
}

/** Re-fold one candidate into a resolved query, mirroring `buildDatabaseCall`
 *  byte-identically over the pre-extracted provenance-free fields plus the
 *  already-re-folded handle verdict. */
function buildDataAccessCall(
  cand: DataAccessCallCandidate,
  verdict: HandleVerdict | null,
  dbProvenanced: ReadonlyMap<string, ProvenanceEvidence>,
  sqlDialect: Dialect | null,
  learnedWrappers: ReadonlySet<string>,
): ResolvedQuery | null {
  // A call_expression rediscovered via its template argument is dropped in favour
  // of the template (path 2).
  if (cand.skipCallForTemplateArg) return null;

  const sqlArg = cand.sqlArg;
  // `resolveSiteDialect` reads the node's *own* callee — the `site*` identity —
  // distinct from the handle verdict's enclosing-call identity.
  const siteDialect =
    cand.siteCalleeType === 'identifier'
      ? cand.siteName
        ? dialectForEvidence(dbProvenanced.get(cand.siteName))
        : null
      : resolveSiteDialectFromReceiver(cand.siteReceiver, dbProvenanced);
  const dialect = siteDialect ?? sqlDialect ?? null;
  const parsed = sqlArg !== null ? parseSql(sqlArg, dialect ?? DEFAULT_SQL_DIALECT) : null;
  const sqlOk = parsed && parsed.ok ? parsed : null;

  const isOrmCall = cand.isOrmCall;
  const isTaggedSqlCall = cand.isTaggedSqlCall;
  const handleAdmits = verdict !== null && verdict.kind !== 'not-handle';
  const isSqlPosition = handleAdmits || cand.isQueryBuilderShape;
  const isSqlQuery = sqlOk !== null || isSqlPosition || isTaggedSqlCall;

  if (!isSqlQuery && !isOrmCall) return null;

  const sqlAstNode = sqlOk ? sqlOk.ast : null;
  const builderVerb = sqlAstNode ? null : cand.builderVerb;

  const sqlTables = sqlAstNode ? extractTableNames(sqlAstNode) : [];
  const ormTables = isOrmCall ? cand.ormTables : [];
  const tables = [...new Set([...sqlTables, ...ormTables])];

  const facts = sqlAstNode ? whereFacts(sqlAstNode) : null;
  const hasFilter =
    (facts
      ? (facts.hasWhere && !facts.whereIsTautology) || facts.hasHaving || facts.hasLimit
      : false) ||
    (isOrmCall && cand.ormHasFilter);

  // Security: static arms 1–3 ran raw-side; arm 4 (a learned DB wrapper carrying
  // bind params) is the one cross-file dependency, corrected here.
  let security = {
    parameterized: cand.staticParameterized,
    injectionRisk: cand.staticInjectionRisk,
    escaped: cand.staticEscaped,
  };
  if (cand.arm4CalleeName && learnedWrappers.has(cand.arm4CalleeName)) {
    security = { parameterized: true, injectionRisk: false, escaped: false };
  }
  const injectionRisk = security.injectionRisk && verdict?.kind === 'handle';

  return {
    type: classifyCallType(isSqlQuery, isOrmCall),
    method: cand.method,
    file: cand.file,
    line: cand.line,
    column: cand.column,
    tables,
    queryText: cand.nodeText,
    hasOrganizationFilter: cand.hasOrganizationFilter,
    hasFilter,
    isWrite: sqlAstNode ? isWriteStatement(sqlAstNode) : builderVerb !== null,
    isMassWrite: sqlAstNode ? isMassWriteStatement(sqlAstNode) : builderVerb === 'update',
    isUpsert: sqlAstNode
      ? isUpsertStatement(sqlAstNode) || sqlOk?.conflictClauseTruncated === true
      : false,
    isRawInsert: sqlAstNode ? (sqlAstNode.type === 'insert' || sqlAstNode.type === 'replace') : false,
    insertColumns: sqlAstNode ? rawInsertColumnsFromAst(sqlAstNode) : null,
    sqlWhereColumns: sqlAstNode ? [...whereColumnRefs(sqlAstNode)] : null,
    hasParameterizedQuery: security.parameterized,
    hasSqlInjectionRisk: injectionRisk,
    sqlEscaped: security.escaped,
    enclosingFunction: cand.enclosingFunction,
    resolvedWhere: cand.resolvedWhere ?? undefined,
    handleVerdict: verdict ?? undefined,
  };
}

/**
 * The corpus `data-access-calls` producer: re-derive each file's `dbProvenanced`
 * (TS via `classifyBuildProvenance`; Go via the fixed-point seed) from the raw
 * `data-access-calls-candidates` fact + the provenance fixed point, then re-fold
 * the legacy `extractDatabaseCalls` pipeline — discovery filter (`isDbCallCandidate`)
 * → line dedup (template preferred, else first in pre-order) → `buildDatabaseCall`
 * — with no AST. The dedup runs on the *discovered* set, not the built set, so a
 * discovered-but-rejected node still shadows an admitted node on the same line
 * exactly as the legacy pass did.
 *
 * @param candidates the raw `data-access-calls-candidates` facts (one per file)
 * @param withinFacts the `within-file-provenance` facts (TS + Go)
 * @param provenance the `receiver-provenance` fixed point
 * @param activityFacts the `receiver-activity` facts (TS-family only)
 * @param sqlDialect the corpus's named dialect, or null to skip R3
 * @returns the resolved DB calls, deduped and rebuilt with no AST
 */
export function classifyDataAccessCalls(
  candidates: readonly DataAccessCallCandidate[],
  withinFacts: readonly WithinFileProvenanceFact[],
  provenance: ReceiverProvenanceFact,
  activityFacts: readonly ReceiverActivityFact[],
  sqlDialect: Dialect | null,
  declaredTypePackages: ReadonlySet<string> | undefined,
  projectRoot?: string,
  tsconfig?: TsconfigPathMap,
  verdictCache?: Map<string, HandleVerdict | null>,
): ResolvedQuery[] {
  const tsExtracts = rehydrateWithinTsExtracts(withinFacts);
  const goExtracts = rehydrateWithinGoExtracts(withinFacts);
  const seeds = rehydrateReceiverProvenance(provenance);
  const activityByFile = new Map(activityFacts.map((f) => [f.file, f]));
  const resolver = makeSpecifierResolver(withinFacts, projectRoot, tsconfig);
  const heritageResolver = makeHeritageResolver(projectRoot, declaredTypePackages) ?? undefined;

  // Group candidates by file, preserving the raw fact's (input-file) order.
  const byFile = new Map<string, DataAccessCallCandidate[]>();
  for (const cand of candidates) {
    let list = byFile.get(cand.file);
    if (!list) {
      list = [];
      byFile.set(cand.file, list);
    }
    list.push(cand);
  }

  const out: ResolvedQuery[] = [];
  for (const [file, fileCands] of byFile) {
    const isGo = fileCands[0].format === 'go';
    const { dbProvenanced, bindings, goEnv, interfaceFields } = foldReceiverEnvironment({
      file, isGo, tsExtracts, goExtracts, seeds, activityByFile, sqlDialect,
    });

    const learnedWrappers = new Set(
      [...dbProvenanced.values()].filter((ev) => ev.reason === 'wrapper').map((ev) => ev.identifier),
    );

    const resolveImport = resolver ? (source: string) => resolver(source, file) : undefined;

    // 1. Discovery filter — `isDbCallCandidate`, re-folding the handle verdict.
    const discovered: { cand: DataAccessCallCandidate; verdict: HandleVerdict | null }[] = [];
    for (const cand of fileCands) {
      const verdict = reFoldHandleVerdict(dataAccessIdentity(cand), dbProvenanced, bindings, goEnv, sqlDialect, interfaceFields, declaredTypePackages, resolveImport, heritageResolver, file, verdictCache);
      const handleAdmits = verdict !== null && verdict.kind !== 'not-handle';
      const isCandidate =
        handleAdmits || cand.isQueryBuilderShape || cand.isTaggedSqlCall || cand.isVariableAssignmentSql;
      if (isCandidate) discovered.push({ cand, verdict });
    }

    // 2. Line dedup — `dedupeCandidateNodes` (template preferred, else first).
    const byLine = new Map<number, { cand: DataAccessCallCandidate; verdict: HandleVerdict | null }[]>();
    for (const d of discovered) {
      const line = d.cand.line;
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line)!.push(d);
    }
    const unique: { cand: DataAccessCallCandidate; verdict: HandleVerdict | null }[] = [];
    for (const items of byLine.values()) {
      if (items.length === 1) {
        unique.push(items[0]);
      } else {
        unique.push(items.find((it) => it.cand.isTemplateLiteral) ?? items[0]);
      }
    }

    // 3. Build — `buildDatabaseCall` over the deduped set.
    for (const { cand, verdict } of unique) {
      const built = buildDataAccessCall(cand, verdict, dbProvenanced, sqlDialect, learnedWrappers);
      if (built) out.push(built);
    }
  }
  return out;
}

/**
 * The corpus `loop-queries` producer: re-derive each file's `dbProvenanced` (TS
 * via `classifyBuildProvenance`), re-fold the strict-handle filter
 * (`isDbCallNode`'s `identifyHandle`), dedup by loop byte-offset (one finding per
 * loop, first wins), and assign the stable symbol. The provenance-free
 * discriminators already ran in the raw producer; only the three
 * provenance-dependent steps remain.
 *
 * @param candidates the raw `loop-query-candidates` facts (one per file)
 * @param withinFacts the `within-file-provenance` facts (TS-family)
 * @param provenance the `receiver-provenance` fixed point
 * @param activityFacts the `receiver-activity` facts
 * @param sqlDialect the corpus's named dialect, or null to skip R3
 * @returns the resolved loop-query facts (deduped, stable symbols assigned)
 */
export function classifyLoopQueries(
  candidates: readonly LoopQueryRawCandidate[],
  withinFacts: readonly WithinFileProvenanceFact[],
  provenance: ReceiverProvenanceFact,
  activityFacts: readonly ReceiverActivityFact[],
  sqlDialect: Dialect | null,
  declaredTypePackages: ReadonlySet<string> | undefined,
  projectRoot?: string,
  tsconfig?: TsconfigPathMap,
  verdictCache?: Map<string, HandleVerdict | null>,
): LoopQueryFact[] {
  const tsExtracts = rehydrateWithinTsExtracts(withinFacts);
  const seeds = rehydrateReceiverProvenance(provenance);
  const activityByFile = new Map(activityFacts.map((f) => [f.file, f]));
  const resolver = makeSpecifierResolver(withinFacts, projectRoot, tsconfig);
  const heritageResolver = makeHeritageResolver(projectRoot, declaredTypePackages) ?? undefined;

  const byFile = new Map<string, LoopQueryRawCandidate[]>();
  for (const cand of candidates) {
    let list = byFile.get(cand.file);
    if (!list) {
      list = [];
      byFile.set(cand.file, list);
    }
    list.push(cand);
  }

  const out: LoopQueryFact[] = [];
  for (const [file, fileCands] of byFile) {
    const extract = tsExtracts.get(file);
    const activity = rehydrateReceiverActivity(activityByFile.get(file));
    const dbProvenanced = extract
      ? classifyBuildProvenance(extract, seeds.get(file) ?? new Map(), activity.bindings, activity.r3Sites, sqlDialect)
      : new Map<string, ProvenanceEvidence>();

    const reported = new Set<string>();
    const loopOrdinals = new Map<string, number>();
    const resolveImport = resolver ? (source: string) => resolver(source, file) : undefined;
    for (const cand of fileCands) {
      const verdict = reFoldHandleVerdict(loopQueryIdentity(cand), dbProvenanced, activity.bindings, undefined, sqlDialect, extract?.interfaceFields, declaredTypePackages, resolveImport, heritageResolver, file, verdictCache);
      if (!verdict || verdict.kind !== 'handle') continue;

      const dedupKey = String(cand.loopStartOffset);
      if (reported.has(dedupKey)) continue;
      reported.add(dedupKey);

      const symbol = nextSymbol(cand.enclosingFunction, 'loop-query', loopOrdinals);
      out.push({
        file: cand.file,
        line: cand.line,
        column: cand.column,
        symbol,
        loopLine: cand.loopLine,
        depth: cand.depth,
      });
    }
  }
  return out;
}

// ── `unproven-query-receivers` reduction (Spec 70 2c) ────────────────────────

/**
 * The corpus `unproven-query-receivers` reduction (Spec 70 2c) — the fifth
 * receiver consumer, re-derived from the raw `data-access-calls-candidates` fact
 * + the provenance fixed point with no AST. It re-folds `identifyHandle` per
 * member candidate and emits an `UnprovenQueryReceiver` when the verdict is
 * `unproven` and the call is query-shaped — mirroring the pre-pass's candidacy
 * filter (language-independent string-arg, the SQL literal as admission proof)
 * and its `root === null` skip (re-folded
 * via `reFoldHandleVerdict`'s null on a missing root). This is the source for the
 * `cannot-fire` coverage diagnostic, re-homed from `collectCannotFireDiagnostics`
 * (which read the pre-pass's `unprovenQueryReceivers`).
 *
 * @param candidates the raw `data-access-calls-candidates` facts (one per file)
 * @param withinFacts the `within-file-provenance` facts (TS + Go)
 * @param provenance the `receiver-provenance` fixed point
 * @param activityFacts the `receiver-activity` facts (TS-family only)
 * @param sqlDialect the corpus's named dialect, or null
 * @returns the unproven query-receiver records, deduped and rebuilt
 */
export function classifyUnprovenQueryReceivers(
  candidates: readonly DataAccessCallCandidate[],
  withinFacts: readonly WithinFileProvenanceFact[],
  provenance: ReceiverProvenanceFact,
  activityFacts: readonly ReceiverActivityFact[],
  sqlDialect: Dialect | null,
  declaredTypePackages: ReadonlySet<string> | undefined,
  projectRoot?: string,
  tsconfig?: TsconfigPathMap,
  verdictCache?: Map<string, HandleVerdict | null>,
): UnprovenQueryReceiver[] {
  const tsExtracts = rehydrateWithinTsExtracts(withinFacts);
  const goExtracts = rehydrateWithinGoExtracts(withinFacts);
  const seeds = rehydrateReceiverProvenance(provenance);
  const activityByFile = new Map(activityFacts.map((f) => [f.file, f]));
  const resolver = makeSpecifierResolver(withinFacts, projectRoot, tsconfig);
  const heritageResolver = makeHeritageResolver(projectRoot, declaredTypePackages) ?? undefined;

  const byFile = new Map<string, DataAccessCallCandidate[]>();
  for (const cand of candidates) {
    let list = byFile.get(cand.file);
    if (!list) {
      list = [];
      byFile.set(cand.file, list);
    }
    list.push(cand);
  }

  const out: UnprovenQueryReceiver[] = [];
  for (const [file, fileCands] of byFile) {
    const isGo = fileCands[0].format === 'go';
    const { dbProvenanced, bindings, goEnv, interfaceFields } = foldReceiverEnvironment({
      file, isGo, tsExtracts, goExtracts, seeds, activityByFile, sqlDialect,
    });

    // Re-fold each member candidate to its unproven verdict, then line-dedup —
    // mirroring `classifyDataAccessCalls`'s step 2 (template preferred, else
    // first). The broadened discovery matches both the `call_expression` node and
    // its `template_string` child, so without the dedup one query-shaped site
    // emits two identical cannot-fire diagnostics and doubles the coverage count.
    const resolveImport = resolver ? (source: string) => resolver(source, file) : undefined;
    const admitted: { cand: DataAccessCallCandidate; verdict: Extract<HandleVerdict, { kind: 'unproven' }> }[] = [];
    for (const cand of fileCands) {
      const id = dataAccessIdentity(cand);
      // Candidacy filter only — mirror the pre-pass's member-callee gate (an
      // identifier callee is not a query-shaped *call site*). A member call is
      // admitted as unproven only when it carries a static SQL argument (the
      // sql-argument evidence source, `handleSqlArg`) or is genuinely query-shaped
      // (the real `isQueryBuilderShape` test, carried on the candidate) — a site
      // with neither evidence source is not a data-access site and nothing is
      // reported about it. `reFoldHandleVerdict` → `identifyHandle` re-folds the
      // same discriminant over the re-derived provenance, so a null-arg
      // `not-handle` root resolves to `not-handle` below.
      if (id.calleeType !== 'member') continue;
      if (cand.handleSqlArg === null && !cand.isQueryBuilderShape) continue;
      const verdict = reFoldHandleVerdict(id, dbProvenanced, bindings, goEnv, sqlDialect, interfaceFields, declaredTypePackages, resolveImport, heritageResolver, file, verdictCache);
      if (!verdict || verdict.kind !== 'unproven') continue;
      admitted.push({ cand, verdict });
    }

    const byLine = new Map<number, { cand: DataAccessCallCandidate; verdict: Extract<HandleVerdict, { kind: 'unproven' }> }[]>();
    for (const a of admitted) {
      const line = a.cand.line;
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line)!.push(a);
    }
    const unique: { cand: DataAccessCallCandidate; verdict: Extract<HandleVerdict, { kind: 'unproven' }> }[] = [];
    for (const items of byLine.values()) {
      unique.push(items.length === 1 ? items[0] : (items.find((it) => it.cand.isTemplateLiteral) ?? items[0]));
    }

    for (const { cand, verdict } of unique) {
      const id = dataAccessIdentity(cand);
      const receiver = id.receiver ?? id.root ?? '(unknown)';
      const root = id.root ?? receiver;
      const method = id.method ?? '';
      const reason = describeUnprovenReceiver(
        receiver,
        method,
        root,
        verdict.reason,
        cand.isQueryBuilderShape,
        isGo ? 'go' : 'typescript',
      );
      out.push({ file, line: cand.line, receiver, root, method, reason });
    }
  }
  return out;
}
