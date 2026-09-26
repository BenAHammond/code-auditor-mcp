/**
 * Spec 68 §3.2 vertical slice — the phase runner: Parse → Process → Analyze.
 *
 * This is the in-process proof of the phase model for ONE fact kind
 * (`file-symbols`) and its SOLID rules. It is deliberately not the full §6
 * distributed runner (bounded work queue, parent/worker, index-backed facts);
 * that lands in §6. What this proves, once, is the contract the whole model
 * turns on:
 *
 *   - Parse produces a `ParsedFile` whose `ast` lives only here (it is freed
 *     after the processor runs and never crosses the Process→Analyze boundary).
 *   - Process runs the `file-symbols` producer per file and concatenates the
 *     fragments into the corpus-wide `file-symbols` fact.
 *   - Analyze hands that fact — and nothing else — to each SOLID rule, whose
 *     `analyze` is pure threshold comparison over plain data.
 *
 * §6 replaces the parse loop with fan-out and the `thresholds` literal with
 * resolved config; the three-phase ordering and the "rules read facts, never
 * ASTs" property are already fixed here.
 */

import { LanguageRegistry } from '../languages/LanguageRegistry.js';
import { PRODUCERS } from './producers.js';
import { solidRules } from './rules/solid.js';
import { dataAccessRules } from './rules/dataAccess.js';
import type {
  ParsedFile,
  FileSymbols,
  ResolvedQuery,
  Format,
  ThresholdValues,
  Finding,
} from './types.js';

/** A file to parse, with its source already read (the CLI reads it in §11). */
export type InputFile = { readonly path: string; readonly content: string };

/** The format a path declares, by extension (matches the liveness fixtures). */
export function formatFor(path: string): Format {
  if (path.endsWith('.tsx') || path.endsWith('.jsx')) return 'tsx';
  if (path.endsWith('.js')) return 'javascript';
  if (path.endsWith('.go')) return 'go';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.scss')) return 'scss';
  return 'typescript';
}

/**
 * Parse one file into a `ParsedFile`. Uses `adapter.parse()` (not the sync
 * bridge) so the adapter's source map is populated — `extractFunctions` /
 * `extractClasses` read the real source through it. Returns `null` when no
 * adapter resolves the path or the parse fails; the caller records the drop
 * (§3.3 makes a per-file failure `incomplete`, which is §8's concern).
 */
export async function parseOne(input: InputFile): Promise<ParsedFile | null> {
  const adapter = LanguageRegistry.getInstance().getAdapterForFile(input.path);
  if (!adapter) return null;
  try {
    const ast = await adapter.parse(input.path, input.content);
    return { file: input.path, format: formatFor(input.path), source: input.content, ast, adapter };
  } catch {
    return null;
  }
}

/**
 * Parse → Process for the `file-symbols` fact. Returns the assembled corpus
 * fact (every symbol from every file, files' ASTs already freed).
 */
export async function buildFileSymbols(files: readonly InputFile[]): Promise<FileSymbols[]> {
  const producer = PRODUCERS['file-symbols'];
  const symbols: FileSymbols[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      symbols.push(...(producer.process(parsed) as FileSymbols[]));
    } finally {
      parsed.ast.dispose?.();
    }
  }
  return symbols;
}

/** Analyze the assembled `file-symbols` fact with the SOLID rules. */
export function analyzeFileSymbols(symbols: FileSymbols[], thresholds: ThresholdValues = {}): Finding[] {
  const ctx = {
    facts: { 'file-symbols': symbols },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of solidRules) {
    findings.push(...rule.analyze(ctx));
  }
  return findings;
}

/** The whole vertical slice: parse → file-symbols → SOLID rules → findings. */
export async function runFileSymbolsSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const symbols = await buildFileSymbols(files);
  return analyzeFileSymbols(symbols, thresholds);
}

// ── data-access-calls slice (the "repeat" for a second fact kind) ──────────

/**
 * Parse → Process for the `data-access-calls` fact. Returns the assembled
 * corpus fact (every resolved DB call from every file, ASTs already freed).
 */
export async function buildDataAccessCalls(files: readonly InputFile[]): Promise<ResolvedQuery[]> {
  const producer = PRODUCERS['data-access-calls'];
  const calls: ResolvedQuery[] = [];
  for (const input of files) {
    const parsed = await parseOne(input);
    if (!parsed) continue;
    try {
      calls.push(...(producer.process(parsed) as ResolvedQuery[]));
    } finally {
      parsed.ast.dispose?.();
    }
  }
  return calls;
}

/** Analyze the assembled `data-access-calls` fact with the data-access rules. */
export function analyzeDataAccessCalls(calls: ResolvedQuery[], thresholds: ThresholdValues = {}): Finding[] {
  const ctx = {
    facts: { 'data-access-calls': calls },
    formats: ['typescript', 'tsx', 'javascript'] as const,
    thresholds,
  };
  const findings: Finding[] = [];
  for (const rule of dataAccessRules) {
    findings.push(...rule.analyze(ctx));
  }
  return findings;
}

/** The data-access slice: parse → data-access-calls → data-access rules → findings. */
export async function runDataAccessSlice(files: readonly InputFile[], thresholds?: ThresholdValues): Promise<Finding[]> {
  const calls = await buildDataAccessCalls(files);
  return analyzeDataAccessCalls(calls, thresholds);
}
