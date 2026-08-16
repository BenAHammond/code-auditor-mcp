/**
 * Spec 36 R7 — suppressions decay.
 *
 * The only suppression mechanism code-auditor offers is an inline source
 * directive, and it is *required to expire*: a directive that outlives its
 * finding is itself an error (the `@ts-expect-error` / `--report-unused-disable`
 * shape). There is no acknowledged state and no stored list — a suppression is
 * a comment in the diff, with a required reason, and it decays the moment the
 * finding it names stops firing.
 *
 * Directive grammar (a trailing `-- reason` is mandatory):
 *
 *   // code-audit-disable-next-line <rule-id> -- <reason>
 *   // code-audit-disable-line      <rule-id> -- <reason>
 *
 *   `disable-next-line` targets the following line; `disable-line` targets the
 *   line it appears on. Both name exactly one rule ID.
 *
 * Three outcomes, mirroring the spec's three required checks:
 *   - matched  → the finding is marked suppressed (non-blocking) with the reason;
 *   - no reason → a *reasonless* suppression, an error;
 *   - matched nothing → an *unnecessary* suppression, an error.
 */
import { readFileSync } from 'node:fs';
import { canonicalRuleId } from '../ruleAliases.js';
import type { Violation } from '../types.js';

export interface SuppressionDirective {
  /** Absolute file path the directive lives in. */
  file: string;
  /** Directive's own line (1-based). */
  line: number;
  /** The line a finding must be on for this directive to match. */
  targetLine: number;
  /** Canonical rule ID the directive suppresses. */
  rule: string;
  /** Required rationale. Empty string means the directive was malformed. */
  reason: string;
  kind: 'disable-line' | 'disable-next-line';
  raw: string;
}

export interface SuppressionResult {
  /** Violations a directive suppressed — removed from the blocking gate, kept in reports. */
  suppressed: Violation[];
  /** Directives with a required reason that matched no finding — an error (R7). */
  unnecessary: SuppressionDirective[];
  /** Directives missing a reason — an error (R7). */
  reasonless: SuppressionDirective[];
  /** Violations that were NOT suppressed (the gate still sees these). */
  remaining: Violation[];
}

const DIRECTIVE_RE =
  /code-audit-disable-(next-line|line)\s+([A-Za-z0-9/_-]+)\s*(?:--\s*(.*))?/;

/**
 * Find the first comment marker (`//` or `/*`) on a line that is NOT inside a
 * string literal. This is what keeps a directive that merely appears inside a
 * string (`const s = '// code-audit-disable-next-line …'`) from being read as a
 * real suppression — the Spec 37 R3 near-miss discipline applied to the
 * suppression scanner itself.
 */
function findCommentMarker(text: string): { index: number; kind: 'line' | 'block' } | null {
  let quote: '"' | "'" | '`' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (c === '\\') {
        i++; // skip the escaped character
        continue;
      }
      if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') return { index: i, kind: 'line' };
    if (c === '/' && text[i + 1] === '*') return { index: i, kind: 'block' };
  }
  return null;
}

/**
 * Parse suppression directives out of a single source file's text.
 */
export function parseSuppressionDirectives(
  file: string,
  source: string,
): SuppressionDirective[] {
  const directives: SuppressionDirective[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const text = lines[i];
    // The directive only counts inside a comment — a line with no comment
    // marker (or a marker inside a string literal) is not a suppression site.
    const marker = findCommentMarker(text);
    if (marker === null) continue;
    const searchable = text.slice(marker.index);

    const match = DIRECTIVE_RE.exec(searchable);
    if (!match) continue;

    const kind = `disable-${match[1]}` as SuppressionDirective['kind'];
    const rule = match[2];
    const reason = (match[3] ?? '').trim();
    directives.push({
      file,
      line: lineNo,
      targetLine: kind === 'disable-next-line' ? lineNo + 1 : lineNo,
      rule: canonicalRuleId(rule),
      reason,
      kind,
      raw: text.trim(),
    });
  }
  return directives;
}

/**
 * Load suppression directives from the given files on disk. Files that cannot
 * be read are skipped (the audit already reports unreadable files separately).
 */
export function collectSuppressionDirectives(files: string[]): SuppressionDirective[] {
  const out: SuppressionDirective[] = [];
  for (const file of files) {
    try {
      out.push(...parseSuppressionDirectives(file, readFileSync(file, 'utf-8')));
    } catch {
      // unreadable — surfaced elsewhere as an unparsed/unreadable file
    }
  }
  return out;
}

/**
 * Apply directives to violations. Matching is by canonical rule ID and line —
 * a rename consulted through {@link canonicalRuleId} still suppresses, so a
 * directive survives a rule rename exactly like a baseline fingerprint does.
 */
export function applySuppressions(
  violations: Violation[],
  directives: SuppressionDirective[],
): SuppressionResult {
  const suppressed: Violation[] = [];
  const remaining: Violation[] = [];
  const used = new Set<number>();

  // Reset any prior suppression state so this call is idempotent — a violation
  // object may carry flags from an earlier application against a different
  // directive set, and stale flags would otherwise leak into `suppressed`.
  for (const v of violations) {
    delete (v as any).suppressed;
    delete (v as any).suppressionReason;
    delete (v as any).suppressionKind;
  }

  const byRuleAndLine = new Map<string, Violation[]>();
  for (const v of violations) {
    const key = `${canonicalRuleId(v.rule)}:${v.file}:${v.line ?? 0}`;
    const list = byRuleAndLine.get(key);
    if (list) list.push(v);
    else byRuleAndLine.set(key, [v]);
  }

  for (let di = 0; di < directives.length; di++) {
    const d = directives[di];
    // A directive without a reason is not a valid suppression (R7) — it errors
    // as reasonless below and never suppresses.
    if (!d.reason) continue;
    const key = `${d.rule}:${d.file}:${d.targetLine}`;
    const matches = byRuleAndLine.get(key) ?? [];
    if (matches.length > 0) {
      used.add(di);
      for (const v of matches) {
        (v as any).suppressed = true;
        (v as any).suppressionReason = d.reason;
        (v as any).suppressionKind = d.kind;
      }
    }
  }

  for (const v of violations) {
    if ((v as any).suppressed) suppressed.push(v);
    else remaining.push(v);
  }

  const unnecessary: SuppressionDirective[] = [];
  const reasonless: SuppressionDirective[] = [];
  for (let di = 0; di < directives.length; di++) {
    const d = directives[di];
    if (!d.reason) {
      reasonless.push(d);
    } else if (!used.has(di)) {
      unnecessary.push(d);
    }
  }

  return { suppressed, unnecessary, reasonless, remaining };
}
