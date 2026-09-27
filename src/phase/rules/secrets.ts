/**
 * Spec 68 §3.2 — the hardcoded-credential rules, migrated to `analyze(ctx)`.
 *
 * `hardcoded-secret` re-homes `UniversalSecretsAnalyzer.inspectNode`'s
 * *classification* half: given a `secret-candidates` fact (which the producer
 * built from the four credential positions — variable/assignment/pair/call —
 * carrying the name/key/args and the enclosing node's start position), it runs
 * the pure decision the legacy analyzer made inside the same `walkAST` loop.
 * The producer projected the positional context; this rule decides whether it is
 * a secret.
 *
 * The classification helpers (`SECRET_NAMES`, `normalizeName`, `isSecretName`,
 * `looksLikeRealSecret`, `isPlaceholder`, `hasKnownTokenPrefix`,
 * `isCredentialSelector`, `HARD_SYMBOL`, `PLACEHOLDERS`, `isTestOrFixtureFile`)
 * are re-homed verbatim — copied, not imported, because the analyzer is deleted
 * in §15 and the rule must not couple the new pipeline to a class about to
 * disappear. The `isTestOrFixtureFile` skip, which the legacy analyzer applied
 * per-file before walking, becomes a per-candidate skip here (a file is either a
 * test fixture or not, so the two are equivalent).
 *
 * `hardcoded-connection` (the other security rule, reading `string-literals`)
 * lives in `security.ts` alongside this file; both are re-exported from
 * `securityRules` in that module so the registry and runner stay unchanged.
 */

import type { RuleDefinition, Finding, SecretCandidate } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';

const META = RULE_REGISTRY['hardcoded-secret'];

/** The declaration for `hardcoded-secret`: it reads `secret-candidates`. */
type SecretNeeds = {
  readonly formats: readonly ['typescript', 'tsx', 'javascript'];
  readonly facts: readonly ['secret-candidates'];
};

// ── Classification (re-homed verbatim from UniversalSecretsAnalyzer) ───────

/** Secret-ish names, normalized so `apiKey`/`api_key`/`API_KEY`/`x-api-key`
 *  collapse to one form. */
const SECRET_NAMES = new Set([
  'password', 'passwd', 'pwd', 'passphrase',
  'secret', 'clientsecret',
  'apikey',
  'accesskey', 'accesstoken',
  'authtoken',
  'token',
  'privatekey',
  'credential', 'credentials',
  'awssecret', 'awskey',
  'sessionkey', 'signingkey',
  'authorization',
  'xapikey', 'xauthtoken',
]);

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretName(name: string): boolean {
  const norm = normalizeName(name);
  return norm.length > 0 && SECRET_NAMES.has(norm);
}

/** A symbol that is not a common word separator (`-`, `_`, `.`, space). */
const HARD_SYMBOL = /[^A-Za-z0-9\-_.\s]/;

/** A known token prefix (`Bearer …`, `sk-…`, `ghp_…`, `AKIA…`, `xoxb-…`, JWT). */
function hasKnownTokenPrefix(value: string): boolean {
  const t = value.trim();
  return (
    /^Bearer\s/i.test(t) ||
    /^sk-[A-Za-z0-9]{20,}/.test(t) ||
    /^(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9]{20,}/.test(t) ||
    /^(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/.test(t) ||
    /^AKIA[0-9A-Z]{16}$/.test(t) ||
    /^xox[baprs]-/.test(t) ||
    /^eyJ[A-Za-z0-9_-]{10,}\./.test(t)
  );
}

const PLACEHOLDERS = new Set([
  'password', 'passwd', 'pwd', 'changeme', 'changethis', 'secret', 'yoursecret',
  'yourapikey', 'yourtoken', 'yourapitoken', 'apikey', 'token', 'example',
  'dummy', 'placeholder', 'replaceme', 'todo', 'fixme', 'xxx', 'xxxx', 'xxxxx',
  'test', 'testpassword', 'testsecret', 'testtoken', '123456', '12345678',
  '123456789', 'password123', 'qwerty', 'letmein', 'abc123', 'foobar',
  'helloworld', 'notareal', 'notreal', 'sample', 'samplekey', 'sampletoken',
  'insecure', 'insecurepassword', 'notasecret',
]);

/** Reject placeholder/example values: templates, redactions, and common words. */
function isPlaceholder(value: string): boolean {
  const t = value.trim();
  if (t.length === 0) return true;
  if (/^<[^>]+>$/.test(t)) return true;
  if (/^[.…]{3,}$/.test(t)) return true;
  if (/^[*xX]{3,}$/.test(t)) return true;
  if (/^redacted$/i.test(t)) return true;
  const norm = normalizeName(t);
  if (PLACEHOLDERS.has(norm)) return true;
  if (/^(your|test|example|sample|dummy|placeholder|replaceme|changeme)/.test(norm)) return true;
  return false;
}

/** Does this literal look like a real credential value rather than a placeholder? */
function looksLikeRealSecret(value: string): boolean {
  const t = value.trim();
  if (isPlaceholder(t)) return false;
  if (hasKnownTokenPrefix(t)) return true;
  if (t.length < 8) return false;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  const hasDigit = /\d/.test(t);
  const hasUpper = /[A-Z]/.test(t);
  const hasHardSymbol = HARD_SYMBOL.test(t);
  return hasDigit || hasUpper || hasHardSymbol;
}

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

/** Is this string a credential *field selector* (`#password`, `.api_key`,
 *  `input[name=token]`)? Extracts the field-name core and checks the set. */
function isCredentialSelector(text: string): boolean {
  let core = text.trim().replace(/^['"]|['"]$/g, '');
  core = core.replace(/^[.#]/, '').trim();
  const bracket = core.match(/\[([^\[\]]+)\]$/);
  if (bracket) core = bracket[1];
  core = core.replace(/^name\s*=\s*["']?|["']?$/gi, '');
  core = core.replace(/["']/g, '').trim();
  return isSecretName(core);
}

// ── Detection ───────────────────────────────────────────────────────────────

/** Build the finding, anchored at the candidate's enclosing-node position. */
function makeFinding(
  file: string,
  line: number,
  column: number,
  name: string | undefined,
  value: string,
): Finding {
  const label = name ? ` "${name}"` : '';
  const reference = name
    ? `process.env.${normalizeName(name).toUpperCase()}`
    : 'process.env.SECRET';
  return {
    ruleId: 'hardcoded-secret',
    severity: 'critical',
    message:
      `Hardcoded secret${label} detected: a ${value.length}-character credential is embedded in source. ` +
      'Move it to an environment variable or secret store.',
    file,
    line,
    column,
    resolution: {
      action: 'remove-hardcoded-secret',
      summary:
        `Replace the hardcoded${label} credential with a reference to an environment variable or secret store (e.g. ${reference}).`,
      symbols: name ? [name] : undefined,
      files: [file],
      lines: [line],
    },
  };
}

/** Re-homes `inspectNode` + `checkCredentialCall`: classify candidates into
 *  hardcoded-secret findings. */
function detectHardcodedSecret(candidates: readonly SecretCandidate[]): Finding[] {
  const findings: Finding[] = [];
  for (const c of candidates) {
    if (isTestOrFixtureFile(c.file)) continue;

    if (c.position === 'call') {
      // `fn('<selector>', '<secret>')` — the page.type reference case.
      if (c.args.length < 2) continue;
      const hasSelector = c.args.some(isCredentialSelector);
      if (!hasSelector) continue;
      for (const value of c.args) {
        if (isCredentialSelector(value)) continue;
        if (looksLikeRealSecret(value)) {
          findings.push(makeFinding(c.file, c.line, c.column, undefined, value));
        }
      }
      continue;
    }

    if (isSecretName(c.name) && looksLikeRealSecret(c.value)) {
      findings.push(makeFinding(c.file, c.line, c.column, c.name, c.value));
    }
  }
  return findings;
}

const hardcodedSecret: RuleDefinition<SecretNeeds> = {
  id: 'hardcoded-secret',
  analyzer: 'secrets',
  needs: { formats: ['typescript', 'tsx', 'javascript'], facts: ['secret-candidates'] },
  severity: 'critical',
  message: META.message,
  docs: META.docs,
  thresholds: META.thresholds,
  samples: META.samples,
  analyze(ctx): Finding[] {
    return detectHardcodedSecret(ctx.facts['secret-candidates']);
  },
};

/** The hardcoded-secret rule this slice migrates, in registry order. */
export const secretsRules: readonly RuleDefinition<SecretNeeds>[] = [
  hardcodedSecret,
];
