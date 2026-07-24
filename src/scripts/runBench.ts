#!/usr/bin/env node
/**
 * Bench harness — runs analyzers over seeded corpus fixtures and computes
 * precision, recall, and F1 against labeled ground truth.
 *
 * Spec 11 R2
 *
 * Usage:
 *   pnpm bench              # Run all corpus analyzers
 *   pnpm bench --sweep      # Sweep mode: vary thresholds and report curves
 *   pnpm bench --json       # Output machine-readable JSON only
 */

import { initializeLanguages, initParsers } from '../languages/index.js';
import { UniversalSOLIDAnalyzer } from '../analyzers/universal/UniversalSOLIDAnalyzer.js';
import { UniversalDRYAnalyzer } from '../analyzers/universal/UniversalDRYAnalyzer.js';
import { UniversalDataAccessAnalyzer } from '../analyzers/universal/UniversalDataAccessAnalyzer.js';
import { UniversalDocumentationAnalyzer } from '../analyzers/universal/UniversalDocumentationAnalyzer.js';
import { UniversalSchemaAnalyzer } from '../analyzers/universal/UniversalSchemaAnalyzer.js';
import { reactAnalyzer } from '../analyzers/reactAnalyzer.js';
import { invariantsAnalyzer } from '../analyzers/invariantsAnalyzer.js';
import { UniversalStylesAnalyzer } from '../analyzers/universal/UniversalStylesAnalyzer.js';
import { UniversalConventionsAnalyzer } from '../analyzers/universal/UniversalConventionsAnalyzer.js';
import { CodeIndexDB } from '../codeIndexDB.js';
import { fingerprint } from '../fingerprint.js';
import { extractSymbol } from '../symbols.js';
import type { Violation, AnalyzerResult } from '../types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, resolve, relative, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────

interface ExpectedEntry {
  file: string;
  rule: string;
  symbol?: string;  // optional — match any symbol when omitted
  severity?: string;
  reason?: string;  // why this is a known miss (only meaningful in knownMisses)
}

interface ExpectedManifest {
  analyzer: string;
  config?: Record<string, unknown>;
  expectedViolations: ExpectedEntry[];
  /** Ground-truth violations the analyzer cannot currently detect due to known limitations. */
  knownMisses?: ExpectedEntry[];
  nearMissFiles: string[];
  description: string;
}

interface MatchResult {
  expected: ExpectedEntry;
  matched: boolean;
  actualViolation?: Violation;
}

export interface RuleMetrics {
  rule: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  knownMisses: number;
  recoveredMisses: number;
  trueRecall: number;
  trueF1: number;
}

export interface AnalyzerMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  /** Effective recall — computed against reconciled ground truth (excl. known misses). Gates regressions. */
  recall: number;
  /** Effective F1 — from precision + effective recall. */
  f1: number;
  /** True recall — computed against full ground truth (incl. known misses). Measures distance from done. */
  trueRecall: number;
  /** True F1 — from precision + true recall. */
  trueF1: number;
  /** Count of ground-truth violations that are known misses (not detected by the analyzer). */
  knownMisses: number;
  /** Count of known-miss entries that WERE detected — a limitation was fixed. */
  recoveredMisses: number;
  /** Per-rule metrics — precision/recall/F1 for each rule within the analyzer. */
  ruleMetrics: RuleMetrics[];
  nearMissResults: Array<{ file: string; violations: number; passed: boolean }>;
  details: MatchResult[];
  knownMissDetails: MatchResult[];
  warnings: string[];
}

export interface BenchReport {
  timestamp: string;
  summary: {
    totalAnalyzers: number;
    passed: number;
    failed: number;
    totalKnownMisses: number;
    microAvgPrecision: number;
    microAvgRecall: number;
    microAvgF1: number;
    microAvgTrueRecall: number;
    microAvgTrueF1: number;
  };
  analyzers: Record<string, AnalyzerMetrics>;
  baselineComparison?: {
    regressions: string[];
    improvements: string[];
  };
}

interface BaselineFile {
  schemaVersion: number;
  timestamp: string;
  analyzers: Record<string, {
    f1: number; precision: number; recall: number;
    /** Per-rule baseline metrics (schemaVersion >= 2). */
    rules?: Record<string, { f1: number; precision: number; recall: number }>;
  }>;
}

// ── Constants ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const CORPUS_ROOT = join(PROJECT_ROOT, 'bench', 'corpus');
const RESULTS_DIR = join(PROJECT_ROOT, 'bench', 'results');
const BASELINE_PATH = join(PROJECT_ROOT, 'bench', 'baselines', 'baseline.json');

// ── Analyzer registry (mirrors auditRunner DEFAULT_ANALYZERS) ────────────

interface AnalyzerRunner {
  name: string;
  analyze: (files: string[], config: Record<string, unknown>) => Promise<AnalyzerResult>;
}

// ── Styles bench seed data ──────────────────────────────────────────────

/**
 * Seed the in-memory SQLite DB with style declarations that trigger all
 * 7 detectors (10 rule IDs) in UniversalStylesAnalyzer.
 *
 * Expected violations:
 * 1. styles/value-drift (color)  — 20× #1e2328 tokenised + 1× #273828 straggler
 * 2. styles/value-drift (exact)  — 20× 16px + 1× 17px straggler
 * 3. styles/token-bypass         — #1e2328 without token_ref matching --color-primary
 * 4. styles/undefined-class      — obscure-custom-class-xyz in class usage, no definition
 * 5. styles/mechanism-fragmentation — margin:4px via css+tailwind+inline
 * 6. styles/mechanism-mixing     — src/fixture.tsx uses ≥3 mechanisms
 * 7. styles/declaration-set-similarity — two identical 5-decl rule blocks
 * 8. styles/z-index-sprawl       — 7 distinct z-index values (> zIndexMaxDistinct=6)
 * 9. styles/z-index-singleton    — z-index:70 used only once
 *
 * Known miss: styles/off-scale (algorithmic limitation — see expected.json).
 */
function seedStylesData(rawDb: any, files: string[]): void {
  const file = files[0] ?? 'src/fixture.tsx';
  let id = 0;
  const nextId = () => ++id;
  const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

  const insertDecl = (
    property: string,
    rawValue: string,
    mechanism: string,
    line: number,
    tokenRef?: string | null,
    context?: string | null,
    normalizedValue?: string | null,
  ) => {
    rawDb.prepare(
      `INSERT INTO style_declarations (id, property, raw_value, normalized_value, mechanism, file_path, line, context, token_ref, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nextId(),
      property,
      rawValue,
      normalizedValue ?? rawValue,
      mechanism,
      file,
      line,
      context ?? null,
      tokenRef ?? null,
      hash(`${file}:${line}:${property}:${rawValue}`),
    );
  };

  // ── Color drift: 20× #1e2328 tokenised + 1× #273828 straggler ──────
  for (let i = 0; i < 20; i++) {
    insertDecl('background', '#1e2328', 'css', 100 + i, '--color-primary');
  }
  insertDecl('background', '#273828', 'css', 120); // straggler, no token_ref

  // ── Exact-value drift: 20× 16px + 1× 17px straggler ───────────────
  for (let i = 0; i < 20; i++) {
    insertDecl('font-size', '16px', 'css', 200 + i);
  }
  insertDecl('font-size', '17px', 'css', 220); // straggler

  // ── Token bypass: #1e2328 (matches --color-primary) without token_ref
  insertDecl('background-color', '#1e2328', 'css', 300);

  // ── Mechanism fragmentation: margin:4px via 3 mechanisms ───────────
  insertDecl('margin', '4px', 'css', 310);
  insertDecl('margin', '4px', 'tailwind', 311);
  insertDecl('margin', '4px', 'inline', 312);

  // ── Declaration-set similarity: two identical 5-decl rule blocks ───
  const blockA = '.block-a';
  const blockB = '.block-b';
  const sharedPairs: Array<[string, string]> = [
    ['display', 'flex'],
    ['flex-direction', 'column'],
    ['gap', '8px'],
    ['padding', '16px'],
    ['align-items', 'center'],
  ];
  for (const [prop, val] of sharedPairs) {
    insertDecl(prop, val, 'css', 400, null, blockA);
    insertDecl(prop, val, 'css', 410, null, blockB);
  }

  // ── Z-index: 7 distinct values (sprawl), one singleton ─────────────
  // Pair each value twice so total corpus > minCorpus
  const zValues = [10, 20, 30, 40, 50, 60, 70];
  for (const z of zValues) {
    const repeat = z === 70 ? 1 : 2; // 70 is singleton
    for (let i = 0; i < repeat; i++) {
      insertDecl('z-index', String(z), 'css', 500 + z + i);
    }
  }

  // ── Token: --color-primary = #1e2328 ───────────────────────────────
  rawDb.prepare(
    `INSERT INTO style_tokens (name, value, file_path, mechanism)
     VALUES (?, ?, ?, ?)`,
  ).run('--color-primary', '#1e2328', file, 'css');

  // ── Class usage: obscure-custom-class-xyz (undefined in any sheet) ─
  rawDb.prepare(
    `INSERT INTO style_class_usage (class_name, file_path, line, mechanism, unresolvable)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('obscure-custom-class-xyz', file, 1, 'className', 0);
}

function seedConventionsData(rawDb: any, _files: string[]): void {
  const insertFn = rawDb.prepare(
    `INSERT INTO functions (id, name, file_path, line_number, is_exported, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertFn.run(1, 'errorHandler',       'src/fixture.ts',       5,  0, null);
  insertFn.run(2, 'handlePromiseError', 'src/fixture.ts',      15,  0, JSON.stringify({ body: "fetch('/api/data').then(res => res.json()).catch(err => console.error(err))" }));
  insertFn.run(3, 'DefaultExporter',    'src/fixture.ts',      25,  1, null);
  insertFn.run(4, 'my_snake_function',  'src/fixture.ts',      30,  1, null);
  insertFn.run(5, 'approvedHandler',    'src/approved.ts',      5,  0, null);
  insertFn.run(6, 'approvedWithCatch',  'src/approved.ts',     15,  0, JSON.stringify({ body: 'try { doSomething(); } catch (e) { logError(e); }' }));
  insertFn.run(7, 'ApprovedExport',     'src/approved.ts',     25,  1, null);
  insertFn.run(8,  'NoModeDefault',     'src/no-mode/index.ts', 5,  1, null);
  insertFn.run(9,  'noModeCamelFunction','src/no-mode/index.ts',10,  1, null);
  insertFn.run(10, 'noModeTryCatch',    'src/no-mode/index.ts',15,  0, JSON.stringify({ body: 'try { x(); } catch(e) {}' }));
  insertFn.run(11, 'noModeCatch',       'src/no-mode/index.ts',20,  0, JSON.stringify({ body: 'p.then(r => r).catch(err => {})' }));
  insertFn.run(12, 'noModeIfErr',       'src/no-mode/index.ts',25,  0, JSON.stringify({ body: 'if (err) return;' }));

  const insertCall = rawDb.prepare(
    `INSERT INTO function_calls (caller_id, callee_name) VALUES (?, ?)`,
  );
  insertCall.run(1, 'handleError');
  insertCall.run(5, 'handleError');
  insertCall.run(5, 'logError');

  const insertConv = rawDb.prepare(
    `INSERT INTO conventions (id, domain, rule_id, antecedent, consequent, pattern, directory, support, total_cases, confidence, exemplar_file, exemplar_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertConv.run(1, 'usage-pair',     'conventions/usage-pair',     'handleError', 'logError', null,           'src', 95, 100, 0.95, 'src/approved.ts', 5);
  insertConv.run(2, 'import-form',    'conventions/import-form',    'lodash',      'default',  null,           'src', 20,  22, 0.93, 'src/approved.ts', 1);
  insertConv.run(3, 'error-handling', 'conventions/error-handling', null,          null,       'try-catch',    'src', 30,  34, 0.88, 'src/approved.ts', 15);
  insertConv.run(4, 'export-shape',   'conventions/export-shape',   null,          null,       'named',        'src', 18,  20, 0.90, 'src/approved.ts', 25);
  insertConv.run(5, 'naming',         'conventions/naming',         null,          null,       'PascalCase',   'src', 25,  27, 0.92, 'src/approved.ts', 25);
}

// ── Analyzer registry (mirrors auditRunner DEFAULT_ANALYZERS) ────────

function buildAnalyzers(): Record<string, AnalyzerRunner> {
  return {
    conventions: {
      name: 'conventions',
      analyze: async (files, config) => {
        CodeIndexDB.resetInstance();
        const db = CodeIndexDB.getInstance(':memory:');
        await db.initialize();
        const rawDb = (db as any).rawDb;
        seedConventionsData(rawDb, files);
        const analyzer = new UniversalConventionsAnalyzer();
        const corpusDir = dirname(dirname(files[0] || '.'));
        return analyzer.analyze(files, { ...config, projectRoot: resolve(corpusDir) });
      },
    },
    documentation: {
      name: 'documentation',
      analyze: async (files, config) => {
        const analyzer = new UniversalDocumentationAnalyzer();
        return analyzer.analyze(files, config);
      },
    },
    solid: {
      name: 'solid',
      analyze: async (files, config) => {
        const analyzer = new UniversalSOLIDAnalyzer();
        return analyzer.analyze(files, config);
      },
    },
    dry: {
      name: 'dry',
      analyze: async (files, config) => {
        const analyzer = new UniversalDRYAnalyzer();
        return analyzer.analyze(files, config);
      },
    },
    'data-access': {
      name: 'data-access',
      analyze: async (files, config) => {
        const analyzer = new UniversalDataAccessAnalyzer();
        return analyzer.analyze(files, config);
      },
    },
    schema: {
      name: 'schema',
      analyze: async (files, config) => {
        const analyzer = new UniversalSchemaAnalyzer();
        return analyzer.analyze(files, config);
      },
    },
    styles: {
      name: 'styles',
      analyze: async (files, config) => {
        CodeIndexDB.resetInstance();
        const db = CodeIndexDB.getInstance(':memory:');
        await db.initialize();
        const rawDb = (db as any).rawDb;
        seedStylesData(rawDb, files);
        const analyzer = new UniversalStylesAnalyzer();
        return analyzer.analyze(files, config);
      },
    },
    react: {
      name: 'react',
      analyze: async (files, config) => {
        return reactAnalyzer.analyze(files, config, {} as any);
      },
    },
    invariants: {
      name: 'invariants',
      analyze: async (files, _config) => {
        // invariants reads config from .codeauditor.json on disk,
        // projectRoot is derived from the corpus directory
        const corpusDir = dirname(files[0] || '.');
        const projectDir = resolve(corpusDir, '..');
        return invariantsAnalyzer.analyze(files, {}, {
          projectRoot: projectDir,
        } as any);
      },
    },
    'non-english': {
      name: 'non-english',
      analyze: async (files, config) => {
        const analyzer = new UniversalDataAccessAnalyzer();
        return analyzer.analyze(files, config);
      },
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && /\.(ts|tsx|js|jsx|css|scss)$/.test(entry.name) && !entry.name.includes('.d.')) {
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files;
}

function loadManifest(corpusDir: string): ExpectedManifest {
  const path = join(corpusDir, 'expected.json');
  if (!existsSync(path)) {
    throw new Error(`Missing expected.json in ${corpusDir}`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return raw as ExpectedManifest;
}

/**
 * Get the rule identifier for a violation.
 * The React analyzer uses `violationType` instead of `rule`,
 * and for hooks-naming it's in `details.rule`.
 */
function getViolationRule(v: Violation, analyzerName: string): string {
  // Direct rule field
  if (v.rule) return v.rule;

  // React analyzer puts it in details.rule
  if (analyzerName === 'react' && (v as any).details?.rule) {
    return (v as any).details.rule;
  }

  // React analyzer uses violationType as the rule identifier
  if (analyzerName === 'react' && (v as any).violationType) {
    return (v as any).violationType;
  }

  return '';
}

/**
 * Get the symbol for a violation using the same priority chain as extractSymbol.
 */
function getViolationSymbol(v: Violation): string {
  return extractSymbol(v);
}

function loadBaseline(): BaselineFile | null {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as BaselineFile;
}

function saveBaseline(baseline: BaselineFile): void {
  const dir = dirname(BASELINE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
}

// ── Core matching logic ──────────────────────────────────────────────────

function matchViolations(
  violations: Violation[],
  expected: ExpectedEntry[],
  nearMissFiles: string[],
  analyzerName: string,
  knownMisses: ExpectedEntry[] = []
): AnalyzerMetrics {
  const nearMissSet = new Set(nearMissFiles);

  // Partition violations by whether they're from near-miss files
  const nearMissViolations: Violation[] = [];
  const candidateViolations: Violation[] = [];

  for (const v of violations) {
    const vFile = relative('.', v.file);
    const isNearMiss = nearMissFiles.some(nm => vFile.endsWith(nm));
    if (isNearMiss) {
      nearMissViolations.push(v);
    } else {
      candidateViolations.push(v);
    }
  }

  // Match expected violations to actual
  const details: MatchResult[] = [];
  const matchedActual = new Set<number>(); // indices into candidateViolations
  let falseNegatives = 0;

  for (const exp of expected) {
    let found = false;
    for (let i = 0; i < candidateViolations.length; i++) {
      if (matchedActual.has(i)) continue;
      const v = candidateViolations[i];
      const vFile = relative('.', v.file);
      const vRule = getViolationRule(v, analyzerName);
      const vSymbol = getViolationSymbol(v);

      // Match by file (suffix), rule, and optionally symbol
      const fileMatch = vFile.endsWith(exp.file);
      const ruleMatch = vRule === exp.rule;
      // Symbol match: only when expected.symbol is explicitly set
      const symbolMatch = !exp.symbol || exp.symbol === '' || vSymbol === exp.symbol;

      if (fileMatch && ruleMatch && symbolMatch) {
        matchedActual.add(i);
        found = true;
        details.push({ expected: exp, matched: true, actualViolation: v });
        break;
      }
    }

    if (!found) {
      falseNegatives++;
      details.push({ expected: exp, matched: false });
    }
  }

  const truePositives = matchedActual.size;

  // Collect unmatched expected entries for known-miss reconciliation
  const unmatchedExpected = details
    .filter(d => !d.matched)
    .map(d => d.expected);

  // Match known-miss entries against remaining actual violations.
  // Known misses are ground-truth violations the analyzer cannot currently
  // detect. They are NOT false negatives — they're acknowledged gaps.
  // If a known-miss entry DOES match (the limitation was fixed), it becomes
  // a "recovered miss" — informational, not a scoring penalty.
  const knownMissDetails: MatchResult[] = [];
  const matchedActualByKnown = new Set<number>();
  let reconciledFalseNegatives = 0;
  for (const km of knownMisses) {
    let found = false;
    // First: check if this known-miss matches a remaining actual violation
    // (recovered miss — the limitation was fixed)
    for (let i = 0; i < candidateViolations.length; i++) {
      if (matchedActual.has(i) || matchedActualByKnown.has(i)) continue;
      const v = candidateViolations[i];
      const vFile = relative('.', v.file);
      const vRule = getViolationRule(v, analyzerName);
      const vSymbol = getViolationSymbol(v);

      const fileMatch = vFile.endsWith(km.file);
      const ruleMatch = vRule === km.rule;
      const symbolMatch = !km.symbol || km.symbol === '' || vSymbol === km.symbol;

      if (fileMatch && ruleMatch && symbolMatch) {
        matchedActualByKnown.add(i);
        found = true;
        knownMissDetails.push({ expected: km, matched: true, actualViolation: v });
        break;
      }
    }
    if (!found) {
      // Second: check if a matched expected entry now covers this known-miss's
      // file+rule — the limitation was fixed, but the expected entry consumed
      // the actual violation before the known-miss could claim it directly.
      const recovered = details.some(d =>
        d.matched &&
        d.expected.file === km.file &&
        d.expected.rule === km.rule &&
        (!km.symbol || km.symbol === '' || (d.expected as any).symbol === km.symbol)
      );
      if (recovered) {
        knownMissDetails.push({ expected: km, matched: true });
      } else {
        knownMissDetails.push({ expected: km, matched: false });
        // Check if this known-miss corresponds to an unmatched expected entry —
        // if so, it explains a false negative and should be reconciled.
        const reconciles = unmatchedExpected.some(ue =>
          ue.file === km.file && ue.rule === km.rule &&
          (!km.symbol || km.symbol === '' || ue.symbol === km.symbol)
        );
        if (reconciles) {
          reconciledFalseNegatives++;
        }
      }
    }
  }

  const recoveredMisses = knownMissDetails.filter(d => d.matched).length;
  const stillKnownMisses = knownMisses.length - recoveredMisses;

  // Reduce falseNegatives by the number reconciled via known-miss annotations
  falseNegatives = Math.max(0, falseNegatives - reconciledFalseNegatives);

  // Unmatched actual violations — exclude those matched by known-miss entries
  // so fixing a known limitation doesn't create false positives.
  const unmatchedActual = candidateViolations.length - truePositives - matchedActualByKnown.size;
  const falsePositives = Math.max(0, unmatchedActual);
  const nearMissFailures = nearMissViolations.filter(v => {
    const vRule = getViolationRule(v, analyzerName);
    return vRule !== ''; // ignore violations without identifiable rules
  });

  // Near-miss files that fired
  const nearMissResults = nearMissFiles.map(nm => {
    const viols = nearMissViolations.filter(v => relative('.', v.file).endsWith(nm));
    return { file: nm, violations: viols.length, passed: viols.length === 0 };
  });

  // Add near-miss false positives
  const totalFalsePositives = falsePositives + nearMissFailures.length;

  const precision = truePositives + totalFalsePositives > 0
    ? truePositives / (truePositives + totalFalsePositives)
    : 1.0;

  const recall = truePositives + falseNegatives > 0
    ? truePositives / (truePositives + falseNegatives)
    : 1.0;

  const f1 = precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0;

  // True recall: against full ground truth (expected + non-overlapping known misses).
  // Known-miss entries that reconcile with an expected violation are annotations on that
  // same ground-truth entry — don't double-count. Non-overlapping known-misses (if any)
  // represent additional real violations not yet listed in expectedViolations.
  const totalGroundTruth = expected.length + (stillKnownMisses - reconciledFalseNegatives);
  const trueRecall = totalGroundTruth > 0
    ? truePositives / totalGroundTruth
    : 1.0;
  const trueF1 = precision + trueRecall > 0
    ? (2 * precision * trueRecall) / (precision + trueRecall)
    : 0;

  const warnings: string[] = [];
  if (nearMissFailures.length > 0) {
    warnings.push(`${nearMissFailures.length} unexpected violation(s) in near-miss files`);
  }
  if (recoveredMisses > 0) {
    warnings.push(`${recoveredMisses} known-miss(es) flipped to recovered — delete the stale knownMisses annotation(s)`);
  }

  // Per-rule metrics — group matched/unmatched by rule
  const ruleCounts = new Map<string, { tp: number; fp: number; fn: number; km: number; rm: number }>();
  const ensureRule = (rule: string) => {
    if (!ruleCounts.has(rule)) ruleCounts.set(rule, { tp: 0, fp: 0, fn: 0, km: 0, rm: 0 });
    return ruleCounts.get(rule)!;
  };

  for (const d of details) {
    const rule = d.expected.rule || 'unknown';
    const rc = ensureRule(rule);
    if (d.matched) rc.tp++; else rc.fn++;
  }
  for (let i = 0; i < candidateViolations.length; i++) {
    if (matchedActual.has(i) || matchedActualByKnown.has(i)) continue;
    const rule = getViolationRule(candidateViolations[i], analyzerName) || 'unknown';
    ensureRule(rule).fp++;
  }
  for (const v of nearMissViolations) {
    const rule = getViolationRule(v, analyzerName) || 'unknown';
    ensureRule(rule).fp++;
  }
  for (const km of knownMissDetails) {
    const rule = km.expected.rule || 'unknown';
    const rc = ensureRule(rule);
    if (km.matched) rc.rm++; else rc.km++;
  }

  const ruleMetrics: RuleMetrics[] = Array.from(ruleCounts.entries())
    .map(([rule, rc]) => {
      const rPrecision = rc.tp + rc.fp > 0 ? rc.tp / (rc.tp + rc.fp) : 1.0;
      const rRecall = rc.tp + rc.fn > 0 ? rc.tp / (rc.tp + rc.fn) : 1.0;
      const rF1 = rPrecision + rRecall > 0 ? (2 * rPrecision * rRecall) / (rPrecision + rRecall) : 0;
      const rTotalGT = rc.tp + rc.fn + rc.km;
      const rTrueRecall = rTotalGT > 0 ? rc.tp / rTotalGT : 1.0;
      const rTrueF1 = rPrecision + rTrueRecall > 0 ? (2 * rPrecision * rTrueRecall) / (rPrecision + rTrueRecall) : 0;
      return {
        rule,
        truePositives: rc.tp,
        falsePositives: rc.fp,
        falseNegatives: rc.fn,
        precision: Math.round(rPrecision * 10000) / 10000,
        recall: Math.round(rRecall * 10000) / 10000,
        f1: Math.round(rF1 * 10000) / 10000,
        knownMisses: rc.km,
        recoveredMisses: rc.rm,
        trueRecall: Math.round(rTrueRecall * 10000) / 10000,
        trueF1: Math.round(rTrueF1 * 10000) / 10000,
      };
    })
    .sort((a, b) => a.rule.localeCompare(b.rule));

  return {
    truePositives,
    falsePositives: totalFalsePositives,
    falseNegatives,
    precision: Math.round(precision * 10000) / 10000,
    recall: Math.round(recall * 10000) / 10000,
    f1: Math.round(f1 * 10000) / 10000,
    trueRecall: Math.round(trueRecall * 10000) / 10000,
    trueF1: Math.round(trueF1 * 10000) / 10000,
    knownMisses: stillKnownMisses,
    recoveredMisses,
    ruleMetrics,
    nearMissResults,
    details,
    knownMissDetails,
    warnings,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes('--json');
  const sweepMode = args.includes('--sweep');
  const sweepParam = args.includes('--sweep')
    ? (args[args.indexOf('--sweep') + 1] ?? null)
    : null;

  if (!jsonOnly) {
    console.log('\n🔬 Code Auditor — Benchmark Harness\n');
  }

  if (sweepMode) {
    initializeLanguages();
    await initParsers();
    const corpusDirs: string[] = [];
    const entries = await readdir(CORPUS_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) corpusDirs.push(join(CORPUS_ROOT, entry.name));
    }
    const analyzersForSweep = buildAnalyzers();
    const { curves } = await runSweep(corpusDirs, analyzersForSweep, jsonOnly, sweepParam);
    if (!jsonOnly) {
      console.log('══════════════════════════════════════════════');
      console.log('  Sweep Summary');
      console.log('══════════════════════════════════════════════');
      const changed = curves.filter(c => !c.confirmed);
      const confirmed = curves.filter(c => c.confirmed);
      console.log(`  Total: ${curves.length}  Confirmed: ${confirmed.length}  Changed: ${changed.length}`);
      if (changed.length > 0) {
        console.log('\n  Changed defaults (precision-first):');
        for (const c of changed) {
          console.log(`    ${c.parameter.label}: ${c.parameter.configKey} = ${c.currentDefault} → ${c.recommended.value}`);
        }
      }
      console.log();
    } else {
      console.log(JSON.stringify({ sweeps: curves.map(c => ({
        parameter: c.parameter,
        recommended: c.recommended.value,
        currentDefault: c.currentDefault,
        confirmed: c.confirmed,
        points: c.points,
      })) }, null, 2));
    }
    return;
  }

  const report = await runBench();

  if (!jsonOnly) {
    // Print per-analyzer results
    for (const [name, metrics] of Object.entries(report.analyzers).sort()) {
      printAnalyzerResults(name, metrics);
    }
    printReport(report);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  // Regression gate — fail if any analyzer dropped below baseline
  const regressions = report.baselineComparison?.regressions ?? [];
  if (regressions.length > 0) {
    console.error(`\n❌ F1 regression detected: ${regressions.length} analyzer(s) below baseline`);
    for (const r of regressions) {
      console.error(`   ${r}`);
    }
    process.exit(1);
  }

  // Also fail if any basic fixture didn't get 100% recall (unexpected gap)
  const totalFailures = report.summary.failed;
  if (totalFailures > 0) {
    console.error(`\n❌ ${totalFailures} analyzer(s) have unmatched expected violations`);
    process.exit(1);
  }
}

// ── Single corpus run ────────────────────────────────────────────────────

async function runSingleCorpus(
  corpusDir: string,
  analyzers: Record<string, AnalyzerRunner>,
  report: BenchReport,
  print: boolean
): Promise<void> {
  const name = corpusDir.split('/').pop()!;
  const manifest = loadManifest(corpusDir);

  if (print) {
    console.log(`── ${manifest.analyzer} (${manifest.description}) ──`);
  }

  const runner = analyzers[manifest.analyzer];
  if (!runner) {
    console.log(`  ⚠️  No runner for analyzer "${manifest.analyzer}" — skipping`);
    return;
  }

  const srcDir = join(corpusDir, 'src');
  const files = existsSync(srcDir) ? await collectFiles(srcDir) : [];

  if (files.length === 0) {
    console.log(`  ⚠️  No source files found in ${corpusDir}/src — skipping`);
    return;
  }

  const config = manifest.config ?? {};
  const result = await runner.analyze(files, config);

  const metrics = matchViolations(
    result.violations,
    manifest.expectedViolations,
    manifest.nearMissFiles,
    manifest.analyzer,
    manifest.knownMisses ?? []
  );

  report.analyzers[manifest.analyzer] = metrics;

  if (print) {
    printAnalyzerResults(manifest.analyzer, metrics);
  }
}

// ── Sweep mode ───────────────────────────────────────────────────────────

interface SweepParameter {
  /** Config key in the analyzer's config object */
  configKey: string;
  /** Human-readable label */
  label: string;
  /** Values to sweep through */
  values: number[];
  /** Analyzer name for this parameter */
  analyzer: string;
  /** The shipped default value (what users get without custom config) */
  shippedDefault: number;
}

interface SweepPoint {
  value: number;
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

interface SweepCurve {
  parameter: SweepParameter;
  points: SweepPoint[];
  /** Precision-first operating point (highest precision, ties broken by highest recall) */
  recommended: SweepPoint;
  currentDefault: number;
  confirmed: boolean; // true if recommended === currentDefault
}

/**
 * Define sweepable parameters per analyzer.
 * Each parameter has a config key, label, and range of values to sweep.
 */
function buildSweepParameters(): SweepParameter[] {
  return [
    // ── DRY analyzer ──────────────────────────────────────────────────────
    { configKey: 'minLineThreshold', label: 'DRY minLineThreshold', analyzer: 'dry',
      shippedDefault: 15, values: [3, 5, 8, 10, 12, 15, 20, 30] },
    { configKey: 'similarityThreshold', label: 'DRY similarityThreshold', analyzer: 'dry',
      shippedDefault: 0.85, values: [0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95] },

    // ── React analyzer ────────────────────────────────────────────────────
    { configKey: 'maxComponentComplexity', label: 'React maxComponentComplexity', analyzer: 'react',
      shippedDefault: 15, values: [5, 8, 10, 12, 15, 20, 25, 30] },
    { configKey: 'wrapperMinUsages', label: 'React wrapperMinUsages', analyzer: 'react',
      shippedDefault: 4, values: [2, 3, 4, 5, 6, 8, 10, 15] },

    // ── SOLID analyzer — method-level complexity ─────────────────────────
    { configKey: 'maxMethodComplexity', label: 'SOLID maxMethodComplexity', analyzer: 'solid',
      shippedDefault: 50, values: [5, 10, 15, 20, 30, 50, 75, 100] },
    { configKey: 'maxLinesPerMethod', label: 'SOLID maxLinesPerMethod', analyzer: 'solid',
      shippedDefault: 50, values: [10, 20, 30, 50, 75, 100, 150] },
    { configKey: 'maxParametersPerMethod', label: 'SOLID maxParametersPerMethod', analyzer: 'solid',
      shippedDefault: 4, values: [2, 3, 4, 5, 6, 8, 10] },
    { configKey: 'maxImportsPerFile', label: 'SOLID maxImportsPerFile', analyzer: 'solid',
      shippedDefault: 20, values: [5, 10, 15, 20, 25, 30, 40, 50] },
    { configKey: 'classMethodsThreshold', label: 'SOLID classMethodsThreshold', analyzer: 'solid',
      shippedDefault: 15, values: [5, 8, 10, 12, 15, 20, 30] },
    { configKey: 'classAggregateComplexity', label: 'SOLID classAggregateComplexity', analyzer: 'solid',
      shippedDefault: 100, values: [20, 40, 60, 80, 100, 150, 200, 300] },

    // ── Schema analyzer ───────────────────────────────────────────────────
    { configKey: 'maxQueriesPerFunction', label: 'Schema maxQueriesPerFunction', analyzer: 'schema',
      shippedDefault: 5, values: [1, 2, 3, 4, 5, 7, 10, 15] },

    // ── Data-access analyzer ──────────────────────────────────────────────
    { configKey: 'joinedTableCount', label: 'Data-access joinedTableCount', analyzer: 'data-access',
      shippedDefault: 2, values: [2, 3, 4, 5, 6, 8, 10] },

    // ── Documentation analyzer ────────────────────────────────────────────
    { configKey: 'minDescriptionLength', label: 'Documentation minDescriptionLength', analyzer: 'documentation',
      shippedDefault: 10, values: [2, 5, 10, 15, 20, 30, 50] },

    // ── Style analyzer (Spec 10 — registered for future use) ──────────────
    { configKey: 'colorDeltaE', label: 'Style colorDeltaE', analyzer: 'styles',
      shippedDefault: 3.0, values: [1.0, 2.0, 3.0, 5.0, 7.0, 10.0, 15.0] },
    { configKey: 'outlierMaxShare', label: 'Style outlierMaxShare', analyzer: 'styles',
      shippedDefault: 0.05, values: [0.01, 0.03, 0.05, 0.07, 0.10, 0.15, 0.20] },
    { configKey: 'modeMinCount', label: 'Style modeMinCount', analyzer: 'styles',
      shippedDefault: 3, values: [1, 2, 3, 5, 7, 10, 15] },
    { configKey: 'styleSimilarityThreshold', label: 'Style similarityThreshold', analyzer: 'styles',
      shippedDefault: 0.75, values: [0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95] },
    { configKey: 'zIndexMaxDistinct', label: 'Style zIndexMaxDistinct', analyzer: 'styles',
      shippedDefault: 5, values: [3, 5, 7, 10, 15, 20, 30] },
    { configKey: 'minCorpus', label: 'Style minCorpus', analyzer: 'styles',
      shippedDefault: 3, values: [1, 2, 3, 5, 8, 10, 15] },
  ];
}

async function runSweep(
  corpusDirs: string[],
  analyzers: Record<string, AnalyzerRunner>,
  jsonOnly: boolean,
  sweepParam?: string | null
): Promise<{ curves: SweepCurve[] }> {
  const parameters = buildSweepParameters().filter(p => {
    if (!sweepParam) return true;
    // Filter by config key or analyzer match
    return p.configKey === sweepParam || p.analyzer === sweepParam || p.label.includes(sweepParam);
  });
  const allCurves: SweepCurve[] = [];

  if (!jsonOnly) {
    console.log(`Sweeping ${parameters.length} parameters across ${corpusDirs.length} fixtures...\n`);
  }

  for (const param of parameters) {
    // Find the corpus dir for this analyzer
    const corpusDir = corpusDirs.find(d => d.endsWith(param.analyzer));
    if (!corpusDir) {
      if (!jsonOnly) console.log(`  ⚠️  No corpus for ${param.analyzer} — skipping ${param.label}`);
      continue;
    }

    const manifest = loadManifest(corpusDir);
    const runner = analyzers[manifest.analyzer];
    if (!runner) continue;

    const srcDir = join(corpusDir, 'src');
    if (!existsSync(srcDir)) continue;
    const files = await collectFiles(srcDir);

    // Use the shipped default — what users actually get without custom config
    const currentDefault = param.shippedDefault;

    const points: SweepPoint[] = [];

    for (const value of param.values) {
      const config: Record<string, unknown> = { ...(manifest.config ?? {}) };
      // Handle nested keys like 'performanceThresholds.joinedTableCount'
      if (param.configKey.includes('.')) {
        const [parent, child] = param.configKey.split('.');
        config[parent] = { ...((config[parent] as Record<string, unknown>) ?? {}), [child]: value };
      } else {
        config[param.configKey] = value;
      }

      const result = await runner.analyze(files, config);
      const metrics = matchViolations(
        result.violations,
        manifest.expectedViolations,
        manifest.nearMissFiles,
        manifest.analyzer,
        manifest.knownMisses ?? []
      );

      points.push({
        value,
        precision: metrics.precision,
        recall: metrics.recall,
        f1: metrics.f1,
        truePositives: metrics.truePositives,
        falsePositives: metrics.falsePositives,
        falseNegatives: metrics.falseNegatives,
      });
    }

    // Pick precision-first operating point: highest precision, break ties with highest recall
    const recommended = points.reduce((best, p) => {
      if (p.precision > best.precision) return p;
      if (p.precision === best.precision && p.recall > best.recall) return p;
      return best;
    });

    const curve: SweepCurve = {
      parameter: param,
      points,
      recommended,
      currentDefault,
      confirmed: Math.abs(recommended.value - currentDefault) < 0.01,
    };

    allCurves.push(curve);

    if (!jsonOnly) {
      printSweepCurve(curve);
    }
  }

  // Generate sweep report
  if (!jsonOnly && allCurves.length > 0) {
    generateSweepReport(allCurves);
  }

  return { curves: allCurves };
}

function printSweepCurve(curve: SweepCurve): void {
  const { parameter, points, recommended, currentDefault } = curve;
  console.log(`── ${parameter.label} ──`);
  console.log(`   Value │ Precision │ Recall    │ F1        │ TP │ FP │ FN`);
  console.log(`   ${'─'.repeat(6)}┼${'─'.repeat(11)}┼${'─'.repeat(11)}┼${'─'.repeat(11)}┼${'─'.repeat(4)}┼${'─'.repeat(4)}┼${'─'.repeat(4)}`);
  for (const p of points) {
    const marker = p.value === recommended.value ? '◀' : ' ';
    console.log(`   ${String(p.value).padEnd(6)}│ ${p.precision.toFixed(4).padEnd(9)}│ ${p.recall.toFixed(4).padEnd(9)}│ ${p.f1.toFixed(4).padEnd(9)}│ ${String(p.truePositives).padEnd(2)}│ ${String(p.falsePositives).padEnd(2)}│ ${String(p.falseNegatives).padEnd(2)} ${marker}`);
  }
  const status = curve.confirmed ? '✅ CONFIRMED' : `⚠️  CHANGE: ${currentDefault} → ${recommended.value}`;
  console.log(`   Default: ${currentDefault} → Recommended: ${recommended.value} (precision-first) ${status}\n`);
}

// ── Sweep report generation ──────────────────────────────────────────────

/**
 * Generate bench/results/sweep-report.md from sweep curves.
 * Spec 11 R3.4: "A sweep-report.md is generated into bench/results/ with
 * per-parameter curves, chosen operating points, and the delta between
 * the previous shipped default and the new one (if any)."
 */
function generateSweepReport(curves: SweepCurve[]): void {
  const now = new Date().toISOString();
  const confirmed = curves.filter(c => c.confirmed);
  const changed = curves.filter(c => !c.confirmed);

  let md = `# Sweep Report

**Generated:** ${now}
**Parameters swept:** ${curves.length}
**Confirmed (no change):** ${confirmed.length}
**Changed:** ${changed.length}

## Summary

| Parameter | Current | Recommended | Status |
|-----------|---------|-------------|--------|
`;

  for (const curve of curves) {
    const status = curve.confirmed ? '✅ CONFIRMED' : '⚠️ CHANGED';
    md += `| ${curve.parameter.label} | ${curve.currentDefault} | ${curve.recommended.value} | ${status} |\n`;
  }

  if (changed.length > 0) {
    md += `\n### Changes Required\n\n`;
    md += `These defaults should be updated in \`src/config/defaults.ts\`:\n\n`;
    for (const c of changed) {
      md += `- **${c.parameter.label}**: \`${c.parameter.configKey}: ${c.currentDefault}\` → \`${c.recommended.value}\`\n`;
    }
  }

  // Per-parameter curves
  md += `\n## Per-Parameter Curves\n\n`;

  for (const curve of curves) {
    const { parameter, points, recommended, currentDefault } = curve;
    const status = curve.confirmed ? '✅ CONFIRMED' : '⚠️ CHANGED';

    md += `### ${parameter.label}\n\n`;
    md += `- **Analyzer:** \`${parameter.analyzer}\`\n`;
    md += `- **Config key:** \`${parameter.configKey}\`\n`;
    md += `- **Selection:** precision-first (highest precision; ties broken by highest recall)\n`;
    md += `- **Current default:** ${currentDefault}\n`;
    md += `- **Recommended:** ${recommended.value} ${status}\n\n`;

    md += `| Value | Precision | Recall | F1 | TP | FP | FN |\n`;
    md += `|-------|-----------|--------|----|----|----|----|\n`;

    for (const p of points) {
      const marker = p.value === recommended.value ? ' **← chosen**' : '';
      md += `| ${p.value} | ${p.precision.toFixed(4)} | ${p.recall.toFixed(4)} | ${p.f1.toFixed(4)} | ${p.truePositives} | ${p.falsePositives} | ${p.falseNegatives}${marker} |\n`;
    }
    md += '\n';
  }

  // Caveat about minimal corpus
  md += `## Notes\n\n`;
  md += `- The bench corpus is intentionally minimal (1-9 fixtures per analyzer). `;
  md += `For parameters where the minimal corpus cannot discriminate between threshold values `;
  md += `(e.g., all values produce identical metrics on a single fixture), the precision-first `;
  md += `selection picks the most permissive value. Real-corpus triage (Spec 11 R4) validates `;
  md += `these recommendations against external repositories.\n`;
  md += `- Style analyzer parameters (Spec 10) have no corpus and were skipped. They will be `;
  md += `calibrated when the analyzer is implemented.\n`;

  // Save
  const reportPath = join(RESULTS_DIR, 'sweep-report.md');
  writeFileSync(reportPath, md);
  if (process.env['NODE_ENV'] !== 'test') {
    console.log(`\n  Report saved: bench/results/sweep-report.md`);
  }
}

// ── Output ───────────────────────────────────────────────────────────────

function printAnalyzerResults(name: string, metrics: AnalyzerMetrics): void {
  console.log(`  TP: ${metrics.truePositives}  FP: ${metrics.falsePositives}  FN: ${metrics.falseNegatives}`);
  const recallLine = metrics.knownMisses > 0
    ? `  Precision: ${metrics.precision.toFixed(4)}  Recall: ${metrics.recall.toFixed(4)} effective / ${metrics.trueRecall.toFixed(4)} vs ground truth  F1: ${metrics.f1.toFixed(4)} effective / ${metrics.trueF1.toFixed(4)} vs ground truth`
    : `  Precision: ${metrics.precision.toFixed(4)}  Recall: ${metrics.recall.toFixed(4)}  F1: ${metrics.f1.toFixed(4)}`;
  console.log(recallLine);

  if (metrics.knownMisses > 0 || metrics.recoveredMisses > 0) {
    const parts: string[] = [];
    if (metrics.knownMisses > 0) parts.push(`${metrics.knownMisses} known miss(es)`);
    if (metrics.recoveredMisses > 0) parts.push(`${metrics.recoveredMisses} recovered`);
    console.log(`  ⚡ ${parts.join(', ')}`);
  }

  for (const detail of metrics.knownMissDetails) {
    const prefix = detail.matched ? '  ✅ Recovered:' : '  💤 Known miss:';
    const reason = detail.expected.reason ? ` (${detail.expected.reason})` : '';
    console.log(`${prefix} ${detail.expected.file} [${detail.expected.rule}]${reason}`);
  }

  for (const detail of metrics.details) {
    if (!detail.matched) {
      console.log(`  ❌ Missed: ${detail.expected.file} [${detail.expected.rule}] ${detail.expected.symbol || '(any)'}`);
    }
  }

  for (const nm of metrics.nearMissResults) {
    if (!nm.passed) {
      console.log(`  ⚠️  Near-miss fired: ${nm.file} (${nm.violations} violation(s))`);
    }
  }

  for (const w of metrics.warnings) {
    console.log(`  ⚠️  ${w}`);
  }

  // Per-rule breakdown
  if (metrics.ruleMetrics.length > 0) {
    console.log(`  ── Per-Rule ──`);
    console.log(`    ${'Rule'.padEnd(30)} │ Prec    │ Recall  │ F1      │ TP │ FP │ FN ${metrics.knownMisses > 0 ? '│ KM' : ''} ${metrics.recoveredMisses > 0 ? '│ Rec' : ''}`);
    for (const rm of metrics.ruleMetrics) {
      const km = metrics.knownMisses > 0 ? `│ ${String(rm.knownMisses).padEnd(2)}` : '';
      const rec = metrics.recoveredMisses > 0 ? `│ ${String(rm.recoveredMisses).padEnd(3)}` : '';
      const flag = rm.f1 < 1.0 ? ' ⚠️' : '';
      console.log(`    ${rm.rule.padEnd(30)} │ ${rm.precision.toFixed(4)} │ ${rm.recall.toFixed(4)} │ ${rm.f1.toFixed(4)} │ ${String(rm.truePositives).padStart(2)} │ ${String(rm.falsePositives).padStart(2)} │ ${String(rm.falseNegatives).padStart(2)} ${km} ${rec}${flag}`);
    }
    console.log();
  }

  const passed = metrics.falseNegatives === 0 && metrics.falsePositives === 0;
  const statusIcon = passed ? '✅' : '❌';
  const statusLabel = passed
    ? (metrics.knownMisses > 0 ? `PASS (${metrics.knownMisses} known miss(es))` : 'PASS')
    : 'FAIL';
  console.log(`  ${statusIcon} ${statusLabel}\n`);
}

function printReport(report: BenchReport): void {
  console.log('══════════════════════════════════════════════');
  console.log('  Summary');
  console.log('══════════════════════════════════════════════');
  console.log(`  Analyzers: ${report.summary.totalAnalyzers}`);
  console.log(`  Passed:    ${report.summary.passed}`);
  console.log(`  Failed:    ${report.summary.failed}`);
  if (report.summary.totalKnownMisses > 0) {
    console.log(`  Known misses: ${report.summary.totalKnownMisses}`);
  }
  console.log(`  μPrecision: ${report.summary.microAvgPrecision.toFixed(4)}`);
  console.log(`  μRecall:    ${report.summary.microAvgRecall.toFixed(4)}`);
  console.log(`  μF1:        ${report.summary.microAvgF1.toFixed(4)}`);
  if (report.summary.totalKnownMisses > 0) {
    console.log(`  μTrueRecall: ${report.summary.microAvgTrueRecall.toFixed(4)}`);
    console.log(`  μTrueF1:     ${report.summary.microAvgTrueF1.toFixed(4)}`);
  }

  if (report.baselineComparison) {
    if (report.baselineComparison.regressions.length > 0) {
      console.log(`\n  ⚠️  Regressions:`);
      for (const r of report.baselineComparison.regressions) {
        console.log(`     ${r}`);
      }
    }
    if (report.baselineComparison.improvements.length > 0) {
      console.log(`\n  📈 Improvements:`);
      for (const imp of report.baselineComparison.improvements) {
        console.log(`     ${imp}`);
      }
    }
  }

  console.log(`\n  Report: bench/results/latest.json\n`);
}

// ── Public API for programmatic use ──────────────────────────────────────

/**
 * Run the full bench harness and return the report.
 * Exported so tests can assert bench results programmatically.
 */
export async function runBench(): Promise<BenchReport> {
  initializeLanguages();
  await initParsers();

  const analyzers = buildAnalyzers();

  // Discover corpus directories
  const corpusDirs: string[] = [];
  const entries = await readdir(CORPUS_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      corpusDirs.push(join(CORPUS_ROOT, entry.name));
    }
  }

  if (corpusDirs.length === 0) {
    throw new Error(`No corpus directories found in ${CORPUS_ROOT}`);
  }

  // Ensure results directory
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const report: BenchReport = {
    timestamp: new Date().toISOString(),
    summary: { totalAnalyzers: 0, passed: 0, failed: 0, totalKnownMisses: 0, microAvgPrecision: 0, microAvgRecall: 0, microAvgF1: 0, microAvgTrueRecall: 0, microAvgTrueF1: 0 },
    analyzers: {},
  };

  for (const corpusDir of corpusDirs.sort()) {
    await runSingleCorpus(corpusDir, analyzers, report, false);
  }

  // Compute micro-averages
  let totalTP = 0, totalFP = 0, totalFN = 0, totalTrueFN = 0;
  for (const metrics of Object.values(report.analyzers)) {
    totalTP += metrics.truePositives;
    totalFP += metrics.falsePositives;
    totalFN += metrics.falseNegatives;
    totalTrueFN += metrics.falseNegatives + metrics.knownMisses;
  }

  report.summary.totalAnalyzers = Object.keys(report.analyzers).length;
  report.summary.microAvgPrecision = Math.round((totalTP / (totalTP + totalFP || 1)) * 10000) / 10000;
  report.summary.microAvgRecall = Math.round((totalTP / (totalTP + totalFN || 1)) * 10000) / 10000;
  report.summary.microAvgF1 = Math.round(
    (2 * report.summary.microAvgPrecision * report.summary.microAvgRecall /
      (report.summary.microAvgPrecision + report.summary.microAvgRecall || 1)) * 10000
  ) / 10000;
  report.summary.microAvgTrueRecall = Math.round((totalTP / (totalTP + totalTrueFN || 1)) * 10000) / 10000;
  report.summary.microAvgTrueF1 = Math.round(
    (2 * report.summary.microAvgPrecision * report.summary.microAvgTrueRecall /
      (report.summary.microAvgPrecision + report.summary.microAvgTrueRecall || 1)) * 10000
  ) / 10000;

  // Compare against baseline
  const baseline = loadBaseline();
  if (baseline) {
    report.baselineComparison = { regressions: [], improvements: [] };
    for (const [name, metrics] of Object.entries(report.analyzers)) {
      const bl = baseline.analyzers[name];
      if (bl && metrics.f1 < bl.f1) {
        report.baselineComparison.regressions.push(
          `${name}: F1 ${bl.f1} → ${metrics.f1} (Δ${Math.round((metrics.f1 - bl.f1) * 10000) / 100})`
        );
      } else if (bl && metrics.f1 > bl.f1) {
        report.baselineComparison.improvements.push(
          `${name}: F1 ${bl.f1} → ${metrics.f1} (+${Math.round((metrics.f1 - bl.f1) * 10000) / 100})`
        );
      }

      // Per-rule baseline comparison (schemaVersion >= 2)
      if (bl?.rules && metrics.ruleMetrics.length > 0) {
        for (const rm of metrics.ruleMetrics) {
          const ruleBl = bl.rules[rm.rule];
          if (!ruleBl) continue; // new rule — no baseline
          if (rm.f1 < ruleBl.f1) {
            report.baselineComparison.regressions.push(
              `  ${name}/${rm.rule}: F1 ${ruleBl.f1} → ${rm.f1} (Δ${Math.round((rm.f1 - ruleBl.f1) * 10000) / 100})`
            );
          } else if (rm.f1 > ruleBl.f1) {
            report.baselineComparison.improvements.push(
              `  ${name}/${rm.rule}: F1 ${ruleBl.f1} → ${rm.f1} (+${Math.round((rm.f1 - ruleBl.f1) * 10000) / 100})`
            );
          }
        }
      }
    }
  }

  for (const [name, metrics] of Object.entries(report.analyzers)) {
    const allMatched = metrics.falseNegatives === 0 && metrics.falsePositives === 0;
    report.summary.passed += allMatched ? 1 : 0;
    report.summary.failed += allMatched ? 0 : 1;
    report.summary.totalKnownMisses += metrics.knownMisses;
  }

  // Save machine-readable report
  writeFileSync(join(RESULTS_DIR, 'latest.json'), JSON.stringify(report, null, 2) + '\n');

  return report;
}

// ── CLI entry point ─────────────────────────────────────────────────────

if (process.argv[1] && (process.argv[1].endsWith('runBench.ts') || process.argv[1].endsWith('runBench.js'))) {
  main().catch(err => {
    console.error('Bench harness error:', err);
    process.exit(2);
  });
}
