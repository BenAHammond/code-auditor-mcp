/**
 * Spec 68 §11.1 — the general phase-model runner behind the both-paths split.
 *
 * `runPhaseModel` drives Parse → Process → Analyze over `MIGRATED_RULES`. The
 * three-phase ordering and the "rules read facts, never ASTs" property are
 * fixed here; §6's fan-out is realized as a bounded in-process work queue over
 * one task per file (`workerCount` on {@link PhaseInfra}), with a deterministic
 * file-sorted fact merge so `workerCount` is a tuning threshold, never a source
 * of output reordering (§6.4). Tree-sitter `parse()` is synchronous CPU-bound
 * work in one JS thread, so the queue is a structural unit rather than a
 * wall-clock parallelizer; the guarantees §6 exists to deliver — per-file
 * isolation (§3.3), byte-identical output across worker counts (§6.4), and a
 * bounded in-flight window (§6.5) — are what land here.
 *
 * The fact set is *derived* from the migrated rules' `needs`: the union of every
 * declared fact kind, transitively widened by corpus processors' upstream
 * `needs` (today that is the one `ddl-declarations → resolution` edge). File
 * facts are built by parsing each file once and running every matching
 * per-(kind, format) producer over it; corpus facts are reduced in dependency
 * order. Each rule then runs against exactly the facts it declared — no more,
 * no less — which is what makes a rule's coverage state computable (§8).
 *
 * Thresholds are resolved by the caller (§10's config surface) and passed as a
 * per-rule map; a rule with no entry reads its documented fallback. The rule's
 * own `analyze` never reaches a tree, an adapter, or a source string.
 */

import { promises as fs } from 'fs';
import { MIGRATED_RULES } from './rules/registry.js';
import { fileProducerFor, PRODUCERS, CORPUS_PRODUCERS } from './producers.js';
import { oracleShortfall } from './oracles.js';
import { formatFor, parseOne, type InputFile } from './runner.js';
import { loadTailwindConfig, tokensToStyleTokens } from '../styles/tailwindConfigLoader.js';
import { findFiles, UNREAD_STYLE_EXTENSIONS, KNOWN_SOURCE_EXTENSIONS } from '../utils/fileDiscovery.js';
import type {
  CorpusContext,
  DataAccessCallCandidate,
  ExternalTableDecl,
  FactKind,
  FileFactKind,
  Finding,
  OracleShortfall,
  ReceiverActivityFact,
  ReceiverProvenanceFact,
  RuleDefinition,
  SchemaUsageCandidatesFact,
  ThresholdValues,
  StyleDeclarationsFile,
  UnreadStyleSourceFact,
  UnresolvedImportFact,
  UnresolvedQuerySite,
  WithinFileProvenanceFact,
} from './types.js';
import type { IndexHandle } from '../types.js';
import type { UnprovenQueryReceiver } from '../analyzers/receiverResolution.js';
import type { Dialect } from '../mcp-tools/discoveryQueries.js';
import { classifyUnprovenQueryReceivers, classifyUnresolvedQuerySites } from './receiverConsumers.js';

/**
 * The result of a phase-model run: the migrated rules' findings plus the
 * per-file fact completeness map that feeds §8's fifth coverage state
 * (`incomplete`). A file is recorded against a fact kind when its parse failed
 * (no producer for that kind could run on it) or a producer threw on it (§3.3).
 */
export interface PhaseModelResult {
  findings: Finding[];
  /** Fact kind → files whose fact is incomplete (parse dropped or producer threw). */
  incompleteFacts: ReadonlyMap<FactKind, ReadonlySet<string>>;
  /** Spec 69 R1 — per-file completeness shortfalls: a counted oracle whose
   *  processor emitted fewer fragments than expected. Each record names the
   *  file, the processor, and both numbers. An empty list means every counted
   *  oracle met its expected count for every file. */
  oracleShortfalls: readonly OracleShortfall[];
  /** Spec 70 2c — the unproven query-shaped DB-call sites, re-derived corpus-side
   *  from the `data-access-calls-candidates` fact + the `receiver-provenance` fixed
   *  point with no AST. Replaces the pre-pass's `unprovenQueryReceivers` half; the
   *  `cannot-fire` coverage diagnostic is re-derived from these in the caller. Empty
   *  when `receiver-provenance` was not needed (no receiver-consuming rule active). */
  unprovenQueryReceivers: readonly UnprovenQueryReceiver[];
  /** The `receiver-provenance` fixed point's unresolved DB-looking imports — the
   *  pre-pass's `unresolvedImports` half, carried on the fact itself (never a
   *  separate pre-pass field). Empty when `receiver-provenance` was not needed. */
  unresolvedImports: readonly UnresolvedImportFact[];
  /** Spec 70 1b — the re-admitted DB-calls whose SQL argument is held in an
   *  unresolvable identifier, re-derived corpus-side from the raw
   *  `schema-usage-candidates` fact + the `receiver-provenance` fixed point with
   *  no AST (`identifyHandle` re-admits each, so only DB handles qualify). Feeds
   *  the `unresolved-query` coverage diagnostic re-homed in the caller. Empty when
   *  `schema-usage` was not needed. */
  unresolvedQuerySites: readonly UnresolvedQuerySite[];
}

/**
 * The corpus-level inputs the phase model needs beyond the file list. §8's
 * `reachability` processor reads the discovery list, virtual-module list,
 * tsconfig aliases and package.json entry points — all derived from the
 * project root — so the runner threads them here rather than leaking config
 * into the fact shapes. Every field is optional: the slice tests run a single
 * fixture with none of this, and the processor falls back to the same defaults
 * the legacy reducer did.
 */
export interface PhaseInfra {
  /** Absolute project root (Tailwind config + alias/entry resolution). */
  projectRoot?: string;
  /** True for a scoped (changed/files/git) run. Gates the full-project unread
   *  dialect walk (`.less`/`.styl`/`.sass`) to full runs only — the same
   *  `if (!scoped)` the legacy `findUnreadStyleFiles` walk carried. Absent in
   *  the slice tests (no project root, so the walk is skipped regardless). */
  scoped?: boolean;
  /** Full corpus discovery list (unfiltered) for alias resolution. */
  corpusFiles?: readonly string[];
  /** Virtual-module specifiers (config, default DEFAULT_VIRTUAL_MODULES). */
  importVirtualModules?: readonly string[];
  /** tsconfig `paths` + `baseUrl` for alias classification + resolution. */
  tsconfigAliases?: { pathPatterns?: readonly string[]; paths?: Readonly<Record<string, readonly string[]>>; baseUrl?: string };
  /** package.json entry points (facade-expanded), absolute. */
  packageEntryPoints?: readonly string[];
  /** The read-only code-index handle the index-backed corpus producers
   *  (`call-graph`) read their facts from. Optional: the slice tests run a
   *  single fixture with no index, and the producer degrades to an empty fact
   *  (matching the legacy graceful-degradation). */
  indexHandle?: IndexHandle;
  /** The migrated rule ids to run (already filtered to the enabled analyzers).
   *  Undefined runs every migrated rule — the slice-test / full-pipeline path.
   *  A scoped, analyzer-restricted audit passes its subset so disabled analyzers'
   *  facts (e.g. cross-domain's `call-graph` whole-table `functions` read) are
   *  never built. */
  enabledRules?: ReadonlySet<string>;
  /** §16.8 fault injection — a hook invoked (and awaited) before each (kind,
   *  file) producer runs. If it throws, the run treats it as that producer
   *  throwing: the file is recorded `incomplete` for `kind` and the run
   *  continues. Real runs pass none; the per-file-failure-isolation test passes
   *  a hook that throws for one file to prove a single failure does not abort
   *  the run or poison its neighbors. It may be async — the §16.5 ordering test
   *  awaits a delay for one file to seed a slow processor. */
  beforeProcess?: (kind: FactKind, file: string) => void | Promise<void>;
  /** §16.5 ordering seam — invoked (and awaited) once, before the first rule's
   *  `analyze` runs. The ordering test uses it to observe that analysis does not
   *  begin until every file has been parsed and every processor level has
   *  completed: a slow `beforeProcess` must finish before this fires. */
  beforeAnalyze?: () => void | Promise<void>;
  /** Spec 70 2b — invoked once after every file fact is merged (so the
   *  `code-block` fact is assembled) and before any corpus fact is reduced (so
   *  the `clone-pair-history` read sees the write). Named for its one job, not
   *  its timing: it persists the dry-pair history to the index. Persisting the
   *  `dry_pair_history` write (`seedDryPairs` over the `code-block` fact → the
   *  `dry_pair_history` table) is its ONLY legitimate use — a general-purpose
   *  "after file facts" hook is how declared-input discipline erodes, so this
   *  seam is deliberately single-purpose and single-consumer. Absent in the
   *  slice tests (single fixture, no index). */
  persistDryPairHistory?: (facts: ReadonlyMap<FactKind, unknown>) => void | Promise<void>;
  /** Config-declared external tables (schema analyzer's `knownTables` +
   *  `schemas`), threaded to the `resolution` corpus producer so its
   *  known-table set matches the legacy reducer (see {@link ExternalTableDecl}). */
  externalTables?: ReadonlyArray<ExternalTableDecl>;
  /** §6.6 — the bounded work queue's width: how many files parse/process
   *  concurrently. Defaults to 1 (serial) at this seam; the entry point sizes
   *  the pool to `max(1, cpus - 1)`. A threshold, not a selection gate: the
   *  fact merge is file-sorted, so the value never reorders findings (§6.4). */
  workerCount?: number;
  /** Spec 70 R1 — the corpus's named SQL dialect (or null when unnamed). Threaded
   *  to every parsed file so the `data-access-calls` producer parses SQL-content
   *  facts rather than regex. Absent in the slice tests (single fixture). */
  sqlDialect?: Dialect | null;
}

/**
 * Run the full phase model over the given absolute file paths and return the
 * migrated rules' findings. A no-op while `MIGRATED_RULES` is empty (the legacy
 * pipeline serves everything, so the tool is functionally unchanged).
 *
 * @param filePaths - The absolute file paths to read and run through the model.
 * @param thresholdsByRule - The resolved per-rule threshold map.
 * @param infra - The optional corpus-level inputs (project root, index, workers).
 * @returns The migrated rules' findings and the per-file fact completeness map.
 */
export async function runPhaseModel(
  filePaths: readonly string[],
  thresholdsByRule: ReadonlyMap<string, ThresholdValues>,
  infra?: PhaseInfra,
): Promise<PhaseModelResult> {
  if (MIGRATED_RULES.length === 0) return { findings: [], incompleteFacts: new Map(), oracleShortfalls: [], unprovenQueryReceivers: [], unresolvedImports: [], unresolvedQuerySites: [] };

  const active = activeRules(infra?.enabledRules);
  if (active.length === 0) return { findings: [], incompleteFacts: new Map(), oracleShortfalls: [], unprovenQueryReceivers: [], unresolvedImports: [], unresolvedQuerySites: [] };

  const neededFormats = new Set<string>();
  for (const rule of active) {
    for (const f of rule.needs.formats) neededFormats.add(f);
  }
  // Widen to the formats that supply the transitively-needed *file* facts: a
  // rule names only the formats it evaluates (`needs.formats`), not the formats
  // its facts come from. `unknown-table` declares `resolution`, whose
  // upstream `ddl-declarations` is supplied by `sql` (migration files) as well
  // as TS/JS — so `.sql` files must be read even though no rule declares `sql`.
  const neededKinds = neededFactKinds(active);
  for (const kind of neededKinds) {
    const producers = (PRODUCERS as Partial<Record<FactKind, Record<string, unknown>>>)[kind];
    if (producers) for (const format of Object.keys(producers)) neededFormats.add(format);
  }

  // Spec 70 — the traverse phase is now the source of the three *walk-level*
  // unread reasons (`unsupported style dialect`, `read failed`, `unsupported
  // source extension`), each byte-identical to the legacy string it replaces.
  // The content-level `<style lang="…">` reason still comes from the index
  // table (via the corpus producer), so the fact is their merge in `buildFacts`.
  const unread: UnreadStyleSourceFact[] = [];

  // Dialect walk (`.less`/`.styl`/`.sass`) — full runs only, matching the legacy
  // `if (!scoped)` around `findUnreadStyleFiles`.
  if (infra?.projectRoot && !infra.scoped && neededKinds.has('unread-style-sources')) {
    for (const p of await findFiles(infra.projectRoot, { extensions: UNREAD_STYLE_EXTENSIONS })) {
      const ext = p.slice(p.lastIndexOf('.') + 1);
      unread.push({ filePath: p, reason: `unsupported style dialect: ${ext}` });
    }
  }

  const files: InputFile[] = [];
  for (const p of filePaths) {
    // Unknown source extension → unread (the legacy `extractForFile` backstop),
    // and skip the parse — `formatFor` would map it to `typescript` and mis-parse
    // it as TS rather than leaving it unhandled.
    const ext = p.includes('.') ? p.slice(p.lastIndexOf('.')) : '';
    if (ext && !KNOWN_SOURCE_EXTENSIONS.includes(ext)) {
      unread.push({ filePath: p, reason: `unsupported source extension: ${ext}` });
      continue;
    }
    if (!neededFormats.has(formatFor(p))) continue;
    try {
      files.push({ path: p, content: await fs.readFile(p, 'utf8') });
    } catch (err) {
      // Unreadable — the traverse's own read attempt records the reason (the
      // legacy read-failure push moved here); skip, don't fail.
      unread.push({ filePath: p, reason: `read failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  return runPhaseModelOverFiles(files, thresholdsByRule, infra, unread);
}

/**
 * The file/corpus-pipeline half, exposed for the slice tests.
 *
 * @param files - The already-read input files to parse, process, and analyze.
 * @param thresholdsByRule - The resolved per-rule threshold map.
 * @param infra - The optional corpus-level inputs (project root, index, workers).
 * @param unread - The traverse phase's walk-level unread-source reasons (dialect,
 *   read-failure, unknown-extension), merged into the `unread-style-sources`
 *   fact ahead of the corpus producer's table-derived content-level reasons.
 * @returns The migrated rules' findings and the per-file fact completeness map.
 */
export async function runPhaseModelOverFiles(
  files: readonly InputFile[],
  thresholdsByRule: ReadonlyMap<string, ThresholdValues>,
  infra?: PhaseInfra,
  unread: readonly UnreadStyleSourceFact[] = [],
): Promise<PhaseModelResult> {
  const { facts, incompleteFacts, oracleShortfalls, unprovenQueryReceivers, unresolvedImports, unresolvedQuerySites } = await buildFacts(files, infra, unread);
  const findings = await analyzeAll(facts, thresholdsByRule, infra);
  return {
    findings,
    incompleteFacts,
    oracleShortfalls,
    unprovenQueryReceivers,
    unresolvedImports,
    unresolvedQuerySites,
  };
}

/** The migrated rules this run should serve: all, or the enabled subset. */
function activeRules(enabledRules?: ReadonlySet<string>): readonly RuleDefinition<any>[] {
  if (!enabledRules) return MIGRATED_RULES;
  return MIGRATED_RULES.filter((r) => enabledRules.has(r.id));
}

/** The fact kinds the migrated rules read, transitively closed over corpus `needs`. */
function neededFactKinds(active: readonly RuleDefinition<any>[] = MIGRATED_RULES): Set<FactKind> {
  const needed = new Set<FactKind>();
  for (const rule of active) {
    for (const f of rule.needs.facts) needed.add(f);
  }
  // Corpus producers pull in their upstream facts (ddl-declarations → resolution).
  let grew = true;
  while (grew) {
    grew = false;
    for (const producer of Object.values(CORPUS_PRODUCERS)) {
      if (!needed.has(producer.produces)) continue;
      for (const upstream of producer.needs) {
        if (!needed.has(upstream)) {
          needed.add(upstream);
          grew = true;
        }
      }
    }
  }
  // Spec 70 2c — `classifyUnprovenQueryReceivers` (the fifth receiver consumer)
  // reads the raw `data-access-calls-candidates` fact, which is only an upstream
  // of `data-access-calls`. When `receiver-provenance` is needed through another
  // consumer (e.g. a `loop-queries`-only run) but `data-access-calls` is not, that
  // candidate fact would be absent and the cannot-fire surface would silently read
  // empty — matching the pre-pass, which always scanned for unproven receivers
  // whenever any receiver consumer was present.
  if (needed.has('receiver-provenance')) needed.add('data-access-calls-candidates');
  return needed;
}

/** Process: build every needed fact kind (file facts, then corpus facts in order). */
async function buildFacts(
  files: readonly InputFile[],
  infra?: PhaseInfra,
  unread: readonly UnreadStyleSourceFact[] = [],
): Promise<{ facts: Map<FactKind, unknown>; incompleteFacts: Map<FactKind, Set<string>>; oracleShortfalls: OracleShortfall[]; unprovenQueryReceivers: UnprovenQueryReceiver[]; unresolvedImports: UnresolvedImportFact[]; unresolvedQuerySites: UnresolvedQuerySite[] }> {
  const projectRoot = infra?.projectRoot;
  const active = activeRules(infra?.enabledRules);
  const needed = neededFactKinds(active);
  const facts = new Map<FactKind, unknown>();
  const incompleteFacts = new Map<FactKind, Set<string>>();
  const oracleShortfalls: OracleShortfall[] = [];

  const fileKinds = [...needed].filter(
    (k): k is FileFactKind => Object.prototype.hasOwnProperty.call(PRODUCERS, k),
  );

  // Every needed file fact starts empty so a corpus producer whose upstream
  // no file produced sees `[]`, not `undefined` (resolution's
  // ddl-declarations edge on a corpus with no code DDL — e.g. a styles-only
  // audit, or DDL declared in .sql migrations the code parser never sees).
  for (const kind of fileKinds) {
    facts.set(kind, []);
  }

  /** Record `file` against `kind` in the per-file completeness map (§3.3). */
  const markIncomplete = (kind: FactKind, file: string) => {
    let set = incompleteFacts.get(kind);
    if (!set) {
      set = new Set();
      incompleteFacts.set(kind, set);
    }
    set.add(file);
  };

  // §6.1 — one parse + per-file process is a single task per file. Each task
  // returns that file's fact fragments (and its incomplete (kind) list); the
  // parent merges them in file order. A bounded queue runs at most `workerCount`
  // files in flight (§6.5). `workerCount` is a threshold, not a selection gate:
  // the merge is file-sorted, so the fact arrays — and every finding derived
  // from them — are byte-identical regardless of how wide the queue is (§6.4).
  //
  // §3.3 per-file failure isolation: a failed parse marks every file fact kind
  // that would have been produced from this file's format `incomplete`; a
  // throwing producer marks just that (kind, file) pair. Either way the run
  // continues — the failure is observable in §8's coverage, not a dropped file
  // (which would read `clean`, a false negative) and not an aborted run.
  const workerCount = Math.max(1, infra?.workerCount ?? 1);
  const perFile = await mapWithConcurrency(
    files,
    (input) => processFile(input, fileKinds, projectRoot, infra),
    workerCount,
  );

  // Deterministic merge: file-sorted so the parent's write order (and thus every
  // rule's input and output) never depends on completion order.
  const ordered = [...perFile].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const r of ordered) {
    for (const [kind, items] of r.fragments) {
      const acc = (facts.get(kind) as unknown[] | undefined) ?? [];
      acc.push(...items);
      facts.set(kind, acc);
    }
    for (const kind of r.incomplete) markIncomplete(kind, r.file);
    oracleShortfalls.push(...r.shortfalls);
  }

  // Corpus-level Tailwind theme tokens (Spec 68 §3.2): the legacy pipeline
  // stores these in `style_tokens` alongside the per-file CSS custom properties
  // during index sync. The phase fact has no index, so merge them here as a
  // synthetic declaration-free fragment. `tokensToStyleTokens` on a project with
  // no Tailwind config yields `filePath: 'built-in defaults'`, which
  // `buildTokenValueMap` / `buildDeclaredScale` both exclude — so the merge is a
  // no-op for plain-CSS projects and load-bearing only when a real config
  // declares a color/spacing/font-size scale.
  if (projectRoot && needed.has('style-declarations')) {
    const twTokens = tokensToStyleTokens(loadTailwindConfig(projectRoot), projectRoot);
    if (twTokens.length > 0) {
      const acc = (facts.get('style-declarations') as StyleDeclarationsFile[] | undefined) ?? [];
      acc.push({ declarations: [], tokens: twTokens, classUsage: [] });
      facts.set('style-declarations', acc);
    }
  }

  // Spec 70 2b — the dry-pair seed write: after the file facts are merged (the
  // `code-block` fact is complete) but before the corpus facts reduce (so
  // `clone-pair-history` reads the freshly-written `dry_pair_history` rows, the
  // same write-before-read ordering `persistDryPairs`-then-`runPhaseModel` had).
  await infra?.persistDryPairHistory?.(facts);

  // Corpus facts, reduced from upstream facts (single shallow level today).
  const corpusKinds = [...needed].filter(
    (k): k is keyof typeof CORPUS_PRODUCERS =>
      Object.prototype.hasOwnProperty.call(CORPUS_PRODUCERS, k),
  );
  const corpusCtx: CorpusContext = {
    projectRoot: infra?.projectRoot,
    corpusFiles: infra?.corpusFiles,
    virtualModules: infra?.importVirtualModules,
    tsconfigAliases: infra?.tsconfigAliases,
    packageEntryPoints: infra?.packageEntryPoints,
    indexHandle: infra?.indexHandle,
    externalTables: infra?.externalTables,
    sqlDialect: infra?.sqlDialect,
  };
  // §5 DAG — topological sort. A corpus producer's `needs` may reference other
  // corpus kinds (e.g. the four receiver consumers depend on `receiver-provenance`,
  // which itself depends on file facts). File-fact needs are already satisfied by
  // the per-file pass above; only the corpus→corpus edges require ordering, so the
  // sort runs over `corpusKinds` alone (a `needs` entry naming a file fact is
  // simply already present in `facts`). Kahn's algorithm; a cycle falls back to
  // the unsorted order rather than looping (no cycle exists in the declared DAG).
  const sortedCorpusKinds = topoSortCorpusKinds(corpusKinds);
  for (const kind of sortedCorpusKinds) {
    const producer = CORPUS_PRODUCERS[kind];
    const upstream = Object.fromEntries(producer.needs.map((n) => [n, facts.get(n)]));
    facts.set(kind, producer.process(upstream as never, corpusCtx));
  }

  // Spec 70 — merge the traverse phase's walk-level unread reasons ahead of the
  // corpus producer's table-derived content-level reasons (`<style lang>`). The
  // walk-level half is the traverse's own read/dialect record; the table half is
  // what `syncStyleIndex` still persists for embedded style blocks.
  if (needed.has('unread-style-sources')) {
    const table = (facts.get('unread-style-sources') as UnreadStyleSourceFact[] | undefined) ?? [];
    facts.set('unread-style-sources', [...unread, ...table]);
  }

  // Spec 70 2c — the fifth receiver consumer (a plain reduction, not a registry
  // fact kind): re-derive the unproven query-shaped call sites from the raw
  // `data-access-calls-candidates` fact + the `receiver-provenance` fixed point,
  // and surface the fixed point's unresolved imports. Both replace the deleted
  // pre-pass's `unprovenQueryReceivers` / `unresolvedImports` halves; they exist
  // only to feed the `cannot-fire` coverage diagnostic (re-homed in the caller),
  // never a rule's declared facts.
  let unprovenQueryReceivers: UnprovenQueryReceiver[] = [];
  let unresolvedImports: UnresolvedImportFact[] = [];
  let unresolvedQuerySites: UnresolvedQuerySite[] = [];
  const receiverProvenanceFact = facts.get('receiver-provenance') as ReceiverProvenanceFact | undefined;
  if (receiverProvenanceFact) {
    unresolvedImports = [...receiverProvenanceFact.unresolvedImports];
    unprovenQueryReceivers = classifyUnprovenQueryReceivers(
      (facts.get('data-access-calls-candidates') as DataAccessCallCandidate[] | undefined) ?? [],
      (facts.get('within-file-provenance') as WithinFileProvenanceFact[] | undefined) ?? [],
      receiverProvenanceFact,
      (facts.get('receiver-activity') as ReceiverActivityFact[] | undefined) ?? [],
      infra?.sqlDialect ?? null,
    );
    // Spec 70 1b — the `unresolved-query` half (a third coverage signal, alongside
    // the two above): re-derive the re-admitted unresolvable-SQL DB-calls from the
    // raw `schema-usage-candidates` fact + the provenance fixed point. Only runs
    // when `schema-usage` was needed (its raw fact is present); otherwise empty.
    const schemaUsageCandidates = facts.get('schema-usage-candidates') as SchemaUsageCandidatesFact[] | undefined;
    if (schemaUsageCandidates) {
      unresolvedQuerySites = classifyUnresolvedQuerySites(
        schemaUsageCandidates,
        (facts.get('within-file-provenance') as WithinFileProvenanceFact[] | undefined) ?? [],
        receiverProvenanceFact,
        (facts.get('receiver-activity') as ReceiverActivityFact[] | undefined) ?? [],
        infra?.sqlDialect ?? null,
      );
    }
  }

  return { facts, incompleteFacts, oracleShortfalls, unprovenQueryReceivers, unresolvedImports, unresolvedQuerySites };
}

/**
 * §5 DAG — topological sort over the corpus kinds requested, so a corpus producer
 * whose `needs` names another corpus kind runs after it. A `needs` entry naming a
 * file fact is ignored here (file facts are already in `facts` by the time corpus
 * producers run). Kahn's algorithm keyed on the `CORPUS_PRODUCERS[].needs` edges;
 * the result preserves the input order among independent kinds (the determinism
 * anchor), and a cycle (none exists in the declared DAG) falls back to the input
 * order rather than looping forever.
 */
function topoSortCorpusKinds(
  kinds: readonly (keyof typeof CORPUS_PRODUCERS)[],
): (keyof typeof CORPUS_PRODUCERS)[] {
  const corpusSet = new Set<string>(kinds as readonly string[]);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const kind of kinds) inDegree.set(kind, 0);
  for (const kind of kinds) {
    for (const need of CORPUS_PRODUCERS[kind].needs) {
      if (!corpusSet.has(need)) continue; // file fact — already satisfied.
      inDegree.set(kind, (inDegree.get(kind) ?? 0) + 1);
      const list = dependents.get(need) ?? [];
      list.push(kind);
      dependents.set(need, list);
    }
  }

  // Seed the queue with the zero-in-degree kinds in input order (stability).
  const queue: string[] = kinds.filter((k) => (inDegree.get(k) ?? 0) === 0);
  const sorted: string[] = [];
  while (queue.length > 0) {
    const kind = queue.shift()!;
    sorted.push(kind);
    for (const dep of dependents.get(kind) ?? []) {
      const next = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, next);
      if (next === 0) queue.push(dep);
    }
  }
  // A cycle leaves some kinds unsorted; fall back to the input order for them.
  if (sorted.length !== kinds.length) return [...kinds];
  return sorted as (keyof typeof CORPUS_PRODUCERS)[];
}

/** §6.5 — bounded work queue: run `fn` over `items` with at most `limit` in
 *  flight, returning results in input order. With `limit === 1` this is exactly
 *  a serial loop; with `limit > 1` the queue never holds more than `limit`
 *  in-flight tasks, so a huge repository does not materialize a wall of
 *  concurrent parses. Input order is preserved in the result array, so the
 *  caller's file-sorted merge is the single determinism anchor. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** §6.1 — one task per file: parse once, run every matching per-(kind, format)
 *  producer, free the tree, and return the file's fact fragments plus its
 *  incomplete (kind) list. The tree never leaves this function (Fact 8), and a
 *  parse failure or throwing producer is scoped to this file — the parent
 *  records `incomplete` rather than aborting (§3.3). */
async function processFile(
  input: InputFile,
  fileKinds: readonly FileFactKind[],
  projectRoot: string | undefined,
  infra?: PhaseInfra,
): Promise<{ file: string; fragments: Map<FileFactKind, unknown[]>; incomplete: FileFactKind[]; shortfalls: OracleShortfall[] }> {
  let parsed = await parseOne(input, projectRoot);
  // Spec 70 R1 — attach the corpus dialect to the parsed file so the
  // data-access producer's SQL facts parse rather than regex.
  if (parsed && infra?.sqlDialect) {
    parsed = { ...parsed, sqlDialect: infra.sqlDialect };
  }
  const fragments = new Map<FileFactKind, unknown[]>();
  const incomplete: FileFactKind[] = [];
  const shortfalls: OracleShortfall[] = [];

  if (!parsed) {
    const format = formatFor(input.path);
    for (const kind of fileKinds) {
      if (fileProducerFor(kind, format)) incomplete.push(kind);
    }
    return { file: input.path, fragments, incomplete, shortfalls };
  }

  try {
    for (const kind of fileKinds) {
      const producer = fileProducerFor(kind, parsed.format);
      if (!producer) continue;
      try {
        await infra?.beforeProcess?.(kind, input.path);
        const emitted = producer.process(parsed) as unknown[];
        const acc = fragments.get(kind) ?? [];
        acc.push(...emitted);
        fragments.set(kind, acc);
        const sf = oracleShortfall(producer.oracle, parsed, emitted, producer.id);
        if (sf) shortfalls.push(sf);
      } catch {
        incomplete.push(kind);
      }
    }
  } finally {
    parsed.ast?.dispose?.();
  }
  return { file: input.path, fragments, incomplete, shortfalls };
}

/** Analyze: run every active migrated rule against exactly its declared facts.
 *  `beforeAnalyze` fires once before the first rule, after `buildFacts` has
 *  completed for every file and every processor level — the §16.5 ordering
 *  observation point. */
async function analyzeAll(
  facts: Map<FactKind, unknown>,
  thresholdsByRule: ReadonlyMap<string, ThresholdValues>,
  infra?: PhaseInfra,
): Promise<Finding[]> {
  await infra?.beforeAnalyze?.();
  const findings: Finding[] = [];
  for (const rule of activeRules(infra?.enabledRules)) {
    const ruleFacts = Object.fromEntries(
      rule.needs.facts.map((f: FactKind) => [f, facts.get(f)]),
    );
    const ctx = {
      facts: ruleFacts,
      formats: rule.needs.formats,
      thresholds: thresholdsByRule.get(rule.id) ?? {},
    };
    findings.push(...(await rule.analyze(ctx as never) as readonly Finding[]));
  }
  return findings;
}
