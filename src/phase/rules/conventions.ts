/**
 * Spec 68 §3.2 — the three function-index-servable conventions rules, migrated
 * to `analyze(ctx)`.
 *
 * The conventions analyzer is index-backed: it never walked an AST, it queried
 * the SQLite `conventions` + `functions` + `function_calls` tables. Its three
 * function-index-servable detectors are a clean reduction over the
 * `mined-conventions` corpus fact plus the `function-index` fact that fed it:
 *
 *   - usage-pair — a function that calls the antecedent but not the consequent
 *     of a mined pair (reads `function-index` call sets + the mined pairs).
 *   - error-handling — a function whose detected error-handling shape differs
 *     from its directory's dominant shape.
 *   - naming — an exported symbol whose casing differs from its directory+kind's
 *     dominant casing.
 *   - export-shape — an exported symbol whose export form (default vs named)
 *     differs from its directory's dominant form (reads `export-form`).
 *
 * The detection logic is re-homed verbatim from `UniversalConventionsAnalyzer`'s
 * `detectUsagePairForConvention` / `detectErrorHandlingForRow` /
 * `detectNamingForRow` / `detectExportShapeForRow` (and its `buildCallMaps` /
 * `buildDirShapes` / `buildDirKindCases` / `classifyExportKind` /
 * `buildDirForms` helpers). The DB-assigned `id` becomes the array index; the
 * finding anchors to `(file, line)` and never to the id, so the numbering is a
 * key only.
 *
 * `import-form` stays on the legacy path: it reads the `imports` fact (a later
 * fact kind) the `function-index` producer does not carry (§9). The
 * error-handling `cannot-fire` diagnostic (a non-TS/JS body) has no `analyze`
 * channel — §8 derives coverage states, so the diagnostic folds into that, not
 * into findings.
 */

import * as path from 'path';
import type { RuleDefinition, Finding, FunctionIndexFact, MinedConvention, ExportFormFact } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import {
  detectCase,
  detectErrorHandlingShape,
  hasNonLatinChars,
} from '../../conventions/conventionMiner.js';

/** The shared declaration for the three function-index-servable rules. */
type ConventionNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['function-index', 'mined-conventions'];
};

const META = RULE_REGISTRY;

/** Languages whose error-handling shape `detectErrorHandlingShape` can classify
 *  (re-homes the analyzer's `ERROR_HANDLING_HANDLED_LANGUAGES`). The producer
 *  only emits these languages, so the guard is a fidelity check, not a filter. */
const ERROR_HANDLING_HANDLED_LANGUAGES = new Set(['typescript', 'javascript']);

/** Build the `(exemplar: file:line)` suffix shared across convention messages. */
function exemplarRef(conv: {
  exemplar_file: string | null;
  exemplar_line: number | null;
}): string {
  return conv.exemplar_file
    ? ` (exemplar: ${conv.exemplar_file}${conv.exemplar_line ? `:${conv.exemplar_line}` : ''})`
    : '';
}

/** The caller→callees and callee→callers maps, keyed by the function's array
 *  index (re-homes `buildCallMaps`). */
function buildCallMaps(facts: readonly FunctionIndexFact[]): {
  callerCalls: Map<number, Set<string>>;
  antecedentCallers: Map<string, Set<number>>;
} {
  const callerCalls = new Map<number, Set<string>>();
  const antecedentCallers = new Map<string, Set<number>>();
  facts.forEach((f, i) => {
    const callees = new Set(f.functionCalls);
    callerCalls.set(i, callees);
    for (const callee of f.functionCalls) {
      const callers = antecedentCallers.get(callee);
      if (callers) callers.add(i);
      else antecedentCallers.set(callee, new Set([i]));
    }
  });
  return { callerCalls, antecedentCallers };
}

/** The convention rows whose domain matches, in the order the corpus fact carries. */
function conventionsOf(conventions: readonly MinedConvention[], domain: MinedConvention['domain']): MinedConvention[] {
  return conventions.filter((c) => c.domain === domain);
}

// ── usage-pair ──────────────────────────────────────────────────────────────

function detectUsagePair(findings: Finding[], facts: readonly FunctionIndexFact[], conventions: readonly MinedConvention[]): void {
  const { callerCalls, antecedentCallers } = buildCallMaps(facts);
  const funcById = new Map<number, FunctionIndexFact>(facts.map((f, i) => [i, f]));

  for (const conv of conventionsOf(conventions, 'usage-pair')) {
    if (!conv.antecedent || !conv.consequent) continue;
    const antecedent = conv.antecedent;
    const consequent = conv.consequent;
    const callerIds = antecedentCallers.get(antecedent);
    if (!callerIds || callerIds.size === 0) continue;

    for (const cid of callerIds) {
      const callSet = callerCalls.get(cid);
      if (!callSet || !callSet.has(consequent)) {
        const func = funcById.get(cid);
        if (!func) continue;

        const pct = Math.round(conv.confidence * 100);
        findings.push({
          ruleId: 'conventions/usage-pair',
          severity: 'high',
          message:
            `${pct}% of \`${antecedent}\` callers also call \`${consequent}\` — ` +
            `this function calls \`${antecedent}\` without \`${consequent}\`${exemplarRef(conv)}`,
          file: func.file,
          line: func.line,
          column: 1,
          symbol: func.name,
          resolution: {
            action: 'call-companion',
            summary: `Add a call to the companion function \`${consequent}\` in \`${func.name}\` — ${pct}% of \`${antecedent}\` callers also call it.`,
            symbols: [consequent, antecedent],
            files: [func.file],
            lines: [func.line],
          },
        });
      }
    }
  }
}

// ── error-handling ──────────────────────────────────────────────────────────

function buildDirShapes(conventions: readonly MinedConvention[]): Map<string, MinedConvention> {
  const dirShapes = new Map<string, MinedConvention>();
  for (const conv of conventionsOf(conventions, 'error-handling')) {
    const dir = conv.directory ?? '.';
    if (!conv.pattern) continue;
    dirShapes.set(dir, conv);
  }
  return dirShapes;
}

function detectErrorHandling(findings: Finding[], facts: readonly FunctionIndexFact[], conventions: readonly MinedConvention[]): void {
  const dirShapes = buildDirShapes(conventions);

  for (const fact of facts) {
    if (!ERROR_HANDLING_HANDLED_LANGUAGES.has(fact.language)) continue;
    if (fact.body == null) continue;

    const directory = path.dirname(fact.file) || '.';
    const conv = dirShapes.get(directory);
    if (!conv) continue;

    const shape = detectErrorHandlingShape(fact.body);
    if (!shape) continue; // no error handling → skip
    if (shape === conv.pattern) continue; // matches convention

    const pct = Math.round(conv.confidence * 100);
    findings.push({
      ruleId: 'conventions/error-handling',
      severity: 'high',
      message:
        `${pct}% of error-handling functions in \`${directory}/\` use ` +
        `\`${conv.pattern}\` — this function uses \`${shape}\`${exemplarRef(conv)}`,
      file: fact.file,
      line: fact.line,
      column: 1,
      symbol: fact.name,
    });
  }
}

// ── naming ──────────────────────────────────────────────────────────────────

/** Classify an exported function into a naming kind (re-homes the analyzer's
 *  `classifyExportKind`). */
function classifyExportKind(fact: FunctionIndexFact): string {
  if (fact.entityType === 'component' || fact.componentType !== null) {
    return 'react-component';
  }
  if (/^use[A-Z]/.test(fact.name)) return 'hook';
  return 'function';
}

function buildDirKindCases(conventions: readonly MinedConvention[]): Map<string, Map<string, MinedConvention>> {
  const dirKindCases = new Map<string, Map<string, MinedConvention>>();
  for (const conv of conventionsOf(conventions, 'naming')) {
    const dir = conv.directory ?? '.';
    const casing = conv.pattern;
    if (!casing) continue;
    const kind = conv.export_kind ?? 'function';

    if (!dirKindCases.has(dir)) dirKindCases.set(dir, new Map());
    dirKindCases.get(dir)!.set(kind, conv);
  }
  return dirKindCases;
}

function detectNaming(findings: Finding[], facts: readonly FunctionIndexFact[], conventions: readonly MinedConvention[]): void {
  const dirKindCases = buildDirKindCases(conventions);

  for (const fact of facts) {
    if (!fact.isExported) continue;

    const directory = path.dirname(fact.file) || '.';
    const kindConvs = dirKindCases.get(directory);
    if (!kindConvs) continue;

    const rowKind = classifyExportKind(fact);
    const conv = kindConvs.get(rowKind);
    if (!conv) continue;

    if (hasNonLatinChars(fact.name)) continue;

    const casing = detectCase(fact.name);
    if (!casing || casing === conv.pattern) continue;

    const pct = Math.round(conv.confidence * 100);
    findings.push({
      ruleId: 'conventions/naming',
      severity: 'high',
      message:
        `${pct}% of ${rowKind} exports in \`${directory}/\` use ${conv.pattern} — ` +
        `\`${fact.name}\` uses ${casing}${exemplarRef(conv)}`,
      file: fact.file,
      line: fact.line,
      column: 1,
      symbol: fact.name,
    });
  }
}

// ── export-shape ────────────────────────────────────────────────────────────

/** Build directory → dominant export form from convention rows (re-homes the
 *  analyzer's `buildDirForms`). */
function buildDirFormsForShape(conventions: readonly MinedConvention[]): Map<string, MinedConvention> {
  const dirForms = new Map<string, MinedConvention>();
  for (const conv of conventionsOf(conventions, 'export-shape')) {
    const dir = conv.directory ?? '.';
    if (!conv.pattern) continue;
    dirForms.set(dir, conv);
  }
  return dirForms;
}

/** Detect an export-shape deviation for each exported function (re-homes the
 *  analyzer's `detectExportShapeForRow`). The form resolves from the
 *  `export-form` fact — the same AST-extracted `(name, isDefault)` pairs the
 *  legacy reducer read as `exportsMap`. */
function detectExportShape(
  findings: Finding[],
  facts: readonly FunctionIndexFact[],
  conventions: readonly MinedConvention[],
  exportForms: readonly ExportFormFact[],
): void {
  const dirForms = buildDirFormsForShape(conventions);

  // file → exports, grouped from the flat export-form fact.
  const exportsByFile = new Map<string, Array<{ name: string; isDefault: boolean }>>();
  for (const e of exportForms) {
    const list = exportsByFile.get(e.file);
    if (list) list.push({ name: e.name, isDefault: e.isDefault });
    else exportsByFile.set(e.file, [{ name: e.name, isDefault: e.isDefault }]);
  }

  for (const fact of facts) {
    if (!fact.isExported) continue;

    const directory = path.dirname(fact.file) || '.';
    const conv = dirForms.get(directory);
    if (!conv) continue;

    const fileExports = exportsByFile.get(fact.file);
    if (!fileExports) continue;
    const match = fileExports.find((e) => e.name === fact.name);
    if (!match) continue;
    const form: 'default' | 'named' = match.isDefault ? 'default' : 'named';
    if (form === conv.pattern) continue;

    const pct = Math.round(conv.confidence * 100);
    findings.push({
      ruleId: 'conventions/export-shape',
      severity: 'high',
      message:
        `${pct}% of exports in \`${directory}/\` use ${conv.pattern} export — ` +
        `\`${fact.name}\` uses ${form}${exemplarRef(conv)}`,
      file: fact.file,
      line: fact.line,
      column: 1,
      symbol: fact.name,
    });
  }
}

// ── Rule definitions ────────────────────────────────────────────────────────

const usagePair: RuleDefinition<ConventionNeeds> = {
  id: 'conventions/usage-pair',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['function-index', 'mined-conventions'] },
  severity: 'high',
  message: META['conventions/usage-pair'].message,
  docs: META['conventions/usage-pair'].docs,
  thresholds: META['conventions/usage-pair'].thresholds,
  samples: META['conventions/usage-pair'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    detectUsagePair(out, ctx.facts['function-index'], ctx.facts['mined-conventions']);
    return out;
  },
};

const errorHandling: RuleDefinition<ConventionNeeds> = {
  id: 'conventions/error-handling',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['function-index', 'mined-conventions'] },
  severity: 'high',
  message: META['conventions/error-handling'].message,
  docs: META['conventions/error-handling'].docs,
  thresholds: META['conventions/error-handling'].thresholds,
  samples: META['conventions/error-handling'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    detectErrorHandling(out, ctx.facts['function-index'], ctx.facts['mined-conventions']);
    return out;
  },
};

const naming: RuleDefinition<ConventionNeeds> = {
  id: 'conventions/naming',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['function-index', 'mined-conventions'] },
  severity: 'high',
  message: META['conventions/naming'].message,
  docs: META['conventions/naming'].docs,
  thresholds: META['conventions/naming'].thresholds,
  samples: META['conventions/naming'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    detectNaming(out, ctx.facts['function-index'], ctx.facts['mined-conventions']);
    return out;
  },
};

/** The three function-index-servable conventions rules, in registry order. */
export const conventionsRules: readonly RuleDefinition<ConventionNeeds>[] = [
  usagePair,
  errorHandling,
  naming,
];

/** The export-shape rule reads one extra fact (`export-form`), so it carries a
 *  distinct `Needs` tuple and lives in its own array. */
type ExportShapeNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['function-index', 'mined-conventions', 'export-form'];
};

const exportShape: RuleDefinition<ExportShapeNeeds> = {
  id: 'conventions/export-shape',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['function-index', 'mined-conventions', 'export-form'] },
  severity: 'high',
  message: META['conventions/export-shape'].message,
  docs: META['conventions/export-shape'].docs,
  thresholds: META['conventions/export-shape'].thresholds,
  samples: META['conventions/export-shape'].samples,
  analyze(ctx): Finding[] {
    const out: Finding[] = [];
    detectExportShape(out, ctx.facts['function-index'], ctx.facts['mined-conventions'], ctx.facts['export-form']);
    return out;
  },
};

/** The export-shape conventions rule, in registry order. */
export const conventionsExportShapeRules: readonly RuleDefinition<ExportShapeNeeds>[] = [
  exportShape,
];
