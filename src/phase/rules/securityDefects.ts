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

/** Re-homes `checkCommandInjection`: emit a finding per unsafe shell call. */
function detectCommandInjection(candidates: readonly SecurityCandidate[]): Finding[] {
  const findings: Finding[] = [];
  for (const c of candidates) {
    if (c.kind !== 'command-injection') continue;
    if (isTestOrFixtureFile(c.file)) continue;
    const fnName = c.fnName;
    findings.push({
      ruleId: 'command-injection-risk',
      severity: 'critical',
      message:
        `Unsafe process invocation: ${fnName}() is passed a command built by interpolation/concatenation, so a value can become a shell command. ` +
        'Pass the command as a string literal and arguments as an argv array (execFileSync/spawn), never a shell string.',
      file: c.file,
      line: c.line,
      column: c.column,
      symbol: fnName,
      resolution: {
        action: 'use-argv-array',
        summary:
          `Replace ${fnName} with an argv-array form (execFileSync/spawn) whose command is a string literal ` +
          'and whose arguments are separate array elements, so no shell interprets them.',
        symbols: [fnName],
        files: [c.file],
        lines: [c.line],
      },
    });
  }
  return findings;
}

/** Re-homes `checkDynamicRequire`: emit a finding per computed config-path require. */
function detectDynamicRequire(candidates: readonly SecurityCandidate[]): Finding[] {
  const findings: Finding[] = [];
  for (const c of candidates) {
    if (c.kind !== 'dynamic-require') continue;
    if (isTestOrFixtureFile(c.file)) continue;
    if (!isConfigPath(c.argText)) continue;
    findings.push({
      ruleId: 'dynamic-require-of-project-path',
      severity: 'critical',
      message:
        `Dynamic require/import of a project config path: ${c.argText}. A path discovered from the project tree is executed ` +
        "when it is require()'d or import()'d. Read config files without executing them (static extraction).",
      file: c.file,
      line: c.line,
      column: c.column,
      // §7 — the computed specifier is what located this finding; two dynamic
      // requires in one file must not collapse to one fingerprint.
      symbol: c.argText,
      resolution: {
        action: 'static-config-extraction',
        summary:
          'Replace the dynamic require/import with static extraction (read the source and extract the literal export) ' +
          'so a project-supplied config is never executed.',
        symbols: [c.calleeText],
        files: [c.file],
        lines: [c.line],
      },
    });
  }
  return findings;
}

/** Re-homes `checkUnescapedHtml` + `checkInterpolation`: emit a finding per
 *  sink-reaching unescaped member-access interpolation. */
function detectUnescapedHtml(candidates: readonly SecurityCandidate[]): Finding[] {
  const findings: Finding[] = [];
  for (const c of candidates) {
    if (c.kind !== 'unescaped-html') continue;
    if (isTestOrFixtureFile(c.file)) continue;
    const prop = c.prop;
    findings.push({
      ruleId: 'unescaped-html-interpolation',
      severity: 'severe',
      message:
        `Unescaped HTML interpolation: ${prop} is inserted into an HTML template without an escaping call. ` +
        'Analysis-controlled strings (file paths, messages, previews) can carry markup — wrap the interpolation in escapeHtml() to prevent stored XSS.',
      file: c.file,
      line: c.line,
      column: c.column,
      symbol: prop,
      resolution: {
        action: 'escape-html-interpolation',
        summary: `Wrap the ${prop} interpolation in an escaping call (e.g. \${escapeHtml(${prop})}) before it reaches the HTML template.`,
        symbols: [prop],
        files: [c.file],
        lines: [c.line],
      },
    });
  }
  return findings;
}

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
    return detectCommandInjection(ctx.facts['security-candidates']);
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
    return detectDynamicRequire(ctx.facts['security-candidates']);
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
    return detectUnescapedHtml(ctx.facts['security-candidates']);
  },
};

/** The three single-file security rules this slice migrates, in registry order. */
export const securityDefectRules: readonly RuleDefinition<SecurityDefectNeeds>[] = [
  commandInjectionRisk,
  dynamicRequireOfProjectPath,
  unescapedHtmlInterpolation,
];
