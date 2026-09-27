/**
 * Spec 68 §3.2 — the DRY rules, migrated to `analyze(ctx)`.
 *
 * `duplicate-import` re-homes `UniversalDRYAnalyzer.checkDuplicateImports`:
 * group the `imports` fact by `(file, source)` and flag any source imported more
 * than once within a single file, anchored at the first import's location. The
 * legacy detector ran per AST, so the `(file, …)` grouping is load-bearing — two
 * files importing the same module once are not duplicates. The message and the
 * first-import anchoring are verbatim from `checkDuplicateImports`; `symbol`
 * carries the module source exactly as the legacy `createViolation` set
 * `functionName` to it.
 *
 * `duplicate-string-literal` re-homes `checkDuplicateStrings`: group the
 * `string-literals` fact by `(file, value)` and flag any raw string text that
 * appears more than twice within a single file, anchored at the first
 * occurrence. The same per-file grouping holds here (the legacy detector ran
 * per AST), and `value` is the raw `getNodeText` (quotes included) so a
 * `'…'` and `"…"` literal are distinct values — the same key the legacy code
 * compared.
 *
 * The three block rules (`dry/duplicate`, `dry/structural-similarity`,
 * `dry/similar-expression`) read the `code-block` fact — blocks and shape
 * fragments the `codeBlocks.ts` producer extracted from the AST. They re-home
 * `reportExactDuplicates` / `reportStructuralDuplicates` /
 * `reportExpressionSimilarities` over the projected data. The legacy
 * `analyzeAST` ran **once per file**, so each rule partitions the corpus fact by
 * `file` and runs its filter → dedupe → compare within one file (a block in file
 * A is never compared against a block in file B).
 *
 * `dry/diverging-clone` is the cross-run pair-tracking pass (Spec 13 R5): it
 * reads the `clone-pair-history` fact — the `dry_pair_history` similarity series
 * the DRY bundle seeds each run — and flags a pair whose similarity has fallen by
 * `divergenceThreshold` for `divergenceRuns` consecutive runs. It re-homes the
 * legacy auditRunner Phase 2 divergence pass verbatim, over the grouped fact.
 */

import type {
  RuleDefinition,
  Finding,
  ImportFact,
  StringLiteralFact,
  CodeBlockFact,
  CodeBlockBlock,
  CodeBlockFragment,
  ClonePairHistoryFact,
  ThresholdValues,
} from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

const META = RULE_REGISTRY['duplicate-import'];
const STRING_META = RULE_REGISTRY['duplicate-string-literal'];
const DUP_META = RULE_REGISTRY['dry/duplicate'];
const STRUCT_META = RULE_REGISTRY['dry/structural-similarity'];
const EXPR_META = RULE_REGISTRY['dry/similar-expression'];
const DIVERGING_META = RULE_REGISTRY['dry/diverging-clone'];

/** The shared declaration for the one import-servable DRY rule. */
type DryNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['imports'];
};

/** The declaration for the string-literal-servable DRY rule. */
type StringLiteralNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['string-literals'];
};

/** The declaration for the three code-block-servable DRY rules. */
type CodeBlockNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['code-block'];
};

/** The declaration for the clone-pair-history-servable DRY rule. */
type ClonePairNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['clone-pair-history'];
};

/** Re-homes `checkDuplicateImports`, grouping per file. */
function detectDuplicateImport(facts: readonly ImportFact[]): Finding[] {
  const byFile = new Map<string, Map<string, { line: number; column: number }[]>>();
  for (const imp of facts) {
    // The `imports` fact is shared with the Go `import-organization`/`import-style`
    // rules (a mixed corpus concatenates both producers' output). This rule is
    // TS/JS-only: the Go producer always sets `alias` (null for an unnamed
    // import), the TS producer leaves it absent, so `alias !== undefined` marks
    // a Go import and it is skipped here.
    if (imp.alias !== undefined) continue;
    let fileMap = byFile.get(imp.file);
    if (!fileMap) {
      fileMap = new Map();
      byFile.set(imp.file, fileMap);
    }
    const locs = fileMap.get(imp.source) ?? [];
    locs.push({ line: imp.line, column: imp.column });
    fileMap.set(imp.source, locs);
  }

  const findings: Finding[] = [];
  for (const [file, fileMap] of byFile) {
    for (const [source, locs] of fileMap) {
      if (locs.length <= 1) continue;
      findings.push({
        ruleId: 'duplicate-import',
        severity: 'high',
        message: `Module "${source}" is imported ${locs.length} times`,
        file,
        line: locs[0].line,
        column: locs[0].column,
        symbol: source,
      });
    }
  }
  return findings;
}

/** Re-homes `checkDuplicateStrings`, grouping per `(file, value)`. */
function detectDuplicateStringLiteral(facts: readonly StringLiteralFact[]): Finding[] {
  const byFile = new Map<string, Map<string, { line: number; column: number }[]>>();
  for (const lit of facts) {
    if (lit.value.length <= 10) continue; // non-trivial strings only
    let fileMap = byFile.get(lit.file);
    if (!fileMap) {
      fileMap = new Map();
      byFile.set(lit.file, fileMap);
    }
    const locs = fileMap.get(lit.value) ?? [];
    locs.push({ line: lit.line, column: lit.column });
    fileMap.set(lit.value, locs);
  }

  const findings: Finding[] = [];
  for (const [file, fileMap] of byFile) {
    for (const [value, locs] of fileMap) {
      if (locs.length <= 2) continue; // more than 2 occurrences
      findings.push({
        ruleId: 'duplicate-string-literal',
        severity: 'high',
        message: `String literal "${value.substring(0, 30)}..." is duplicated ${locs.length} times`,
        file,
        line: locs[0].line,
        column: locs[0].column,
        symbol: value.substring(0, 50),
        fix: { oldText: value, newText: '// Consider extracting to a constant' },
      });
    }
  }
  return findings;
}

// ── code-block rules (the three per-file block/fragment comparisons) ─────────

/** Config surface the three block rules read (subset of `DRYAnalyzerConfig`). */
interface DryBlockConfig {
  minLineThreshold?: number;
  similarityThreshold?: number;
  excludePatterns?: string[];
  checkStructuralSimilarity?: boolean;
  checkExpressionSimilarity?: boolean;
  minShapeNames?: number;
}

/**
 * The defaults re-declared from `DEFAULT_DRY_CONFIG` (UniversalDRYAnalyzer.ts) —
 * the same merge the legacy `analyzeAST` did before extraction. `excludePatterns`
 * is verbatim (the test/spec/tests-dir globs); `checkStructuralSimilarity` is off
 * and `checkExpressionSimilarity` on, matching the registry's `configGate`s.
 */
const DRY_BLOCK_DEFAULTS: DryBlockConfig = {
  minLineThreshold: 15,
  similarityThreshold: 0.85,
  excludePatterns: [
    '**/*.test.ts', '**/*.spec.ts',
    '**/*.test.tsx', '**/*.spec.tsx',
    '**/*.test.js', '**/*.spec.js',
    '**/*.test.jsx', '**/*.spec.jsx',
    '**/test/**', '**/tests/**',
  ],
  checkStructuralSimilarity: false,
  checkExpressionSimilarity: true,
  minShapeNames: 4,
};

/** Merge the (default-merged) thresholds onto the block defaults. */
function resolveBlockConfig(t: ThresholdValues): DryBlockConfig {
  return { ...DRY_BLOCK_DEFAULTS, ...(t as Record<string, unknown>) } as DryBlockConfig;
}

/** True if the two blocks share code spans (same file + overlapping lines). */
function spansOverlap(a: CodeBlockBlock, b: CodeBlockBlock): boolean {
  if (a.file !== b.file) return false;
  return !(a.end.line < b.start.line || b.end.line < a.start.line);
}

/** Sort comparator: earliest file+line first. */
function byFileAndLine(a: CodeBlockBlock, b: CodeBlockBlock): number {
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  return a.start.line - b.start.line;
}

/**
 * Deduplicate overlapping blocks (re-homed verbatim): prefer the innermost block
 * when one fully contains another, the earliest when only partially overlapping.
 */
function deduplicateBlocks(blocks: CodeBlockBlock[]): CodeBlockBlock[] {
  if (blocks.length <= 1) return blocks;

  const sorted = [...blocks].sort(byFileAndLine);
  const result: CodeBlockBlock[] = [];
  let last: CodeBlockBlock | null = null;

  for (const block of sorted) {
    if (last && last.file === block.file) {
      if (last.start.line <= block.start.line && last.end.line >= block.end.line) {
        result.pop();
        result.push(block);
        last = block;
        continue;
      }
      if (block.start.line <= last.start.line && block.end.line >= last.end.line) {
        continue;
      }
      if (!(last.end.line < block.start.line)) {
        continue;
      }
    }
    result.push(block);
    last = block;
  }
  return result;
}

/** Jaccard similarity over two whitespace-tokenized strings, [0, 1]. */
function computeJaccardSimilarity(text1: string, text2: string): number {
  const tokens1 = new Set(text1.split(/\s+/).filter(Boolean));
  const tokens2 = new Set(text2.split(/\s+/).filter(Boolean));

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) intersection++;
  }

  const union = tokens1.size + tokens2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Translate a minimal glob (`*`, `**`, `?`) to an anchored regex (re-homed). */
function globToRegExp(pattern: string): RegExp {
  const out: string[] = ['^'];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out.push('(?:.*/)?');
        } else {
          out.push('.*');
        }
      } else {
        out.push('[^/]*');
      }
    } else if (ch === '?') {
      out.push('[^/]');
    } else if ('^$\\.+?()[]{}|'.includes(ch)) {
      out.push('\\', ch);
    } else {
      out.push(ch);
    }
  }
  out.push('$');
  return new RegExp(out.join(''));
}

/** True when a file path matches any of the given glob-ish exclude patterns. */
function isExcluded(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

/** True when `outer`'s span fully contains `inner`'s span in the same file. */
function shapeSpansContain(outer: CodeBlockFragment, inner: CodeBlockFragment): boolean {
  if (outer.file !== inner.file) return false;
  const startLte =
    outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line && outer.start.column <= inner.start.column);
  const endGte =
    outer.end.line > inner.end.line ||
    (outer.end.line === inner.end.line && outer.end.column >= inner.end.column);
  return startLte && endGte;
}

/** Drop nested fragments, keeping the outermost (re-homed `dedupeShapeFragments`). */
function dedupeShapeFragments(fragments: CodeBlockFragment[]): CodeBlockFragment[] {
  const sorted = [...fragments].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.start.line !== b.start.line) return a.start.line - b.start.line;
    if (a.start.column !== b.start.column) return a.start.column - b.start.column;
    if (a.end.line !== b.end.line) return b.end.line - a.end.line;
    return b.end.column - a.end.column;
  });

  const kept: CodeBlockFragment[] = [];
  for (const f of sorted) {
    if (!kept.some((k) => shapeSpansContain(k, f))) kept.push(f);
  }
  return kept;
}

/** Longest common subsequence of two string arrays, as the actual shared sequence. */
function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const seq: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      seq.push(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return seq.reverse();
}

/**
 * Method names from well-known fluent APIs (query/schema builders, validators,
 * commander, promises, DOM/stdlib chains) — "structurally similar by design",
 * so the default-on expression rule stays quiet on them (re-homed verbatim).
 */
const FLUENT_CHAIN_METHODS = new Set([
  // SQL query builders (knex, Kysely, Drizzle, …)
  'select', 'selectDistinct', 'from', 'where', 'andWhere', 'orWhere', 'whereRaw',
  'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereExists', 'whereBetween',
  'orderBy', 'groupBy', 'having', 'join', 'innerJoin', 'leftJoin', 'rightJoin',
  'crossJoin', 'fullOuterJoin', 'limit', 'offset', 'distinct', 'count', 'sum', 'avg',
  'first', 'pluck', 'forUpdate', 'forShare', 'skipLocked', 'union', 'unionAll',
  'insert', 'update', 'del', 'delete', 'into', 'returning', 'onConflict', 'ignore',
  'merge', 'increment', 'decrement', 'transacting', 'using', 'updateFrom', 'testSql',
  'toSQL', 'toQuery', 'raw', 'table', 'schemaBuilder', 'queryBuilder', 'partitionBy',
  // Schema builders (knex `table.integer().unsigned().references()`)
  'createTable', 'alterTable', 'dropTable', 'dropTableIfExists', 'renameTable',
  'renameColumn', 'dropColumn', 'integer', 'bigInteger', 'text', 'boolean', 'float',
  'double', 'decimal', 'date', 'dateTime', 'timestamp', 'timestamps', 'time',
  'binary', 'json', 'jsonb', 'uuid', 'unsigned', 'references', 'inTable', 'defaultTo',
  'index', 'unique', 'primary', 'comment', 'foreign', 'onDelete', 'onUpdate',
  'deferrable', 'withKeyName', 'notNullable', 'collate', 'check',
  // Zod / Valibot schema validators
  'trim', 'min', 'max', 'length', 'int', 'positive', 'nonnegative', 'negative',
  'regex', 'email', 'url', 'datetime', 'optional', 'nullish', 'nullable', 'default',
  'describe', 'refine', 'superRefine', 'transform', 'safeParse', 'parse', 'array',
  'object', 'enum', 'record', 'union', 'intersection', 'tuple', 'literal', 'number',
  'string', 'nativeEnum', 'lazy', 'preprocess', 'brand',
  // commander / CLI builders
  'command', 'description', 'option', 'requiredOption', 'action', 'argument',
  'version', 'usage', 'name', 'alias', 'allowUnknownOption', 'exitOverride',
  // Promises
  'then', 'catch', 'finally',
  // DOM / jQuery traversal and JS stdlib array/string method chains
  'closest', 'find', 'text', 'map', 'filter', 'reduce', 'forEach', 'slice', 'split',
  'join', 'replace', 'replaceAll', 'toLowerCase', 'toUpperCase', 'flatMap', 'concat',
]);

/** True when the chain is a fluent library/builder API (not duplicated logic). */
function isFluentChain(names: string[]): boolean {
  return names.some((n) => FLUENT_CHAIN_METHODS.has(n));
}

/** Partition the corpus `code-block` fact by file, dropping excluded files. */
function perFileGroups(
  facts: readonly CodeBlockFact[],
  patterns: string[],
): Map<string, { blocks: CodeBlockBlock[]; fragments: CodeBlockFragment[] }> {
  const byFile = new Map<string, { blocks: CodeBlockBlock[]; fragments: CodeBlockFragment[] }>();
  for (const fact of facts) {
    if (isExcluded(fact.file, patterns)) continue;
    const group = byFile.get(fact.file) ?? { blocks: [], fragments: [] };
    if (fact.kind === 'block') group.blocks.push(fact);
    else group.fragments.push(fact);
    byFile.set(fact.file, group);
  }
  return byFile;
}

/** Re-homes `reportExactDuplicates` (per file): group by hash, flag repeats. */
function detectExactDuplicates(blocks: CodeBlockBlock[], cfg: DryBlockConfig): Finding[] {
  const minLine = cfg.minLineThreshold || 5;
  const large = blocks.filter((b) => b.lineCount >= minLine);
  const deduped = deduplicateBlocks(large);

  const byHash = new Map<string, CodeBlockBlock[]>();
  for (const block of deduped) {
    const group = byHash.get(block.hash) ?? [];
    group.push(block);
    byHash.set(block.hash, group);
  }

  const findings: Finding[] = [];
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(byFileAndLine);
    const original = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const block = sorted[i];
      if (spansOverlap(original, block)) continue;
      findings.push({
        ruleId: 'dry/duplicate',
        severity: 'high',
        message: `Duplicate code block detected (${block.lineCount} lines). ` +
          `First occurrence at ${original.file}:${original.start.line}`,
        file: block.file,
        line: block.start.line,
        column: block.start.column,
        symbol: block.hash,
        resolution: {
          action: 'extract-duplicate',
          summary: `Extract the ${block.lineCount}-line block duplicated at ${original.file}:${original.start.line} into a shared function both sites call.`,
          files: [block.file, original.file],
          lines: [block.start.line, original.start.line],
        },
        fix: { oldText: block.text, newText: '// Consider extracting to a shared function' },
      });
    }
  }
  return findings;
}

/** Re-homes `reportStructuralDuplicates` (per file): Jaccard over token-kind skeletons. */
function detectStructuralDuplicates(blocks: CodeBlockBlock[], cfg: DryBlockConfig): Finding[] {
  const minLine = cfg.minLineThreshold || 5;
  const threshold = cfg.similarityThreshold ?? 0.85;
  const large = blocks.filter((b) => b.lineCount >= minLine);
  const deduped = deduplicateBlocks(large);

  const findings: Finding[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const original = deduped[i];
    for (let j = i + 1; j < deduped.length; j++) {
      const block = deduped[j];
      if (original.hash === block.hash) continue;
      if (spansOverlap(original, block)) continue;

      const similarity = computeJaccardSimilarity(
        original.structuralSkeleton, block.structuralSkeleton,
      );
      if (similarity < threshold) continue;

      findings.push({
        ruleId: 'dry/structural-similarity',
        severity: 'high',
        message: `Structurally similar code block detected (${Math.round(similarity * 100)}% similar). ` +
          `First occurrence at ${original.file}:${original.start.line}`,
        file: block.file,
        line: block.start.line,
        column: block.start.column,
        symbol: block.hash,
        fix: { oldText: block.text, newText: '// Consider extracting to a shared function' },
      });
    }
  }
  return findings;
}

/** Build the `dry/similar-expression` finding for `fragment` resembling `first`. */
function buildSimilarityViolation(
  fragment: CodeBlockFragment,
  first: CodeBlockFragment,
  shared: string[],
): Finding {
  const isObject = fragment.fragmentKind === 'object';
  const label = isObject ? 'object literal' : 'call chain';
  const unit = isObject ? 'fields' : 'methods';
  const targetClause = isObject && fragment.target
    ? ` built for "${fragment.target}"`
    : '';
  return {
    ruleId: 'dry/similar-expression',
    severity: 'high',
    message: `Near-identical ${label}${targetClause} detected (${shared.length} shared ${unit}: ${shared.join(', ')}). ` +
      `First occurrence at ${first.file}:${first.start.line}`,
    file: fragment.file,
    line: fragment.start.line,
    column: fragment.start.column,
    symbol: shared.join('.'),
    resolution: {
      action: 'extract-shared-expression',
      summary: `Extract the shared ${isObject ? 'field list' : 'method chain'} (${shared.join(', ')}) into a shared helper, builder, or constant both sites use.`,
      files: [fragment.file, first.file],
      lines: [fragment.start.line, first.start.line],
    },
    fix: { oldText: fragment.text, newText: `// Consider extracting the shared ${unit} into a shared helper` },
  };
}

/** Re-homes `reportExpressionSimilarities` (per file): LCS over fragment names. */
function detectExpressionSimilarities(fragments: CodeBlockFragment[], cfg: DryBlockConfig): Finding[] {
  const min = cfg.minShapeNames || 4;
  // The legacy walk filtered fragments during collection: object literals were
  // dropped only for having too few names, while call chains were also dropped
  // when they were fluent library/builder APIs. Re-apply that same split here —
  // a fluent-chain exclusion on an object literal would wrongly drop a
  // `{ select, from, where, orderBy }` literal that the legacy code compared.
  const eligible = fragments.filter((f) => {
    if (f.names.length < min) return false;
    if (f.fragmentKind === 'chain' && isFluentChain(f.names)) return false;
    return true;
  });
  const deduped = dedupeShapeFragments(eligible);

  const reported = new Set<number>();
  const findings: Finding[] = [];
  for (let j = 1; j < deduped.length; j++) {
    if (reported.has(j)) continue;
    for (let i = 0; i < j; i++) {
      if (deduped[i].fragmentKind !== deduped[j].fragmentKind) continue;
      if (deduped[i].target !== deduped[j].target) continue;
      const shared = longestCommonSubsequence(deduped[i].names, deduped[j].names);
      if (shared.length < min) continue;
      findings.push(buildSimilarityViolation(deduped[j], deduped[i], shared));
      reported.add(j);
      break;
    }
  }
  return findings;
}

// ── diverging-clone (cross-run pair tracking, Spec 13 R5) ─────────────────────

/** Config surface the diverging-clone rule reads (subset of `DivergenceConfig`).
 *  `minPairSimilarity` is declared but the loop never reads it — matching the
 *  legacy Phase 2, which only consumed `divergenceThreshold`/`divergenceRuns`. */
interface DivergenceCfg {
  divergenceThreshold?: number;
  divergenceRuns?: number;
  minPairSimilarity?: number;
}

/** The fallback the legacy auditRunner Phase 2 hardcoded when no divergence
 *  config was set (mirrors `DEFAULT_ANALYZER_CONFIGS.dry.divergence`). */
const DIVERGENCE_DEFAULTS: DivergenceCfg = {
  divergenceThreshold: 0.05,
  divergenceRuns: 2,
  minPairSimilarity: 0.5,
};

/** Re-homes auditRunner Phase 2 verbatim: flag a pair whose similarity fell by
 *  `divergenceThreshold` for `divergenceRuns` consecutive runs. The
 *  `clone-pair-history` fact is grouped by fingerprint with its series already
 *  in timestamp order, so the anchor (file/line) is the group's most recent row. */
function detectDivergingClone(facts: ClonePairHistoryFact, cfg: DivergenceCfg): Finding[] {
  const threshold = cfg.divergenceThreshold ?? 0.05;
  const requiredDeclines = cfg.divergenceRuns ?? 2;
  if (threshold <= 0) return [];

  const findings: Finding[] = [];
  for (const group of facts) {
    const rows = group.rows;
    if (rows.length < requiredDeclines + 1) continue;

    // Check the last `requiredDeclines` consecutive pairs for a decline.
    let consecutiveDeclines = 0;
    for (let i = rows.length - requiredDeclines; i < rows.length; i++) {
      if (rows[i].similarity < rows[i - 1].similarity - threshold) {
        consecutiveDeclines++;
      }
    }

    if (consecutiveDeclines >= requiredDeclines) {
      const currentSim = rows[rows.length - 1].similarity;
      const prevSim = rows[rows.length - 2].similarity;
      const drop = Math.round((prevSim - currentSim) * 1000) / 1000;
      const fp = group.fingerprint;
      findings.push({
        ruleId: 'dry/diverging-clone',
        severity: 'severe',
        message: `Clone pair has diverged: similarity dropped ${drop} (from ${prevSim.toFixed(3)} to ${currentSim.toFixed(3)}) across ${requiredDeclines} consecutive runs (pair: ${fp.slice(0, 12)}…). Review ${group.file1}:${group.line1} and ${group.file2}:${group.line2} for diverged logic.`,
        file: group.file1,
        line: group.line1,
      });
    }
  }
  return findings;
}

// ── The rules ─────────────────────────────────────────────────────────────────

const duplicateImport: RuleDefinition<DryNeeds> = {
  id: 'duplicate-import',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['imports'] },
  severity: 'high',
  message: META.message,
  docs: META.docs,
  thresholds: META.thresholds,
  samples: META.samples,
  analyze(ctx): Finding[] {
    return detectDuplicateImport(ctx.facts['imports']);
  },
};

const duplicateStringLiteral: RuleDefinition<StringLiteralNeeds> = {
  id: 'duplicate-string-literal',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['string-literals'] },
  severity: 'high',
  message: STRING_META.message,
  docs: STRING_META.docs,
  thresholds: STRING_META.thresholds,
  samples: STRING_META.samples,
  analyze(ctx): Finding[] {
    return detectDuplicateStringLiteral(ctx.facts['string-literals']);
  },
};

const dryDuplicate: RuleDefinition<CodeBlockNeeds> = {
  id: 'dry/duplicate',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['code-block'] },
  severity: 'high',
  message: DUP_META.message,
  docs: DUP_META.docs,
  thresholds: DUP_META.thresholds,
  samples: DUP_META.samples,
  analyze(ctx): Finding[] {
    const cfg = resolveBlockConfig(ctx.thresholds);
    const findings: Finding[] = [];
    for (const { blocks } of perFileGroups(ctx.facts['code-block'], cfg.excludePatterns ?? []).values()) {
      findings.push(...detectExactDuplicates(blocks, cfg));
    }
    return findings;
  },
};

const dryStructuralSimilarity: RuleDefinition<CodeBlockNeeds> = {
  id: 'dry/structural-similarity',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['code-block'] },
  severity: 'high',
  message: STRUCT_META.message,
  docs: STRUCT_META.docs,
  thresholds: STRUCT_META.thresholds,
  samples: STRUCT_META.samples,
  analyze(ctx): Finding[] {
    const cfg = resolveBlockConfig(ctx.thresholds);
    if (!cfg.checkStructuralSimilarity) return [];
    const findings: Finding[] = [];
    for (const { blocks } of perFileGroups(ctx.facts['code-block'], cfg.excludePatterns ?? []).values()) {
      findings.push(...detectStructuralDuplicates(blocks, cfg));
    }
    return findings;
  },
};

const drySimilarExpression: RuleDefinition<CodeBlockNeeds> = {
  id: 'dry/similar-expression',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['code-block'] },
  severity: 'high',
  message: EXPR_META.message,
  docs: EXPR_META.docs,
  thresholds: EXPR_META.thresholds,
  samples: EXPR_META.samples,
  analyze(ctx): Finding[] {
    const cfg = resolveBlockConfig(ctx.thresholds);
    if (!cfg.checkExpressionSimilarity) return [];
    const findings: Finding[] = [];
    for (const { fragments } of perFileGroups(ctx.facts['code-block'], cfg.excludePatterns ?? []).values()) {
      findings.push(...detectExpressionSimilarities(fragments, cfg));
    }
    return findings;
  },
};

const divergingClone: RuleDefinition<ClonePairNeeds> = {
  id: 'dry/diverging-clone',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['clone-pair-history'] },
  severity: 'severe',
  message: DIVERGING_META.message,
  docs: DIVERGING_META.docs,
  thresholds: DIVERGING_META.thresholds,
  samples: DIVERGING_META.samples,
  analyze(ctx): Finding[] {
    // The divergence knobs resolve the same way the legacy Phase 2 did: the
    // dry namespace's `divergence` object, or the hardcoded fallback. The
    // top-level `divergence` config is threaded into `dry.divergence` by the
    // caller (§11.1), so `ctx.thresholds['divergence']` is the effective value.
    const divergence = (ctx.thresholds['divergence'] as DivergenceCfg | undefined) ?? DIVERGENCE_DEFAULTS;
    return detectDivergingClone(ctx.facts['clone-pair-history'], divergence);
  },
};

/** The DRY rules, in registry order. */
export const dryRules: readonly RuleDefinition<DryNeeds | StringLiteralNeeds | CodeBlockNeeds | ClonePairNeeds>[] = [
  duplicateImport,
  duplicateStringLiteral,
  dryDuplicate,
  dryStructuralSimilarity,
  drySimilarExpression,
  divergingClone,
];
