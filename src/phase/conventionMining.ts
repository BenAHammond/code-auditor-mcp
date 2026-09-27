/**
 * Spec 68 §3.2 — the `mined-conventions` corpus producer.
 *
 * The conventions analyzer is the third index-backed analyzer whose *rule* half
 * moves onto the phase model (after styles and cross-domain). Its input is the
 * mined-conventions set — a derived fact — so the producer is a corpus
 * processor: `function-index` (the per-file fact) reduces to `mined-conventions`
 * through the three pure miners that also back the SQLite path.
 *
 * The pure miners (`mineUsagePairsFromFacts` / `mineErrorHandlingFromFacts` /
 * `mineNamingFromFacts` / `mineExportShapeFromFacts` in conventionMiner.ts) are
 * byte-identical to the DB miners the legacy pipeline ran; the DB miners are now
 * thin wrappers that project `functions`/`function_calls` rows into the same row
 * types and call the pure function. So the corpus fact produced here is, for the
 * four domains the `function-index` (+ `export-form`) facts can serve, the same
 * set the SQLite `conventions` table held. `import-form` stays on the DB path —
 * it reads the `imports` fact (a later fact kind), not `function-index`.
 *
 * The DB-assigned `id` is dropped (a function's identity is `(file, name, line)`),
 * so the array index stands in for it here; the miner uses `id` only to key the
 * caller→function and caller→call-set maps, so 0-based indices are equivalent to
 * 1-based auto-increments as long as the array order mirrors the DB row order.
 * `hash`/`created_at` are storage-only fields the phase model has no analogue of.
 */

import type { Convention, ConventionMiningConfig } from '../types.js';
import type { ExportFormFact, FunctionIndexFact, MinedConvention } from './types.js';
import {
  mineUsagePairsFromFacts,
  mineErrorHandlingFromFacts,
  mineNamingFromFacts,
  mineExportShapeFromFacts,
  capPerDomain,
  type UsagePairFuncRow,
  type ErrorHandlingFuncRow,
  type NamingFuncRow,
  type ExportShapeFuncRow,
  type MineCallRow,
} from '../conventions/conventionMiner.js';

/**
 * The mining thresholds the production pipeline runs. `mineAllConventions`
 * (codeIndexDB.ts) mines with exactly these values; keeping the phase producer's
 * default identical means the corpus fact matches the SQLite `conventions` table
 * on a real index-synced corpus.
 */
export const DEFAULT_MINING_CONFIG: ConventionMiningConfig = {
  minCorpus: 20,
  pairConfidence: 0.9,
  modeShare: 0.8,
  maxConventionsPerDomain: 200,
};

/** Strip the DB-only fields, keeping the detection projection. */
function toMinedConvention(c: Convention): MinedConvention {
  return {
    domain: c.domain,
    rule_id: c.rule_id,
    antecedent: c.antecedent,
    consequent: c.consequent,
    pattern: c.pattern,
    directory: c.directory,
    file_path: c.file_path,
    line: c.line,
    support: c.support,
    total_cases: c.total_cases,
    confidence: c.confidence,
    exemplar_file: c.exemplar_file,
    exemplar_line: c.exemplar_line,
    export_kind: c.export_kind ?? null,
  };
}

/**
 * Mine the function-index-servable domains from the assembled fact and reduce
 * them to the `mined-conventions` fact. The array index is the synthetic `id`
 * (see the header) — the miner's exemplar anchor is `(file, line)`, so the
 * numbering is only a key, never a finding field.
 *
 * `usage-pair` / `error-handling` / `naming` are servable from `function-index`
 * alone. `export-shape` additionally needs the `export-form` fact (the
 * AST-extracted `(name, isDefault)` exports the legacy reducer read as
 * `exportsMap`), so it is mined only when `exportForms` is provided — a caller
 * that has not assembled that fact (the three-domain parity seed) simply gets
 * the three domains, never a half-formed export-shape convention.
 */
export function mineConventionsFromFunctionIndex(
  facts: readonly FunctionIndexFact[],
  exportForms: readonly ExportFormFact[] = [],
  config: ConventionMiningConfig = DEFAULT_MINING_CONFIG,
): MinedConvention[] {
  const usageFuncs: UsagePairFuncRow[] = [];
  const errFuncs: ErrorHandlingFuncRow[] = [];
  const namingFuncs: NamingFuncRow[] = [];
  const exportShapeFuncs: ExportShapeFuncRow[] = [];
  const calls: MineCallRow[] = [];

  facts.forEach((f, i) => {
    // usage-pair reads every function (projectSymbols + exemplar anchor), no
    // is_exported filter — mirrors `SELECT … FROM functions`.
    usageFuncs.push({ id: i, name: f.name, file_path: f.file, line_number: f.line });

    // error-handling reads only functions with a body — mirrors `WHERE body IS NOT NULL`.
    if (f.body != null) {
      errFuncs.push({ id: i, name: f.name, file_path: f.file, line_number: f.line, body: f.body });
    }

    // naming and export-shape read only exported functions — mirror
    // `WHERE is_exported = 1`. The export-shape row projection is the same
    // `SELECT id, name, file_path, line_number` the DB miner reads; the form
    // comes from the export-form fact at reduction time.
    if (f.isExported) {
      namingFuncs.push({
        id: i,
        name: f.name,
        file_path: f.file,
        line_number: f.line,
        entity_type: f.entityType,
        component_type: f.componentType,
      });
      exportShapeFuncs.push({ id: i, name: f.name, file_path: f.file, line_number: f.line });
    }

    for (const callee of f.functionCalls) {
      calls.push({ caller_id: i, callee_name: callee });
    }
  });

  // file → exports (the export-form fact projected to the lookup `getExportForm`
  // consumes). The fact is flat ({file, name, isDefault}[]), so group it.
  const exportFormByFile = new Map<string, Array<{ name: string; isDefault: boolean }>>();
  for (const e of exportForms) {
    const list = exportFormByFile.get(e.file);
    if (list) list.push({ name: e.name, isDefault: e.isDefault });
    else exportFormByFile.set(e.file, [{ name: e.name, isDefault: e.isDefault }]);
  }

  const mined: Convention[] = [
    ...mineUsagePairsFromFacts(usageFuncs, calls, config),
    ...mineErrorHandlingFromFacts(errFuncs, config),
    ...mineNamingFromFacts(namingFuncs, config),
  ];

  if (exportForms.length > 0) {
    mined.push(...mineExportShapeFromFacts(exportShapeFuncs, config, (fp) => exportFormByFile.get(fp)));
  }

  return capPerDomain(mined, config.maxConventionsPerDomain).map(toMinedConvention);
}
