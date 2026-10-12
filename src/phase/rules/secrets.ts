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
 * legacy analyzer's *suppression* filters — a minimum length, a placeholder word
 * list, email/URL/camelCase shape tests — made a finding vanish without
 * establishing anything about the site; they stay gone. A candidate is a secret
 * on positive evidence only.
 *
 * Two corrections (directive items 2 + 3) refine the positive evidence and the
 * file scope without restoring a suppression:
 *
 *   - `looksLikeRealSecret` drops the legacy `hasUpper` term. An uppercase letter
 *     is not entropy: the UI label `"API Key"` and the internal identifier
 *     `"styleToken"` both carry uppercase letters yet are labels, not
 *     credentials. A real credential carries a digit or a hard symbol (or a
 *     known token prefix).
 *   - A candidate whose file belongs to the tree's *declared test program* is
 *     skipped (a hardcoded credential in a test/mock is expected). The role is
 *     derived from the tree — the runner named in `package.json` scripts, mapped
 *     to its own discovery convention — not the legacy path-substring heuristic
 *     (`isTestOrFixtureFile`); see `testProgram.ts`.
 *
 * `hardcoded-connection` (the other security rule, reading `string-literals`)
 * lives in `security.ts` alongside this file; both are re-exported from
 * `securityRules` in that module so the registry and runner stay unchanged.
 */

import type { RuleDefinition, Finding, SecretCandidate } from '../types.js';
import { RULE_REGISTRY } from '../../analyzers/ruleRegistry.js';
import { resolveTestProgram } from '../testProgram.js';

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
 *  prefix, or enough character entropy (a digit or a hard symbol). An uppercase
 *  letter alone is *not* entropy — a UI display string (`"API Key"`) and an
 *  internal identifier written as a string (`"styleToken"`) both carry uppercase
 *  letters yet are labels, not credentials; a real credential value carries a
 *  digit or a non-separator symbol (or a known token prefix). The legacy
 *  `hasUpper` term flagged both of those labels as secrets, which is the exact
 *  false positive item 2/3 corrects.
 *
 *  The rule never dismisses a value for being short, a placeholder word, an
 *  email/URL, or a camelCase identifier — those suppressions made a finding
 *  vanish without establishing anything about the site, and stay gone. The
 *  digit/hard-symbol/prefix test is the *positive* evidence, not a suppression. */
function looksLikeRealSecret(value: string): boolean {
  const t = value.trim();
  if (hasKnownTokenPrefix(t)) return true;
  const hasDigit = /\d/.test(t);
  const hasHardSymbol = HARD_SYMBOL.test(t);
  return hasDigit || hasHardSymbol;
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
 *  hardcoded-secret findings.
 *
 *  A candidate whose file belongs to the project's declared test program is
 *  skipped: a hardcoded credential inside a test fixture or mock is expected and
 *  must not block the edit loop. The test-program role is *derived from the
 *  tree* (the runner declared in `package.json` scripts → the runner's own
 *  discovery convention), not a hardcoded path pattern — see `testProgram.ts`. */
function detectHardcodedSecret(candidates: readonly SecretCandidate[], projectRoot: string | undefined): Finding[] {
  const testProgram = resolveTestProgram(projectRoot);
  const findings: Finding[] = [];
  for (const c of candidates) {
    if (testProgram.isTestFile(c.file)) continue;
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
    return detectHardcodedSecret(ctx.facts['secret-candidates'], ctx.projectRoot);
  },
};

/** The hardcoded-secret rule this slice migrates, in registry order. */
export const secretsRules: readonly RuleDefinition<SecretNeeds>[] = [
  hardcodedSecret,
];
