/**
 * Spec 68 §3.2 — the `file-documentation` rule, migrated to `analyze(ctx)`.
 *
 * This is the one documentation rule that is file-level, not symbol-level: it
 * checks for a leading *file header* comment (`@fileoverview` / `@file` /
 * `@module` / `@overview` / `@purpose`), which `file-symbols` cannot carry
 * (that fact is one element per symbol, not per file). It reads the
 * `file-header` fact instead — one element per file, carrying the leading
 * comment's trimmed text (or `null`) — and re-applies the classification the
 * legacy `checkFileHeader` did, so the tree died with the file and the rule is
 * pure text comparison over plain data.
 *
 * The three skip layers are reproduced exactly as the legacy `analyzeAST` +
 * `checkFileHeader` applied them, in order: the `exemptPatterns` name-based
 * skip (`.test.`/`.spec.`/`.d.ts`/`.tsx`/`mock`/`fixture`/…), then the
 * `headerSkipGlobs` glob skip (index files, migrations, pages, configs, …),
 * then the `fileHeaders` on/off gate (default off — `fileHeaders` falls back to
 * the deprecated `requireFileDocs`). Only after all three pass does a header
 * that is absent or lacks a header marker fire.
 *
 * The finding message is the legacy `checkFileHeader` text re-homed verbatim
 * (not the registry's `message` field, which the other slices keep as the
 * `RuleDefinition.message` metadata); the parity pin is on
 * `(file, line, column, rule, severity)`, and this keeps the full-pipeline
 * output byte-identical to the legacy visitor.
 */

import type { RuleDefinition, Finding, FileHeaderFact, ThresholdValues } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import picomatch from 'picomatch';

/** The shared declaration for this rule. */
type FileDocumentationNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['file-header'];
};

const META = RULE_REGISTRY;

// ── Config surface (the subset of DocumentationAnalyzerConfig the rule reads) ─

interface FileDocConfig {
  fileHeaders?: boolean;
  requireFileDocs?: boolean;
  headerSkipGlobs?: string[];
  exemptPatterns: string[];
}

/**
 * The defaults re-declared from `DEFAULT_DOCUMENTATION_CONFIG`
 * (UniversalDocumentationAnalyzer.ts), the same merge the legacy analyzer did
 * before `checkFileHeader`. `headerSkipGlobs` matches the analyzer's
 * `HEADER_SKIP_GLOBS_DEFAULT`; `exemptPatterns` matches its `exemptPatterns`
 * list verbatim (the `.tsx$`/`.jsx$` entries are why a TSX file is skipped
 * before the header check is ever reached).
 */
const FILE_DOC_DEFAULTS: FileDocConfig = {
  fileHeaders: false,
  requireFileDocs: true,
  headerSkipGlobs: [
    '**/index.{ts,tsx,js}',
    '**/*.{test,spec}.*',
    '**/__tests__/**',
    '**/migrations/**',
    '**/pages/**',
    '**/api/**',
    '**/routes/**',
    '**/*.config.*',
    '**/*.d.ts',
  ],
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

/** Merge the (default-merged) thresholds onto the file-doc defaults. */
function resolveConfig(t: ThresholdValues): FileDocConfig {
  return { ...FILE_DOC_DEFAULTS, ...(t as Record<string, unknown>) } as FileDocConfig;
}

// ── Spec-49 file-header substance (re-homed from UniversalDocumentationAnalyzer) ─

/** File-header markers — the signal that a leading comment documents the file's purpose. */
const FILE_HEADER_PATTERN = /@(fileoverview|file|module|module-desc|overview|purpose)\b/i;

/** True when the leading comment carries a file-header marker. */
function isFileHeaderDoc(doc: string): boolean {
  return FILE_HEADER_PATTERN.test(doc);
}

/** True when a file path matches any exempt regex pattern (case-insensitive). */
function isExempt(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const regex = new RegExp(pattern, 'i');
    return regex.test(name);
  });
}

/** True when a file path matches any picomatch glob (re-homed `matchesAnyGlob`). */
function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  for (const glob of globs) {
    if (picomatch.isMatch(filePath, glob)) return true;
  }
  return false;
}

// ── The rule ─────────────────────────────────────────────────────────────────

const fileDocumentation: RuleDefinition<FileDocumentationNeeds> = {
  id: 'file-documentation',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['file-header'] },
  severity: 'high',
  message: META['file-documentation'].message,
  docs: META['file-documentation'].docs,
  thresholds: META['file-documentation'].thresholds,
  samples: META['file-documentation'].samples,
  analyze(ctx): Finding[] {
    const cfg = resolveConfig(ctx.thresholds);
    // The legacy analyzer resolved the gate as `fileHeaders ?? requireFileDocs ?? false`.
    const fileHeaders = cfg.fileHeaders ?? cfg.requireFileDocs ?? false;
    if (!fileHeaders) return [];

    const skipGlobs = cfg.headerSkipGlobs ?? FILE_DOC_DEFAULTS.headerSkipGlobs!;
    const out: Finding[] = [];

    for (const fact of ctx.facts['file-header']) {
      if (isExempt(fact.file, cfg.exemptPatterns)) continue;
      if (matchesAnyGlob(fact.file, skipGlobs)) continue;
      if (!fact.headerDoc || !isFileHeaderDoc(fact.headerDoc)) {
        out.push({
          ruleId: 'file-documentation',
          severity: 'high',
          message: 'File lacks a leading documentation comment',
          file: fact.file,
          line: 1,
          column: 1,
        });
      }
    }
    return out;
  },
};

/** The one file-level documentation rule, in registry order. */
export const fileDocumentationRules: readonly RuleDefinition<FileDocumentationNeeds>[] = [
  fileDocumentation,
];
