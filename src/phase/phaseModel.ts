/**
 * Spec 68 §11.1 — the general phase-model runner behind the both-paths split.
 *
 * `runPhaseModel` drives Parse → Process → Analyze over `MIGRATED_RULES`. It is
 * the in-process precursor to the §6 distributed runner: the three-phase
 * ordering and the "rules read facts, never ASTs" property are fixed here; the
 * bounded work queue, parent/worker split and index-backed facts land in §6.
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
import { formatFor, parseOne, type InputFile } from './runner.js';
import { loadTailwindConfig, tokensToStyleTokens } from '../styles/tailwindConfigLoader.js';
import type {
  CorpusContext,
  FactKind,
  FileFactKind,
  Finding,
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
  /** §16.8 fault injection — a hook invoked before each (kind, file) producer
   *  runs. If it throws, the run treats it as that producer throwing: the file
   *  is recorded `incomplete` for `kind` and the run continues. Real runs pass
   *  none; the per-file-failure-isolation test passes a hook that throws for one
   *  file to prove a single failure does not abort the run or poison its
   *  neighbors. */
  beforeProcess?: (kind: FactKind, file: string) => void;
}

/**
 * Run the full phase model over the given absolute file paths and return the
 * migrated rules' findings. A no-op while `MIGRATED_RULES` is empty (the legacy
 * pipeline serves everything, so the tool is functionally unchanged).
 */
export async function runPhaseModel(
  filePaths: readonly string[],
  thresholdsByRule: ReadonlyMap<string, ThresholdValues>,
  infra?: PhaseInfra,
): Promise<PhaseModelResult> {
  if (MIGRATED_RULES.length === 0) return { findings: [], incompleteFacts: new Map() };

  const active = activeRules(infra?.enabledRules);
  if (active.length === 0) return { findings: [], incompleteFacts: new Map() };

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

/** The file/corpus-pipeline half, exposed for the slice tests. */
export async function runPhaseModelOverFiles(
  files: readonly InputFile[],
  thresholdsByRule: ReadonlyMap<string, ThresholdValues>,
  infra?: PhaseInfra,
): Promise<PhaseModelResult> {
  const { facts, incompleteFacts } = await buildFacts(files, infra);
  return {
    findings: await analyzeAll(facts, thresholdsByRule, infra?.enabledRules),
    incompleteFacts,
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
): Promise<{ facts: Map<FactKind, unknown>; incompleteFacts: Map<FactKind, Set<string>> }> {
  const projectRoot = infra?.projectRoot;
  const active = activeRules(infra?.enabledRules);
  const needed = neededFactKinds(active);
  const facts = new Map<FactKind, unknown>();
  const incompleteFacts = new Map<FactKind, Set<string>>();

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

  // Per-file facts: one parse per file, every matching producer runs over it,
  // the tree is freed before the next file (it never crosses the boundary).
  //
  // §3.3 per-file failure isolation: a failed parse marks every file fact kind
  // that would have been produced from this file's format `incomplete`; a
  // throwing producer marks just that (kind, file) pair. Either way the run
  // continues — the failure is observable in §8's coverage, not a dropped file
  // (which would read `clean`, a false negative) and not an aborted run.
  for (const input of files) {
    const parsed = await parseOne(input, projectRoot);
    if (!parsed) {
      const format = formatFor(input.path);
      for (const kind of fileKinds) {
        if (fileProducerFor(kind, format)) markIncomplete(kind, input.path);
      }
      continue;
    }
    try {
      for (const kind of fileKinds) {
        const producer = fileProducerFor(kind, parsed.format);
        if (!producer) continue;
        try {
          infra?.beforeProcess?.(kind, input.path);
          const acc = (facts.get(kind) as unknown[] | undefined) ?? [];
          acc.push(...(producer.process(parsed) as unknown[]));
          facts.set(kind, acc);
        } catch {
          markIncomplete(kind, input.path);
        }
      }
    } finally {
      parsed.ast?.dispose?.();
    }
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
  };
  for (const kind of corpusKinds) {
    const producer = CORPUS_PRODUCERS[kind];
    const upstream = Object.fromEntries(producer.needs.map((n) => [n, facts.get(n)]));
    facts.set(kind, producer.process(upstream as never, corpusCtx));
  }

  return { facts, incompleteFacts };
}

/** Analyze: run every active migrated rule against exactly its declared facts. */
async function analyzeAll(
  facts: Map<FactKind, unknown>,
  thresholdsByRule: ReadonlyMap<string, ThresholdValues>,
  enabledRules?: ReadonlySet<string>,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const rule of activeRules(enabledRules)) {
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
