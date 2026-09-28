/**
 * Spec 68 §3.2 — the three single-file security rules (Spec 61 R6), migrated to
 * `analyze(ctx)`. They read the `security-candidates` fact, whose producer
 * (`securityCandidates.ts`) already resolved the structural half the legacy
 * `UniversalSecurityAnalyzer` walked the AST to obtain:
 *
 *   - `command-injection-risk`       — a shell/process invocation whose command
 *     is interpolated/concatenated (the producer resolved `unsafe`).
 *   - `dynamic-require-of-project-path` — a computed require/import specifier
 *     (the producer filtered out literals and carried the raw arg + callee text).
 *   - `unescaped-html-interpolation` — a sink-reaching template substitution that
 *     resolves to a member access (the producer ran the three-phase sink flow).
 *
 * The rule's job is the pure-text classification the producer could not do
 * without deciding — `isConfigPath` (dynamic-require), the `isTestOrFixtureFile`
 * skip (all three, matching the legacy per-file early return) — and the
 * finding/message/resolution construction. The producers never decided "is this
 * a finding"; they projected the positional context and the resolved
 * name/prop, exactly as `secretCandidates.ts` does for `secret-candidates`.
 *
 * The helper functions (`isTestOrFixtureFile`, `isConfigPath`) are re-homed
 * verbatim — copied, not imported, because `UniversalSecurityAnalyzer` is
 * deleted in §15 and the rule must not couple the new pipeline to a class about
 * to disappear. The finding messages are the full legacy literals (not the
 * registry's shortened `{method}`/`{path}`/`{field}` templates), matching how
 * `hardcoded-connection` and `hardcoded-secret` carry their pre-migration text.
 */

import type { RuleDefinition, Finding, SecurityCandidate } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

const META_INJ = RULE_REGISTRY['command-injection-risk'];
const META_REQ = RULE_REGISTRY['dynamic-require-of-project-path'];
const META_HTML = RULE_REGISTRY['unescaped-html-interpolation'];

/** The declaration for the three rules: they read `security-candidates`. */
type SecurityDefectNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['security-candidates'];
};

// ── Classification (re-homed verbatim from UniversalSecurityAnalyzer) ───────

/** Is this path a test/fixture file? Excluded up front (precision-first). */
function isTestOrFixtureFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes('.test.') || lower.includes('.spec.') ||
    lower.includes('__tests__') ||
    lower.includes('/test/') || lower.includes('/tests/') ||
    lower.includes('/fixtures/') || lower.includes('.fixture.') ||
    lower.endsWith('_test.go')
  );
}

/** Is this specifier a project-config-path-derived one (the config candidate /
 *  project-root join / directory-walk result this rule exists to catch)? */
function isConfigPath(text: string): boolean {
  const lower = text.toLowerCase();
  return /config/.test(lower) && /path|file|dir|join\(|resolve\(|pathtofileurl|href/.test(lower);
}

// ── Detection ───────────────────────────────────────────────────────────────

/** The member of the `SecurityCandidate` union whose `kind` is `K`. */
type CandidateOf<K extends SecurityCandidate['kind']> = Extract<SecurityCandidate, { kind: K }>;

/** The per-rule specifics the shared emitter fills into the common scaffold. */
interface SecurityDefectSpec<K extends SecurityCandidate['kind']> {
  kind: K;
  /** Extra candidate filter past the kind + test/fixture skips. */
  accept?: (c: CandidateOf<K>) => boolean;
  ruleId: string;
  severity: Finding['severity'];
  symbol: (c: CandidateOf<K>) => string;
  message: (c: CandidateOf<K>) => string;
  resolutionAction: string;
  resolutionSummary: (c: CandidateOf<K>) => string;
  resolutionSymbols: (c: CandidateOf<K>) => string[];
}

/** Emit one finding per candidate matching `spec`. The three single-file rules
 *  repeat the same loop + test/fixture skip + finding/resolution scaffold; only
 *  the classification (kind/accept) and the text (message/summary/symbol) vary. */
function detectSecurityDefect<K extends SecurityCandidate['kind']>(
  candidates: readonly SecurityCandidate[],
  spec: SecurityDefectSpec<K>,
): Finding[] {
  const findings: Finding[] = [];
  for (const c of candidates) {
    if (c.kind !== spec.kind) continue;
    if (isTestOrFixtureFile(c.file)) continue;
    const candidate = c as CandidateOf<K>;
    if (spec.accept && !spec.accept(candidate)) continue;
    findings.push({
      ruleId: spec.ruleId,
      severity: spec.severity,
      message: spec.message(candidate),
      file: candidate.file,
      line: candidate.line,
      column: candidate.column,
      symbol: spec.symbol(candidate),
      resolution: {
        action: spec.resolutionAction,
        summary: spec.resolutionSummary(candidate),
        symbols: spec.resolutionSymbols(candidate),
        files: [candidate.file],
        lines: [candidate.line],
      },
    });
  }
  return findings;
}

/** Re-homes `checkCommandInjection`: emit a finding per unsafe shell call. */
const COMMAND_INJECTION: SecurityDefectSpec<'command-injection'> = {
  kind: 'command-injection',
  ruleId: 'command-injection-risk',
  severity: 'critical',
  symbol: (c) => c.fnName,
  message: (c) =>
    `Unsafe process invocation: ${c.fnName}() is passed a command built by interpolation/concatenation, so a value can become a shell command. ` +
    'Pass the command as a string literal and arguments as an argv array (execFileSync/spawn), never a shell string.',
  resolutionAction: 'use-argv-array',
  resolutionSummary: (c) =>
    `Replace ${c.fnName} with an argv-array form (execFileSync/spawn) whose command is a string literal ` +
    'and whose arguments are separate array elements, so no shell interprets them.',
  resolutionSymbols: (c) => [c.fnName],
};

/** Re-homes `checkDynamicRequire`: emit a finding per computed config-path require. */
const DYNAMIC_REQUIRE: SecurityDefectSpec<'dynamic-require'> = {
  kind: 'dynamic-require',
  accept: (c) => isConfigPath(c.argText),
  ruleId: 'dynamic-require-of-project-path',
  severity: 'critical',
  // §7 — the computed specifier is what located this finding; two dynamic
  // requires in one file must not collapse to one fingerprint.
  symbol: (c) => c.argText,
  message: (c) =>
    `Dynamic require/import of a project config path: ${c.argText}. A path discovered from the project tree is executed ` +
    "when it is require()'d or import()'d. Read config files without executing them (static extraction).",
  resolutionAction: 'static-config-extraction',
  resolutionSummary: () =>
    'Replace the dynamic require/import with static extraction (read the source and extract the literal export) ' +
    'so a project-supplied config is never executed.',
  resolutionSymbols: (c) => [c.calleeText],
};

/** Re-homes `checkUnescapedHtml` + `checkInterpolation`: emit a finding per
 *  sink-reaching unescaped member-access interpolation. */
const UNESCAPED_HTML: SecurityDefectSpec<'unescaped-html'> = {
  kind: 'unescaped-html',
  ruleId: 'unescaped-html-interpolation',
  severity: 'severe',
  symbol: (c) => c.prop,
  message: (c) =>
    `Unescaped HTML interpolation: ${c.prop} is inserted into an HTML template without an escaping call. ` +
    'Analysis-controlled strings (file paths, messages, previews) can carry markup — wrap the interpolation in escapeHtml() to prevent stored XSS.',
  resolutionAction: 'escape-html-interpolation',
  resolutionSummary: (c) =>
    `Wrap the ${c.prop} interpolation in an escaping call (e.g. \${escapeHtml(${c.prop})}) before it reaches the HTML template.`,
  resolutionSymbols: (c) => [c.prop],
};

const commandInjectionRisk: RuleDefinition<SecurityDefectNeeds> = {
  id: 'command-injection-risk',
  analyzer: 'security',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['security-candidates'] },
  severity: 'critical',
  message: META_INJ.message,
  docs: META_INJ.docs,
  thresholds: META_INJ.thresholds,
  samples: META_INJ.samples,
  analyze(ctx): Finding[] {
    return detectSecurityDefect(ctx.facts['security-candidates'], COMMAND_INJECTION);
  },
};

const dynamicRequireOfProjectPath: RuleDefinition<SecurityDefectNeeds> = {
  id: 'dynamic-require-of-project-path',
  analyzer: 'security',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['security-candidates'] },
  severity: 'critical',
  message: META_REQ.message,
  docs: META_REQ.docs,
  thresholds: META_REQ.thresholds,
  samples: META_REQ.samples,
  analyze(ctx): Finding[] {
    return detectSecurityDefect(ctx.facts['security-candidates'], DYNAMIC_REQUIRE);
  },
};

const unescapedHtmlInterpolation: RuleDefinition<SecurityDefectNeeds> = {
  id: 'unescaped-html-interpolation',
  analyzer: 'security',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['security-candidates'] },
  severity: 'severe',
  message: META_HTML.message,
  docs: META_HTML.docs,
  thresholds: META_HTML.thresholds,
  samples: META_HTML.samples,
  analyze(ctx): Finding[] {
    return detectSecurityDefect(ctx.facts['security-candidates'], UNESCAPED_HTML);
  },
};

/** The three single-file security rules this slice migrates, in registry order. */
export const securityDefectRules: readonly RuleDefinition<SecurityDefectNeeds>[] = [
  commandInjectionRisk,
  dynamicRequireOfProjectPath,
  unescapedHtmlInterpolation,
];
