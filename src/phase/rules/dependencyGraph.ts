/**
 * Spec 68 §3.2 — the dependency-graph rules, migrated to `analyze(ctx)`.
 *
 * The eight rules here read the `cross-language-entities` fact (a flat array of
 * `Entity`) and reduce it through `DependencyGraphBuilder` — the same pure class
 * the legacy Stage-4 reducer ran. The reducer (`createDependencyGraphReducer`
 * in pipelineAdapters.ts) already took `entities` + built references + called
 * `buildGraph` + `analyzeDependencyHealth` and then mapped `DependencyIssue` /
 * `DependencySuggestion` records to findings; that mapping is re-homed verbatim
 * here, one rule per issue/suggestion type:
 *
 *   issue type        → rule                suggestion type     → rule
 *   circular-dependency → circular-dependency  break-cycles        → break-cycles
 *   tight-coupling    → tight-coupling        reduce-coupling     → reduce-coupling
 *   hub-nodes         → hub-nodes             split-responsibilities → split-responsibilities
 *   orphaned-nodes    → orphaned-nodes        review-orphans      → review-orphans
 *
 * Each rule re-derives the graph from the fact (the phase model hands every
 * rule the full corpus-wide `Entity[]`), so the graph build is recomputed once
 * per rule in the in-process runner; §6's corpus processors move it to a single
 * shared computation. Recomputing per rule is correct and deterministic — the
 * graph algorithms iterate in entity order, and the fact array order is fixed.
 *
 * `buildReferences` is re-homed (not imported) from `clBuildReferences` in
 * pipelineAdapters.ts, because that private helper is deleted with the reducer
 * in §15. `DependencyGraphBuilder` itself survives §15 — it imports no analyzer
 * class and no pipeline, so the rules import it directly.
 *
 * The ninth dependency-graph rule, `unreferenced-module`, is not here: it reads
 * the file-level `imports`/`hasExports` half of the cross-language visitor, a
 * `file-imports` fact the current producer does not emit (RENEW — lands with
 * §8's reachability fact). The 3 schema-validator rules (`schema-field-mismatch`,
 * `missing-field`, `extra-field`) read a `Entity` shape the schema-validator
 * reducer enriches at reduce time (ENRICH), so they land with §8 too.
 */

import type { RuleDefinition, Finding, Entity } from '../types.js';
import type { Severity } from '../../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import { DependencyGraphBuilder } from '../../analyzers/cross-language/DependencyGraphBuilder.js';
import type {
  DependencyIssue,
  DependencySuggestion,
} from '../../analyzers/cross-language/DependencyGraphBuilder.js';
import type { CrossLanguageEntity, CrossReference } from '../../types/crossLanguage.js';

/** The shared declaration for the eight dependency-graph rules. */
type DependencyGraphNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript', 'go'];
  readonly facts: readonly ['cross-language-entities'];
};

const META = RULE_REGISTRY;

/** The suggestion severity map, verbatim from the reducer's HEALTH_SEVERITY. */
const SUGGESTION_SEVERITY: Record<DependencySuggestion['type'], Severity> = {
  'break-cycles': 'severe',
  'reduce-coupling': 'high',
  'split-responsibilities': 'high',
  'review-orphans': 'severe',
};

/**
 * Build the call cross-references by resolving each entity's extracted callee
 * names against the corpus entity-name index (re-homed from `clBuildReferences`).
 */
function buildReferences(entities: Entity[]): CrossReference[] {
  const byName = new Map<string, Entity[]>();
  for (const e of entities) {
    const key = e.name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(e);
    byName.set(key, list);
  }

  const refs: CrossReference[] = [];
  for (const e of entities) {
    const callees = (e.metadata?.callees as string[] | undefined) ?? [];
    const eDir = e.file.split('/').slice(0, -1).join('/');
    for (const callee of callees) {
      const name = (callee.split('.').pop() ?? callee).toLowerCase();
      // A free function calling itself by bare name is recursing, not a cycle.
      if (name === e.name.toLowerCase()) continue;
      const others = (byName.get(name) ?? []).filter((t) => t.id !== e.id);
      if (others.length === 0) continue;

      // Narrow ambiguous bare-name resolution: same file → same directory →
      // unique global. A missing edge is safer than a fabricated one.
      const sameFile = others.filter((t) => t.file === e.file);
      const sameDir = sameFile.length === 0
        ? others.filter((t) => t.file.split('/').slice(0, -1).join('/') === eDir)
        : [];
      const uniqueGlobal = others.length === 1 ? others : [];
      const chosen = sameFile.length === 1
        ? sameFile
        : sameDir.length === 1
          ? sameDir
          : uniqueGlobal;

      for (const t of chosen) {
        refs.push({
          sourceId: e.id,
          targetId: t.id,
          type: 'calls',
          sourceLanguage: e.language,
          targetLanguage: t.language,
          confidence: 0.7,
        });
      }
    }
  }
  return refs;
}

/** The graph+health result every rule reduces over, plus the id→entity lookup. */
interface GraphResult {
  issues: DependencyIssue[];
  suggestions: DependencySuggestion[];
  idToEntity: Map<string, Entity>;
}

/** Build the dependency graph and its health analysis over the entity fact. */
async function computeGraph(entities: Entity[]): Promise<GraphResult> {
  const builder = new DependencyGraphBuilder({ includeTestFiles: false });
  const references = buildReferences(entities);
  const graph = await builder.buildGraph(entities as unknown as CrossLanguageEntity[], references);
  const health = await builder.analyzeDependencyHealth(graph);
  const idToEntity = new Map(entities.map((e) => [e.id, e] as const));
  return { issues: health.issues, suggestions: health.suggestions, idToEntity };
}

/** The first affected node that resolves to a real entity — the finding anchor. */
function anchor(issue: DependencyIssue, idToEntity: Map<string, Entity>): Entity | undefined {
  return issue.affectedNodes.map((id) => idToEntity.get(id)).find(Boolean);
}

/** Read one issue type and emit its single finding (cycles/tight-coupling).
 *  The reducer anchors these to the first resolvable affected node and carries
 *  the health analysis' own severity (`issue.severity`), not a rule-level one. */
async function issueToFindings(
  entities: Entity[],
  type: DependencyIssue['type'],
  id: string,
): Promise<Finding[]> {
  const { issues, idToEntity } = await computeGraph(entities);
  const out: Finding[] = [];
  for (const issue of issues) {
    if (issue.type !== type) continue;
    const a = anchor(issue, idToEntity);
    out.push({
      ruleId: id,
      severity: issue.severity,
      message: issue.description,
      file: a?.file ?? '(unknown)',
      line: a?.startLine ?? 0,
    });
  }
  return out;
}

/** Read one suggestion type and emit its finding. */
async function suggestionToFindings(
  entities: Entity[],
  type: DependencySuggestion['type'],
  id: string,
): Promise<Finding[]> {
  const { suggestions } = await computeGraph(entities);
  const out: Finding[] = [];
  for (const s of suggestions) {
    if (s.type !== type) continue;
    out.push({
      ruleId: id,
      severity: SUGGESTION_SEVERITY[type],
      message: s.description,
      file: '(multiple)',
      line: 0,
    });
  }
  return out;
}

// ── circular-dependency ──────────────────────────────────────────────────────

const circularDependency: RuleDefinition<DependencyGraphNeeds> = {
  id: 'circular-dependency',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['cross-language-entities'] },
  severity: 'severe',
  message: META['circular-dependency'].message,
  docs: META['circular-dependency'].docs,
  thresholds: META['circular-dependency'].thresholds,
  samples: META['circular-dependency'].samples,
  async analyze(ctx): Promise<Finding[]> {
    return issueToFindings(ctx.facts['cross-language-entities'], 'circular-dependency', 'circular-dependency');
  },
};

// ── tight-coupling ───────────────────────────────────────────────────────────

const tightCoupling: RuleDefinition<DependencyGraphNeeds> = {
  id: 'tight-coupling',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['cross-language-entities'] },
  severity: 'high',
  message: META['tight-coupling'].message,
  docs: META['tight-coupling'].docs,
  thresholds: META['tight-coupling'].thresholds,
  thresholdRationale: META['tight-coupling'].thresholdRationale,
  samples: META['tight-coupling'].samples,
  async analyze(ctx): Promise<Finding[]> {
    return issueToFindings(ctx.facts['cross-language-entities'], 'tight-coupling', 'tight-coupling');
  },
};

// ── hub-nodes ────────────────────────────────────────────────────────────────

const hubNodes: RuleDefinition<DependencyGraphNeeds> = {
  id: 'hub-nodes',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['cross-language-entities'] },
  severity: 'high',
  message: META['hub-nodes'].message,
  docs: META['hub-nodes'].docs,
  thresholds: META['hub-nodes'].thresholds,
  samples: META['hub-nodes'].samples,
  async analyze(ctx): Promise<Finding[]> {
    const { issues, idToEntity } = await computeGraph(ctx.facts['cross-language-entities']);
    const out: Finding[] = [];
    for (const issue of issues) {
      if (issue.type !== 'hub-nodes') continue;
      const hubs = Array.isArray(issue.details?.hubs)
        ? (issue.details.hubs as Array<{ id: string; name: string; outDegree: number }>)
        : [];
      for (const hub of hubs) {
        const entity = idToEntity.get(hub.id);
        if (!entity) continue;
        out.push({
          ruleId: 'hub-nodes',
          severity: issue.severity,
          message: `Hub node "${hub.name}" has ${hub.outDegree} dependencies.`,
          file: entity.file,
          line: entity.startLine,
          symbol: hub.name,
        });
      }
    }
    return out;
  },
};

// ── orphaned-nodes ───────────────────────────────────────────────────────────

const orphanedNodes: RuleDefinition<DependencyGraphNeeds> = {
  id: 'orphaned-nodes',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['cross-language-entities'] },
  severity: 'severe',
  message: META['orphaned-nodes'].message,
  docs: META['orphaned-nodes'].docs,
  thresholds: META['orphaned-nodes'].thresholds,
  samples: META['orphaned-nodes'].samples,
  async analyze(ctx): Promise<Finding[]> {
    const { issues, idToEntity } = await computeGraph(ctx.facts['cross-language-entities']);
    const out: Finding[] = [];
    for (const issue of issues) {
      if (issue.type !== 'orphaned-nodes') continue;
      for (const id of issue.affectedNodes) {
        const orphan = idToEntity.get(id);
        if (!orphan) continue;
        out.push({
          ruleId: 'orphaned-nodes',
          severity: issue.severity,
          message: `Orphaned node "${orphan.name}" has no connections.`,
          file: orphan.file,
          line: orphan.startLine,
          symbol: orphan.name,
        });
      }
    }
    return out;
  },
};

// ── break-cycles ─────────────────────────────────────────────────────────────

const breakCycles: RuleDefinition<DependencyGraphNeeds> = {
  id: 'break-cycles',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['cross-language-entities'] },
  severity: 'severe',
  message: META['break-cycles'].message,
  docs: META['break-cycles'].docs,
  thresholds: META['break-cycles'].thresholds,
  samples: META['break-cycles'].samples,
  async analyze(ctx): Promise<Finding[]> {
    return suggestionToFindings(ctx.facts['cross-language-entities'], 'break-cycles', 'break-cycles');
  },
};

// ── reduce-coupling ──────────────────────────────────────────────────────────

const reduceCoupling: RuleDefinition<DependencyGraphNeeds> = {
  id: 'reduce-coupling',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['cross-language-entities'] },
  severity: 'high',
  message: META['reduce-coupling'].message,
  docs: META['reduce-coupling'].docs,
  thresholds: META['reduce-coupling'].thresholds,
  samples: META['reduce-coupling'].samples,
  async analyze(ctx): Promise<Finding[]> {
    return suggestionToFindings(ctx.facts['cross-language-entities'], 'reduce-coupling', 'reduce-coupling');
  },
};

// ── split-responsibilities ───────────────────────────────────────────────────

const splitResponsibilities: RuleDefinition<DependencyGraphNeeds> = {
  id: 'split-responsibilities',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['cross-language-entities'] },
  severity: 'high',
  message: META['split-responsibilities'].message,
  docs: META['split-responsibilities'].docs,
  thresholds: META['split-responsibilities'].thresholds,
  samples: META['split-responsibilities'].samples,
  async analyze(ctx): Promise<Finding[]> {
    return suggestionToFindings(ctx.facts['cross-language-entities'], 'split-responsibilities', 'split-responsibilities');
  },
};

// ── review-orphans ───────────────────────────────────────────────────────────

const reviewOrphans: RuleDefinition<DependencyGraphNeeds> = {
  id: 'review-orphans',
  needs: { formats: ['typescript', 'tsx', 'javascript', 'go'], facts: ['cross-language-entities'] },
  severity: 'severe',
  message: META['review-orphans'].message,
  docs: META['review-orphans'].docs,
  thresholds: META['review-orphans'].thresholds,
  samples: META['review-orphans'].samples,
  async analyze(ctx): Promise<Finding[]> {
    return suggestionToFindings(ctx.facts['cross-language-entities'], 'review-orphans', 'review-orphans');
  },
};

/** The eight dependency-graph rules this slice migrates, in registry order. */
export const dependencyGraphRules: readonly RuleDefinition<DependencyGraphNeeds>[] = [
  circularDependency,
  breakCycles,
  tightCoupling,
  reduceCoupling,
  hubNodes,
  splitResponsibilities,
  orphanedNodes,
  reviewOrphans,
];
