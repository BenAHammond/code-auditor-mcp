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
  FactKind,
  FileFactKind,
  Finding,
  ThresholdValues,
  StyleDeclarationsFile,
} from './types.js';

/**
 * Run the full phase model over the given absolute file paths and return the
 * migrated rules' findings. A no-op while `MIGRATED_RULES` is empty (the legacy
 * pipeline serves everything, so the tool is functionally unchanged).
 */
export async function runPhaseModel(
  filePaths: readonly string[],
  thresholdsByRule: ReadonlyMap<string, ThresholdValues>,
  projectRoot?: string,
): Promise<Finding[]> {
  if (MIGRATED_RULES.length === 0) return [];

  const neededFormats = new Set<string>();
  for (const rule of MIGRATED_RULES) {
    for (const f of rule.needs.formats) neededFormats.add(f);
  }
  // Widen to the formats that supply the transitively-needed *file* facts: a
  // rule names only the formats it evaluates (`needs.formats`), not the formats
  // its facts come from. `unknown-table` declares `table-catalog`, whose
  // upstream `ddl-declarations` is supplied by `sql` (migration files) as well
  // as TS/JS — so `.sql` files must be read even though no rule declares `sql`.
  for (const kind of neededFactKinds()) {
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

  return runPhaseModelOverFiles(files, thresholdsByRule, projectRoot);
}

/** The file/corpus-pipeline half, exposed for the slice tests. */
export async function runPhaseModelOverFiles(
  files: readonly InputFile[],
  thresholdsByRule: ReadonlyMap<string, ThresholdValues>,
  projectRoot?: string,
): Promise<Finding[]> {
  const facts = await buildFacts(files, projectRoot);
  return analyzeAll(facts, thresholdsByRule);
}

/** The fact kinds the migrated rules read, transitively closed over corpus `needs`. */
function neededFactKinds(): Set<FactKind> {
  const needed = new Set<FactKind>();
  for (const rule of MIGRATED_RULES) {
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
async function buildFacts(files: readonly InputFile[], projectRoot?: string): Promise<Map<FactKind, unknown>> {
  const needed = neededFactKinds();
  const facts = new Map<FactKind, unknown>();

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

  // Per-file facts: one parse per file, every matching producer runs over it,
  // the tree is freed before the next file (it never crosses the boundary).
  for (const input of files) {
    const parsed = await parseOne(input, projectRoot);
    if (!parsed) continue;
    try {
      for (const kind of fileKinds) {
        const producer = fileProducerFor(kind, parsed.format);
        if (!producer) continue;
        const acc = (facts.get(kind) as unknown[] | undefined) ?? [];
        acc.push(...(producer.process(parsed) as unknown[]));
        facts.set(kind, acc);
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
  for (const kind of corpusKinds) {
    const producer = CORPUS_PRODUCERS[kind];
    const upstream = Object.fromEntries(producer.needs.map((n) => [n, facts.get(n)]));
    facts.set(kind, producer.process(upstream as never));
  }

  return facts;
}

/** Analyze: run every migrated rule against exactly its declared facts. */
async function analyzeAll(
  facts: Map<FactKind, unknown>,
  thresholdsByRule: ReadonlyMap<string, ThresholdValues>,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const rule of MIGRATED_RULES) {
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
