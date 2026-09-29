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
 * `needs` (today that is the one `ddl-declarations → table-catalog` edge). File
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
import type {
  CorpusContext,
  ExternalTableDecl,
  FactKind,
  FileFactKind,
  Finding,
  OracleShortfall,
  RuleDefinition,
  ThresholdValues,
  StyleDeclarationsFile,
} from './types.js';
import type { IndexHandle } from '../types.js';

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
  /** Config-declared external tables (schema analyzer's `knownTables` +
   *  `schemas`), threaded to the `table-catalog` corpus producer so its
   *  known-table set matches the legacy reducer (see {@link ExternalTableDecl}). */
  externalTables?: ReadonlyArray<ExternalTableDecl>;
  /** §6.6 — the bounded work queue's width: how many files parse/process
   *  concurrently. Defaults to 1 (serial) at this seam; the entry point sizes
   *  the pool to `max(1, cpus - 1)`. A threshold, not a selection gate: the
   *  fact merge is file-sorted, so the value never reorders findings (§6.4). */
  workerCount?: number;
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
  if (MIGRATED_RULES.length === 0) return { findings: [], incompleteFacts: new Map(), oracleShortfalls: [] };

  const active = activeRules(infra?.enabledRules);
  if (active.length === 0) return { findings: [], incompleteFacts: new Map(), oracleShortfalls: [] };

  const neededFormats = new Set<string>();
  for (const rule of active) {
    for (const f of rule.needs.formats) neededFormats.add(f);
  }
  // Widen to the formats that supply the transitively-needed *file* facts: a
  // rule names only the formats it evaluates (`needs.formats`), not the formats
  // its facts come from. `unknown-table` declares `table-catalog`, whose
  // upstream `ddl-declarations` is supplied by `sql` (migration files) as well
  // as TS/JS — so `.sql` files must be read even though no rule declares `sql`.
  for (const kind of neededFactKinds(active)) {
    const producers = (PRODUCERS as Partial<Record<FactKind, Record<string, unknown>>>)[kind];
    if (producers) for (const format of Object.keys(producers)) neededFormats.add(format);
  }

  const files: InputFile[] = [];
  for (const p of filePaths) {
    if (!neededFormats.has(formatFor(p))) continue;
    try {
      files.push({ path: p, content: await fs.readFile(p, 'utf8') });
    } catch {
      // Unreadable — the discovery layer already dropped it; skip, don't fail.
    }
  }

  return runPhaseModelOverFiles(files, thresholdsByRule, infra);
}

/**
 * The file/corpus-pipeline half, exposed for the slice tests.
 *
 * @param files - The already-read input files to parse, process, and analyze.
 * @param thresholdsByRule - The resolved per-rule threshold map.
 * @param infra - The optional corpus-level inputs (project root, index, workers).
 * @returns The migrated rules' findings and the per-file fact completeness map.
 */
export async function runPhaseModelOverFiles(
  files: readonly InputFile[],
  thresholdsByRule: ReadonlyMap<string, ThresholdValues>,
  infra?: PhaseInfra,
): Promise<PhaseModelResult> {
  const { facts, incompleteFacts, oracleShortfalls } = await buildFacts(files, infra);
  return {
    findings: await analyzeAll(facts, thresholdsByRule, infra),
    incompleteFacts,
    oracleShortfalls,
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
  // Corpus producers pull in their upstream facts (ddl-declarations → table-catalog).
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
  return needed;
}

/** Process: build every needed fact kind (file facts, then corpus facts in order). */
async function buildFacts(
  files: readonly InputFile[],
  infra?: PhaseInfra,
): Promise<{ facts: Map<FactKind, unknown>; incompleteFacts: Map<FactKind, Set<string>>; oracleShortfalls: OracleShortfall[] }> {
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
  // no file produced sees `[]`, not `undefined` (table-catalog's
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
  };
  for (const kind of corpusKinds) {
    const producer = CORPUS_PRODUCERS[kind];
    const upstream = Object.fromEntries(producer.needs.map((n) => [n, facts.get(n)]));
    facts.set(kind, producer.process(upstream as never, corpusCtx));
  }

  return { facts, incompleteFacts, oracleShortfalls };
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
  const parsed = await parseOne(input, projectRoot);
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
