/**
 * Spec 68 §3.2 — the documentation rules, migrated to `analyze(ctx)`.
 *
 * These five rules (`function-documentation`, `parameter-documentation`,
 * `return-documentation`, `class-documentation`, `method-documentation`) were
 * the per-file AST checks inside `UniversalDocumentationAnalyzer`; now they read
 * the `file-symbols` fact and do pure comparison over plain data. The tree died
 * with the file — the producer pre-computed the two skip signals a rule cannot
 * derive from symbol fields (`isAnonymousOrCallback`, `isNonPublic`) where the
 * parent chain and method node still existed.
 *
 * `file-documentation` is *not* here: it is a file-level rule (a leading
 * header comment), not a symbol-level one, and reads a fact kind
 * (`file-symbols` carries symbols, not files) the migration map dispositions
 * RENEW. It stays on the legacy path until its own fact lands.
 *
 * Config resolution mirrors the legacy analyzer's `{...DEFAULT, ...config}`
 * merge, but the defaults are re-declared here (the legacy class is deleted in
 * §15, and the rule must not reach across the phase boundary to import it). The
 * §10 bridge (`resolvePhaseThresholds`) already merges the same default into
 * `ctx.thresholds`, so the merge is idempotent in production and load-bearing
 * only for the parity test, which passes raw config to both sides.
 *
 * The three rules read only their tuning thresholds; §10 removed the
 * `requireParamDocs` / `requireReturnDocs` opt-in gates — these rules now fire
 * unconditionally. The two booleans survive on this config type only for
 * merge-shape parity with the legacy analyzer (deleted in §15); no rule body
 * reads them.
 */

import type {
  RuleDefinition,
  Finding,
  FileSymbols,
  FileFunctionSymbol,
  FileClassSymbol,
  FileMethodSymbol,
  ThresholdValues,
} from '../types.js';
import type { Severity } from '../../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

/** The shared declaration for every documentation rule in this slice. */
type DocumentationNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['file-symbols'];
};

/** The config surface the migrated rules read (the subset of the legacy
 *  `DocumentationAnalyzerConfig` that gates or filters a *finding*). */
interface DocumentationConfig {
  requireFunctionDocs: boolean;
  requireClassDocs: boolean;
  requireParamDocs: boolean;
  requireReturnDocs: boolean;
  scope: 'public' | 'all';
  docsMinLines: number;
  exemptPatterns: string[];
}

/**
 * The documentation defaults, re-declared from
 * `DEFAULT_DOCUMENTATION_CONFIG` (UniversalDocumentationAnalyzer.ts). The full
 * object carries fields these rules do not read (`requireFileDocs`,
 * `fileHeaders`, `headerSkipGlobs`, `checkExportedOnly`, `minDescriptionLength`);
 * only the finding-relevant subset is reproduced, with the `exemptPatterns`
 * list verbatim so the file-level skip matches the legacy analyzer exactly.
 */
const DOCUMENTATION_DEFAULTS: DocumentationConfig = {
  requireFunctionDocs: true,
  requireClassDocs: true,
  requireParamDocs: false,
  requireReturnDocs: false,
  scope: 'public',
  docsMinLines: 5,
  exemptPatterns: [
    '\\.test\\.',
    '\\.spec\\.',
    '\\.d\\.ts$',
    'mock',
    'fixture',
    '__tests__',
    '/tests?/',
    '\\.tsx$',
    '\\.jsx$',
    '/(page|layout|loading|error|route|template|not-found|default|middleware)\\.(ts|tsx|js|jsx|mjs|cjs)$',
  ],
};

/** Merge the (default-merged) thresholds onto the documentation defaults. */
function resolveConfig(t: ThresholdValues): DocumentationConfig {
  const merged = { ...DOCUMENTATION_DEFAULTS, ...(t as Record<string, unknown>) } as DocumentationConfig;
  return {
    ...merged,
    scope: merged.scope ?? 'public',
    docsMinLines: typeof merged.docsMinLines === 'number' ? merged.docsMinLines : 5,
  };
}

/** One finding, in the unified shape §7 converges on. */
function finding(
  ruleId: string,
  message: string,
  file: string,
  line: number,
  column: number | undefined,
  symbol: string,
): Finding {
  return { ruleId, severity: 'high' as Severity, message, file, line, column, symbol };
}

const META = RULE_REGISTRY;

// ── R1 file-level skip (config-driven, per-symbol since each symbol carries its file) ─

/** True when a file path matches any exempt pattern (case-insensitive regex). */
function isExempt(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp(pattern, 'i');
    return regex.test(name);
  });
}

// ── Spec-49 documentation substance (re-homed; the legacy analyzer is deleted in §15) ─

const PLACEHOLDER_DOC_PATTERN = /^@?\s*(TODO|FIXME|XXX|TBD|WIP|STUB|PLACEHOLDER)\b/i;

const DOC_STOP_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'and', 'or', 'of', 'to',
  'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'by',
  'as', 'at', 'from', 'it', 'its',
]);

/** True when the doc comment contains substantive descriptive prose. */
function isSubstantiveDoc(doc: string): boolean {
  const raw = doc
    .replace(/\/\*\*?|\*\//g, ' ')
    .replace(/^\s*\*+\s?/gm, ' ');
  const trimmed = raw.trim();
  if (!trimmed) return false;

  if (PLACEHOLDER_DOC_PATTERN.test(trimmed)) return false;

  const prose = trimmed
    .replace(/@\w+\s*(\{[^}]*\})?/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase();
  const words = prose.split(/\s+/).filter((w) => w.length >= 2 && !DOC_STOP_WORDS.has(w));
  return words.length > 0;
}

/** True when `name` is a plain identifier (valid @param target). */
function isPlainIdentifierName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** Which parameters are missing documentation. */
function checkParameterDocumentation(doc: string, paramNames: string[]): string[] {
  const missingParams: string[] = [];
  for (const param of paramNames) {
    if (!isPlainIdentifierName(param)) continue;
    const paramRegex = new RegExp(`@param\\s+(?:\\{[^}]+\\}\\s+)?${param}\\b`, 'i');
    if (!paramRegex.test(doc)) {
      missingParams.push(param);
    }
  }
  return missingParams;
}

/** True when the doc comment carries a @returns/@return tag. */
function hasReturnDocumentation(doc: string): boolean {
  return /@returns?\b/i.test(doc);
}

// ── Shared iteration ─────────────────────────────────────────────────────────

/**
 * The function/method items eligible for the param/return *tag* checks. This is
 * the `analyzeFunctionDocumentation` loop of the legacy analyzer: standalone
 * functions AND methods, each not skipped (`isAnonymousOrCallback` for
 * functions, `isNonPublic || !isExported` for methods), at or above the
 * `docsMinLines` size gate, and *carrying a substantive doc* (tag completeness
 * is only checked on a doc that already exists).
 */
interface TagItem {
  name: string;
  file: string;
  line: number;
  column?: number;
  parameterNames: string[];
  returnType?: string;
  jsDoc: string;
}

function tagEligibleItems(symbols: FileSymbols[], cfg: DocumentationConfig): TagItem[] {
  const out: TagItem[] = [];
  for (const s of symbols) {
    if (isExempt(s.file, cfg.exemptPatterns)) continue;

    if (s.kind === 'function') {
      const f = s as FileFunctionSymbol;
      if (f.isAnonymousOrCallback) continue;
      if (cfg.scope === 'public' && !f.isExported) continue;
      if (f.lineCount < cfg.docsMinLines) continue;
      const doc = f.jsDoc || '';
      if (!isSubstantiveDoc(doc)) continue;
      out.push({ name: f.name, file: f.file, line: f.line, column: f.column, parameterNames: f.parameterNames, returnType: f.returnType, jsDoc: doc });
    } else if (s.kind === 'class') {
      const cls = s as FileClassSymbol;
      for (const m of cls.methods) {
        if (cfg.scope === 'public' && (m.isNonPublic || !cls.isExported)) continue;
        if (m.lineCount < cfg.docsMinLines) continue;
        const doc = m.jsDoc || '';
        if (!isSubstantiveDoc(doc)) continue;
        out.push({ name: m.name, file: cls.file, line: m.line, column: m.column, parameterNames: m.parameterNames, returnType: m.returnType, jsDoc: doc });
      }
    }
  }
  return out;
}

// ── function-documentation ───────────────────────────────────────────────────

const functionDocumentation: RuleDefinition<DocumentationNeeds> = {
  id: 'function-documentation',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['function-documentation'].message,
  docs: META['function-documentation'].docs,
  thresholds: META['function-documentation'].thresholds,
  samples: META['function-documentation'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveConfig(ctx.thresholds);
    if (!cfg.requireFunctionDocs) return [];
    const out: Finding[] = [];
    for (const s of ctx.facts['file-symbols']) {
      if (s.kind !== 'function') continue;
      const f = s as FileFunctionSymbol;
      if (isExempt(f.file, cfg.exemptPatterns)) continue;
      if (f.isAnonymousOrCallback) continue;
      if (cfg.scope === 'public' && !f.isExported) continue;
      if (f.lineCount < cfg.docsMinLines) continue;
      if (isSubstantiveDoc(f.jsDoc || '')) continue;
      const reason = f.isExported
        ? `exported function '${f.name}' lacks a documentation comment`
        : `function '${f.name}' lacks a documentation comment`;
      out.push(finding('function-documentation', reason, f.file, f.line, f.column, f.name));
    }
    return out;
  },
};

// ── parameter-documentation ──────────────────────────────────────────────────

const parameterDocumentation: RuleDefinition<DocumentationNeeds> = {
  id: 'parameter-documentation',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['parameter-documentation'].message,
  docs: META['parameter-documentation'].docs,
  thresholds: META['parameter-documentation'].thresholds,
  samples: META['parameter-documentation'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveConfig(ctx.thresholds);
    const out: Finding[] = [];
    for (const item of tagEligibleItems(ctx.facts['file-symbols'], cfg)) {
      for (const param of checkParameterDocumentation(item.jsDoc, item.parameterNames)) {
        out.push(finding(
          'parameter-documentation',
          `Function '${item.name}' missing documentation for parameter '${param}'`,
          item.file, item.line, item.column, item.name,
        ));
      }
    }
    return out;
  },
};

// ── return-documentation ─────────────────────────────────────────────────────

const returnDocumentation: RuleDefinition<DocumentationNeeds> = {
  id: 'return-documentation',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['return-documentation'].message,
  docs: META['return-documentation'].docs,
  thresholds: META['return-documentation'].thresholds,
  samples: META['return-documentation'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveConfig(ctx.thresholds);
    const out: Finding[] = [];
    for (const item of tagEligibleItems(ctx.facts['file-symbols'], cfg)) {
      if (!item.returnType || item.returnType === 'void') continue;
      if (hasReturnDocumentation(item.jsDoc)) continue;
      out.push(finding(
        'return-documentation',
        `Function '${item.name}' missing return value documentation`,
        item.file, item.line, item.column, item.name,
      ));
    }
    return out;
  },
};

// ── class-documentation ──────────────────────────────────────────────────────

const classDocumentation: RuleDefinition<DocumentationNeeds> = {
  id: 'class-documentation',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['class-documentation'].message,
  docs: META['class-documentation'].docs,
  thresholds: META['class-documentation'].thresholds,
  samples: META['class-documentation'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveConfig(ctx.thresholds);
    if (!cfg.requireClassDocs) return [];
    const out: Finding[] = [];
    for (const s of ctx.facts['file-symbols']) {
      if (s.kind !== 'class') continue;
      const cls = s as FileClassSymbol;
      if (isExempt(cls.file, cfg.exemptPatterns)) continue;
      if (cfg.scope === 'public' && !cls.isExported) continue;
      if (isSubstantiveDoc(cls.jsDoc || '')) continue;
      out.push(finding(
        'class-documentation',
        `Class '${cls.name}' lacks a documentation comment`,
        cls.file, cls.line, cls.column, cls.name,
      ));
    }
    return out;
  },
};

// ── method-documentation ─────────────────────────────────────────────────────

const methodDocumentation: RuleDefinition<DocumentationNeeds> = {
  id: 'method-documentation',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-symbols'] },
  severity: 'high',
  message: META['method-documentation'].message,
  docs: META['method-documentation'].docs,
  thresholds: META['method-documentation'].thresholds,
  samples: META['method-documentation'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveConfig(ctx.thresholds);
    // method-documentation is gated by requireFunctionDocs (matching the legacy
    // `checkClassMethodDocumentation`), not requireClassDocs.
    if (!cfg.requireFunctionDocs) return [];
    const out: Finding[] = [];
    for (const s of ctx.facts['file-symbols']) {
      if (s.kind !== 'class') continue;
      const cls = s as FileClassSymbol;
      if (isExempt(cls.file, cfg.exemptPatterns)) continue;
      if (cfg.scope === 'public' && !cls.isExported) continue;
      for (const m of cls.methods) {
        if (cfg.scope === 'public' && m.isNonPublic) continue;
        if (isSubstantiveDoc(m.jsDoc || '')) continue;
        out.push(finding(
          'method-documentation',
          `public method '${cls.name}.${m.name}' lacks a documentation comment`,
          cls.file, m.line, m.column, `${cls.name}.${m.name}`,
        ));
      }
    }
    return out;
  },
};

/** The five documentation rules this slice migrates, in registry order. */
export const documentationRules: readonly RuleDefinition<DocumentationNeeds>[] = [
  functionDocumentation,
  parameterDocumentation,
  returnDocumentation,
  classDocumentation,
  methodDocumentation,
];
