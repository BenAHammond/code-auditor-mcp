/**
 * Spec 69 R1 — the completeness oracles a file processor declares.
 *
 * Each oracle is one of two arms: a `counted` count of the fragments a file
 * *should* yield (a cheap, independent upper bound computed from the same input,
 * written for that processor), or an explicit `none` with the reason no statable
 * oracle exists. `none` is not an exemption — it is the report that closes the
 * silent-unprovable failure mode: the run enumerates it, named, with its reason.
 *
 * The counts here are deliberately dumber than the producer they shadow. A
 * producer runs the full extraction (metrics, classification, dedup); the oracle
 * counts raw tree nodes off the same tree. The gap — a producer emitting fewer
 * than the oracle expects — is the *residual* the aggregate gate pins (§69 R1,
 * criterion 4). An oracle is an upper bound, not a promise of equality: e.g.
 * `countFileSymbols` counts `method_definition` nodes, which the file-symbols
 * producer folds into their class symbol rather than emitting, so a class with
 * methods has a positive residual by design. The baseline records what each
 * number is composed of, so a residual of mostly-non-candidates is not later
 * read as missing input.
 */

import type { AstFile, CompletenessOracle, OracleShortfall, ParsedFile } from './types.js';
import { isFunctionNodeType } from '../analyzers/universal/functionConcerns.js';

/** A counted oracle: `count` returns the fragments one file should yield. */
export function countOracle(count: (file: ParsedFile) => number): CompletenessOracle {
  return { status: 'counted', count };
}

/** A no-oracle: there is no statable count, and here is why. */
export function noOracle(reason: string): CompletenessOracle {
  return { status: 'none', reason };
}

/**
 * Compare a `counted` oracle against what its processor actually emitted for one
 * file. Returns the shortfall record when the emitted count fell below the
 * expected count, else `null`. A `none` oracle never produces a shortfall — its
 * absence is enumerated by `noOracleProcessors`, not measured here.
 */
export function oracleShortfall(
  oracle: CompletenessOracle,
  file: ParsedFile,
  actual: number,
  processorId: string,
): OracleShortfall | null {
  if (oracle.status !== 'counted') return null;
  const expected = oracle.count(file);
  return actual < expected ? { file: file.file, processor: processorId, expected, actual } : null;
}

/** file-symbols — count function-like, class, and interface declaration nodes
 *  off the tree. An upper bound: a method is a function-like node that rides on
 *  its class symbol, so a class with methods emits fewer symbols than the node
 *  count. */
export function countFileSymbols(file: ParsedFile): number {
  const ast = (file as AstFile).ast;
  return (file as AstFile).adapter.findNodes(ast, {
    custom: (n) =>
      isFunctionNodeType(n.type) || n.type === 'class_declaration' || n.type === 'interface_declaration',
  }).length;
}

/** imports (TS/JS) — count `import_statement` nodes off the tree. */
export function countImports(file: ParsedFile): number {
  const ast = (file as AstFile).ast;
  return (file as AstFile).adapter.findNodes(ast, {
    custom: (n) => n.type === 'import_statement',
  }).length;
}

/** export-form (TS/JS) — count `export_statement` nodes off the tree. */
export function countExportForm(file: ParsedFile): number {
  const ast = (file as AstFile).ast;
  return (file as AstFile).adapter.findNodes(ast, {
    custom: (n) => n.type === 'export_statement',
  }).length;
}
