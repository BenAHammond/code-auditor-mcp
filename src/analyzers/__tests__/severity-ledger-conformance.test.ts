/**
 * Severity-ledger conformance guard (Spec 54, item 2).
 *
 * The severity-assignment ledger (`specs/severity-assignment-ledger.md`) is the
 * authoritative record of every rule's *target* severity; the emit sites across
 * the analyzers are the authoritative record of what the tool *actually*
 * reports. This test asserts the two agree, in both directions:
 *
 *   1. every ledger row's rule has an emit site, and its most-severe emitted
 *      level equals the ledger's level; and
 *   2. every live emit site has a ledger row at the same most-severe level.
 *
 * "Most-severe" rather than "exactly one" because a handful of rules carry a
 * deliberate sub-path split (e.g. `sql-injection-risk`: raw interpolation →
 * `critical`, manually quote-escaped → `high`). The ledger records the rule's
 * urgency — the worst case it can emit — and the split is documented in the
 * ledger prose. Comparing `max(emitted) === ledger` still catches the drift
 * class this guard exists for (a rule emitting `severe` where the ledger says
 * `high`): the emitted max no longer equals the recorded level.
 *
 * Two exception classes are structural facts about the tool, not drift:
 *
 *   - `cannot-fire` rules (`CANNOT_FIRE_RULES` in applicability.ts) have an emit
 *     site but their extractor never populates the field they read, so they carry
 *     no ledger severity ("there is nothing to gate until an emission site
 *     exists").
 *   - diagnostic-channel rules emit as `CoverageDiagnostic.kind` (off the
 *     severity ladder, never counted in finding totals), not as severity-bearing
 *     violations. The complete set of diagnostic kinds is pinned below so a
 *     future emit that sneaks onto the ladder (or off it) fails the test.
 *
 * One notational alias is encoded rather than "fixed" in the ledger, to honor
 * the ledger's append-only rule: Session 15 recorded the five Go-subprocess
 * rules under `analyzer/rule` notation (`imports/…`, `errors/…`, `goroutines/…`,
 * `channels/…`) while the emitted (and registered) IDs are bare
 * (`import-organization`, `error-handling`, `concurrency`, `channel-deadlock`,
 * `import-style`). The `GO_LEDGER_ALIAS` map records that translation.
 *
 * The extractors are deliberately simple: they match the string-literal emit
 * shapes in the source, not the running analyzer — the same shape as the
 * SKILL.md drift guard (Spec 46).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CANNOT_FIRE_RULES } from '../applicability.js';
import { SEVERITIES, SEVERITY_RANK, type Severity } from '../../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..', '..', '..');
const LEDGER_PATH = join(APP_ROOT, 'specs', 'severity-assignment-ledger.md');


/** Emit-site files that carry severity-bearing `rule`/`violationType`/`issueType`
 *  literals or positional emit helpers. Non-analyzer files (cli.ts, types.ts,
 *  config loaders) are excluded — they only *mention* severities, never emit. */
const EMIT_FILES = [
  'src/analyzers/universal/UniversalSOLIDAnalyzer.ts',
  'src/analyzers/universal/UniversalSecretsAnalyzer.ts',
  'src/analyzers/universal/UniversalSecurityAnalyzer.ts',
  'src/analyzers/universal/UniversalDataAccessAnalyzer.ts',
  'src/analyzers/universal/UniversalDRYAnalyzer.ts',
  'src/analyzers/universal/UniversalDocumentationAnalyzer.ts',
  'src/analyzers/documentationAnalyzer.ts', // legacy MCP path — same rules
  'src/analyzers/reactAnalyzer.ts',
  'src/analyzers/universal/UniversalSchemaAnalyzer.ts',
  'src/analyzers/universal/schema/jsonSchema.ts',
  'src/analyzers/universal/schema/codeAnalysis.ts',
  'src/analyzers/cross-language/SchemaValidator.ts',
  'src/analyzers/cross-language/APIContractAnalyzer.ts',
  'src/analyzers/cross-language/DependencyGraphBuilder.ts',
  'src/analyzers/crossDomain/CrossDomainAnalyzer.ts',
  'src/analyzers/universal/UniversalStylesAnalyzer.ts',
  'src/analyzers/universal/UniversalConventionsAnalyzer.ts',
  'src/analyzers/invariantsAnalyzer.ts',
  'src/pipelineAdapters.ts',
  'src/auditRunner.ts',
  'src/languages/go/analyzer-src/solid.go',
  'src/languages/go/analyzer-src/analyzer.go',
  'src/languages/go/analyzer-src/dataaccess.go',
];

/** Session 15 recorded the Go-subprocess rules under `analyzer/rule` notation;
 *  the emitted (and registered) IDs are bare. */
const GO_LEDGER_ALIAS: Record<string, string> = {
  'imports/import-organization': 'import-organization',
  'imports/import-style': 'import-style',
  'errors/error-handling': 'error-handling',
  'goroutines/concurrency': 'concurrency',
  'channels/channel-deadlock': 'channel-deadlock',
};

/** Inverse of `GO_LEDGER_ALIAS` — bare emitted ID → Session 15 `analyzer/rule`
 *  notation, for the emit→ledger lookup direction. */
const GO_ALIAS_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(GO_LEDGER_ALIAS).map(([k, v]) => [v, k]),
);

/** Off-ladder finding channel — `CoverageDiagnostic.kind` (src/types.ts). The
 *  complete union, not just the rules that moved off the ladder: `unresolved-query`
 *  and `unresolved-dynamic-import` are coverage gaps that were never severity rules. */
const COVERAGE_DIAGNOSTIC_KINDS = new Set([
  'unresolved-query',
  'unresolved-dynamic-import',
  'config-error',
  'engine-error',
  'undefined-class-not-found',
  'undefined-class-disabled',
  'config-key-rejected',
]);

/** Ledger rule IDs that resolved to a diagnostic (off the ladder, no severity).
 *  Excluded from the severity comparison; their presence on the diagnostic
 *  channel is asserted via `DIAGNOSTIC_KINDS` instead. */
const DIAGNOSTIC_LEDGER_RULES = new Set([
  'config-error',
  'engine-error',
  'styles/undefined-class-disabled',
]);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Parse the ledger's severity table into `Map<ruleId, severity>`. Table rows
 *  are `| Rule | Current | New level | Reason | Disagrees |`; the rule is the
 *  first backtick-quoted token in column 1 and the target level is column 3.
 *  `cannot-fire` rows live in prose lines, not table rows, so they are skipped.
 *  A re-tiered rule may appear in more than one session's table (the append-only
 *  audit trail); the last row wins. */
function parseLedger(): Map<string, Severity> {
  const src = read(LEDGER_PATH);
  const out = new Map<string, Severity>();
  for (const line of src.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const ruleMatch = (cells[1] ?? '').match(/`([^`]+)`/);
    if (!ruleMatch) continue; // header/separator row
    const level = (cells[3] ?? '') as Severity;
    if (!SEVERITIES.includes(level)) continue; // a prose-ish row, not an assignment
    out.set(ruleMatch[1], level);
  }
  return out;
}

/** Extract `{rule, severity}` pairs from object-literal emit sites — a
 *  `rule:`/`violationType:`/`issueType:` string literal paired with the nearest
 *  `severity:` literal within a window. Covers the dominant TS emit shape. */
function extractFieldPairs(src: string): Array<{ rule: string; severity: Severity }> {
  const sevs: Array<{ pos: number; severity: Severity }> = [];
  const sevRe = /severity:\s*['"](critical|severe|high)['"]/g;
  for (let m; (m = sevRe.exec(src)); ) sevs.push({ pos: m.index, severity: m[1] as Severity });

  const rules: Array<{ pos: number; rule: string }> = [];
  const ruleRe = /(?:rule|violationType|issueType):\s*['"]([a-z][\w/-]*)['"]/g;
  for (let m; (m = ruleRe.exec(src)); ) rules.push({ pos: m.index, rule: m[1] });

  const out: Array<{ rule: string; severity: Severity }> = [];
  for (const r of rules) {
    let best: { severity: Severity; d: number } | null = null;
    for (const s of sevs) {
      const d = Math.abs(s.pos - r.pos);
      if (d <= 1200 && (best === null || d < best.d)) best = { severity: s.severity, d };
    }
    if (best) out.push({ rule: r.rule, severity: best.severity });
  }
  return out;
}

/** Positional `emit(ctx, 'SEV', 'RULE', …)` calls (jsonSchema.ts). */
function extractPositionalEmit(src: string): Array<{ rule: string; severity: Severity }> {
  const out: Array<{ rule: string; severity: Severity }> = [];
  const re = /emit\(ctx,\s*['"](critical|severe|high)['"],\s*['"]([a-z][\w/-]*)['"]/g;
  for (let m; (m = re.exec(src)); ) out.push({ rule: m[2], severity: m[1] as Severity });
  return out;
}

/** Positional `emitViolation(file, 'SEV', msg, 'RULE')` calls (jsonSchema.ts). */
function extractEmitViolation(src: string): Array<{ rule: string; severity: Severity }> {
  const out: Array<{ rule: string; severity: Severity }> = [];
  const re = /emitViolation\([^)]*?['"](critical|severe|high)['"][^)]*?['"]([a-z][\w/-]*)['"]\s*\)/g;
  for (let m; (m = re.exec(src)); ) out.push({ rule: m[2], severity: m[1] as Severity });
  return out;
}

/** HEALTH_SEVERITY map — the four dependency-graph action rules whose severity
 *  lives only in the pipeline reducer, not the builder. */
function extractHealthSeverity(src: string): Array<{ rule: string; severity: Severity }> {
  const out: Array<{ rule: string; severity: Severity }> = [];
  const re = /['"](break-cycles|reduce-coupling|split-responsibilities|review-orphans)['"]:\s*['"](severe|high)['"]/g;
  for (let m; (m = re.exec(src)); ) out.push({ rule: m[1], severity: m[2] as Severity });
  return out;
}

/** Go `Severity:`/`Rule:` struct-literal pairs (severity precedes rule). */
function extractGoPairs(src: string): Array<{ rule: string; severity: Severity }> {
  const out: Array<{ rule: string; severity: Severity }> = [];
  const re = /Severity:\s*"(critical|severe|high)"[\s\S]{0,800}?Rule:\s*"([a-z][\w/-]*)"/g;
  for (let m; (m = re.exec(src)); ) out.push({ rule: m[2], severity: m[1] as Severity });
  return out;
}

/** `kind:` literal emits scoped to a `CoverageDiagnostic` object — a `kind:`
 *  preceded by a quoted `analyzerName`. The bare `kind:` regex is deliberately
 *  *not* used: unrelated `kind:` fields (Drizzle `callee` config descriptors, DRY
 *  `object`/`chain` fragments, and the `DiagnosticWarning` `no-result`/`zero-files`
 *  channel, which uses shorthand `analyzerName,`) also match a bare `kind:`. */
function extractDiagnosticKinds(src: string): Set<string> {
  const out = new Set<string>();
  const re = /analyzerName:\s*['"][a-z][\w/-]*['"][\s\S]{0,200}?kind:\s*['"]([a-z][\w/-]*)['"]/g;
  for (let m; (m = re.exec(src)); ) out.add(m[1]);
  return out;
}

/** Aggregate every emit site into `Map<ruleId, Set<severity>>` + diagnostic kinds. */
function scanEmitSites(): { emits: Map<string, Set<Severity>>; diagnosticKinds: Set<string> } {
  const emits = new Map<string, Set<Severity>>();
  const diagnosticKinds = new Set<string>();

  const add = (pairs: Array<{ rule: string; severity: Severity }>) => {
    for (const { rule, severity } of pairs) {
      if (!emits.has(rule)) emits.set(rule, new Set());
      emits.get(rule)!.add(severity);
    }
  };

  for (const rel of EMIT_FILES) {
    const abs = join(APP_ROOT, rel);
    if (!existsSync(abs)) {
      throw new Error(`conformance test emit file missing: ${rel}`);
    }
    const src = read(abs);
    add(extractFieldPairs(src));
    add(extractPositionalEmit(src));
    add(extractEmitViolation(src));
    add(extractHealthSeverity(src));
    add(extractGoPairs(src));
    for (const kind of extractDiagnosticKinds(src)) diagnosticKinds.add(kind);
  }

  return { emits, diagnosticKinds };
}

/** The most-severe severity in a set (urgency = worst case). */
function maxSeverity(sevs: Set<Severity>): Severity {
  return [...sevs].reduce((a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a));
}

describe('severity-ledger conformance', () => {
  const ledger = parseLedger();
  const { emits, diagnosticKinds } = scanEmitSites();

  /** Normalize a ledger rule ID to the emitted/registered ID. */
  const normalize = (id: string): string => GO_LEDGER_ALIAS[id] ?? id;

  it('parses a non-trivial ledger (≥ 90 assigned rules)', () => {
    expect(ledger.size).toBeGreaterThanOrEqual(90);
  });

  it('emits exactly the known diagnostic kinds (no finding sneaks off the ladder)', () => {
    const extracted = [...diagnosticKinds].sort();
    const coverage = extracted.filter((k) => COVERAGE_DIAGNOSTIC_KINDS.has(k));
    const stray = extracted.filter((k) => !COVERAGE_DIAGNOSTIC_KINDS.has(k));
    expect(coverage, 'off-ladder finding kinds drifted').toEqual(
      [...COVERAGE_DIAGNOSTIC_KINDS].sort(),
    );
    expect(stray, 'analyzerName-scoped kind outside the CoverageDiagnostic union').toEqual([]);
  });

  it('emits every ledger rule at the ledger level (ledger → emit)', () => {
    const mismatches: string[] = [];
    for (const [rawId, level] of ledger) {
      if (DIAGNOSTIC_LEDGER_RULES.has(rawId)) continue;
      const id = normalize(rawId);
      const emitted = emits.get(id);
      if (!emitted || emitted.size === 0) {
        mismatches.push(`${rawId} → ${id}: ledger ${level}, no emit site`);
      } else if (maxSeverity(emitted) !== level) {
        mismatches.push(`${rawId} → ${id}: ledger ${level}, emits ${[...emitted].join('|')} (max ${maxSeverity(emitted)})`);
      }
    }
    expect(mismatches, `ledger↔emit severity drift:\n  ${mismatches.join('\n  ')}`).toEqual([]);
  });

  it('assigns every live emit site a ledger row (emit → ledger)', () => {
    const missing: string[] = [];
    for (const [id, sevs] of emits) {
      if (CANNOT_FIRE_RULES.has(id)) continue;
      if (DIAGNOSTIC_LEDGER_RULES.has(id)) continue;
      const ledgerLevel = ledger.get(GO_ALIAS_REVERSE[id] ?? id);
      if (ledgerLevel === undefined) {
        missing.push(`${id}: emits ${[...sevs].join('|')}, no ledger row`);
      } else if (maxSeverity(sevs) !== ledgerLevel) {
        missing.push(`${id}: emits ${[...sevs].join('|')} (max ${maxSeverity(sevs)}), ledger ${ledgerLevel}`);
      }
    }
    expect(missing, `emit→ledger drift:\n  ${missing.join('\n  ')}`).toEqual([]);
  });
});
