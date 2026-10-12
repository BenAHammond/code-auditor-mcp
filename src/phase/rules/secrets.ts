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
 * The positive discriminants (`SECRET_NAMES`, `normalizeName`, `isSecretName`,
 * `hasKnownTokenPrefix`, `isCredentialSelector`, `HARD_SYMBOL`) are re-homed
 * verbatim — copied, not imported, because the analyzer is deleted in §15 and
 * the rule must not couple the new pipeline to a class about to disappear. The
 * legacy analyzer's suppression filters — a minimum length, a placeholder word
 * list, email/URL/camelCase shape tests, and a test/fixture file skip — made a
 * finding vanish without establishing anything about the site; they are
 * deliberately not carried over. A candidate is a secret on positive evidence
 * only.
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

/** Does this literal carry positive evidence of a real credential? A known token
 *  prefix, or enough character entropy (a digit, an uppercase letter, or a hard
 *  symbol). It never dismisses a value for being short, a placeholder word, an
 *  email/URL, or a camelCase identifier — those suppressions made a finding
 *  vanish without establishing anything about the site, and are gone. */
function looksLikeRealSecret(value: string): boolean {
  const t = value.trim();
  if (hasKnownTokenPrefix(t)) return true;
  const hasDigit = /\d/.test(t);
  const hasUpper = /[A-Z]/.test(t);
  const hasHardSymbol = HARD_SYMBOL.test(t);
  return hasDigit || hasUpper || hasHardSymbol;
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
