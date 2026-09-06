/**
 * Universal Secrets Analyzer
 * Detects hardcoded credentials, API keys, and tokens in source.
 *
 * The reference case is a Playwright/Puppeteer automation script typing a real
 * password into a login form:
 *
 *   page.type('#password', 'vyy8AUVvish34Fq')
 *
 * A secret is a string literal that (a) sits in a credential position — a
 * variable/field/object-key named like a secret, or a call argument whose
 * sibling argument is a credential selector (`#password`) — and (b) looks like
 * a real value rather than a placeholder (`'password'`, `'your-api-key'`,
 * `'changeme'`).
 *
 * Near-miss classes that must stay silent (critical severity gates — a false
 * positive blocks the edit loop, so precision is the design constraint):
 *   - test fixtures / mocks (`.test.*`, `.spec.*`, `__tests__`, `fixtures`) —
 *     excluded by file path, before any literal is read;
 *   - placeholder values (`'changeme'`, `'your-api-key'`, `'<token>'`) —
 *     rejected by the value heuristic;
 *   - env var references (`process.env.PASSWORD`, `import.meta.env.VITE_KEY`) —
 *     these are `member_expression`/`identifier` nodes, never `string` literals,
 *     so they are never candidates.
 */

import { UniversalAnalyzer } from '../../languages/UniversalAnalyzer.js';
import { withRuleTiming } from '../ruleTiming.js';
import { walkAST } from '../../languages/adapterBridge.js';
import type { Violation } from '../../types.js';
import type { AST, LanguageAdapter, ASTNode } from '../../languages/types.js';

/**
 * Configuration for the Secrets analyzer.
 */
export interface SecretsAnalyzerConfig {
  /** Toggle the hardcoded-secret check. Default true (default-on). */
  checkHardcodedSecrets?: boolean;
}

export const DEFAULT_SECRETS_CONFIG: SecretsAnalyzerConfig = {
  checkHardcodedSecrets: true,
};

/**
 * Secret-ish names, normalized (lowercased, non-alphanumerics stripped) so
 * `apiKey`, `api_key`, `API_KEY`, and `x-api-key` all collapse to one form.
 * Matched against variable names, object keys, field names, and the core of
 * credential selectors (`#password` → `password`).
 */
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

/**
 * Extract the raw text of a `string` literal, preferring the `string_fragment`
 * child (the content without quotes/delimiters) and falling back to stripping
 * surrounding quotes from the node text.
 */
function stringValue(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string {
  const frag = node.children?.find((c) => c.type === 'string_fragment');
  if (frag) return adapter.getNodeText(frag, sourceCode);
  let text = adapter.getNodeText(node, sourceCode).trim();
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith('`') && text.endsWith('`'))
  ) {
    text = text.slice(1, -1);
  }
  return text;
}

/** Find a direct `string` child (the literal value), not a nested one. */
function directStringChild(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  for (const c of node.children ?? []) {
    if (c.type === 'string') return stringValue(c, adapter, sourceCode);
  }
  return null;
}

/** A symbol that is not a common word separator (`-`, `_`, `.`, space). */
const HARD_SYMBOL = /[^A-Za-z0-9\-_.\s]/;

/**
 * A known token prefix (`Bearer …`, `sk-…`, `ghp_…`, `AKIA…`, `xoxb-…`, JWT
 * `eyJ…`) marks a value as a secret on its own, even when it is short.
 */
function hasKnownTokenPrefix(value: string): boolean {
  const t = value.trim();
  return (
    /^Bearer\s/i.test(t) ||
    /^sk-[A-Za-z0-9]{20,}/.test(t) ||                         // OpenAI
    /^(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9]{20,}/.test(t) || // GitHub
    /^(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/.test(t) ||     // Stripe
    /^AKIA[0-9A-Z]{16}$/.test(t) ||                           // AWS access key
    /^xox[baprs]-/.test(t) ||                                 // Slack
    /^eyJ[A-Za-z0-9_-]{10,}\./.test(t)                        // JWT
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
  if (/^<[^>]+>$/.test(t)) return true;        // <your-token>
  if (/^[.…]{3,}$/.test(t)) return true;       // ...
  if (/^[*xX]{3,}$/.test(t)) return true;      // *** or xxx
  if (/^redacted$/i.test(t)) return true;
  const norm = normalizeName(t);
  if (PLACEHOLDERS.has(norm)) return true;
  if (/^(your|test|example|sample|dummy|placeholder|replaceme|changeme)/.test(norm)) return true;
  return false;
}

/**
 * Does this literal look like a real credential value rather than a placeholder?
 *
 * Precision-first: the value must either carry a known token prefix or be long
 * enough (≥8 chars) and show character variety (a digit, an uppercase letter,
 * or a non-separator symbol). Pure-lowercase words (`changeme`) and hyphenated
 * phrases (`your-api-key`) fail this; high-entropy values (`vyy8AUVvish34Fq`)
 * pass. Emails and URLs are explicitly not secrets.
 */
function looksLikeRealSecret(value: string): boolean {
  const t = value.trim();
  if (isPlaceholder(t)) return false;
  if (hasKnownTokenPrefix(t)) return true;
  if (t.length < 8) return false;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return false; // email
  if (/^https?:\/\//i.test(t)) return false;               // URL
  const hasDigit = /\d/.test(t);
  const hasUpper = /[A-Z]/.test(t);
  const hasHardSymbol = HARD_SYMBOL.test(t);
  return hasDigit || hasUpper || hasHardSymbol;
}

/**
 * Is this path a test/fixture file? Excluded up front — a hardcoded credential
 * in a test fixture or mock is expected and must not block the edit loop.
 */
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

/** Extract the variable name from a `variable_declarator`. */
function declaratorName(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const name = node.children?.find((c) => c.type === 'identifier');
  return name ? adapter.getNodeText(name, sourceCode) : null;
}

/** Extract the assigned field name from an `assignment_expression` left side. */
function assignmentKey(node: ASTNode, adapter: LanguageAdapter, sourceCode: string): string | null {
  const left = node.children?.find(
    (c) => c.type === 'member_expression' || c.type === 'subscript_expression' || c.type === 'identifier',
  );
  if (!left) return null;
  if (left.type === 'member_expression') {
    const prop = left.children?.find((c) => c.type === 'property_identifier');
    return prop ? adapter.getNodeText(prop, sourceCode) : null;
  }
  if (left.type === 'subscript_expression') {
    const key = left.children?.find((c) => c.type === 'string');
    return key ? stringValue(key, adapter, sourceCode) : null;
  }
  return adapter.getNodeText(left, sourceCode);
}

/** Extract `{ key, value }` from an object `pair` node. */
function pairKeyAndValue(
  node: ASTNode,
  adapter: LanguageAdapter,
  sourceCode: string,
): { key: string; value: string } | null {
  const strings = (node.children ?? []).filter((c) => c.type === 'string');
  if (strings.length === 0) return null;
  const keyNode = node.children?.find((c) => c.type === 'property_identifier') ?? strings[0];
  const valueNode = strings[strings.length - 1];
  if (valueNode === keyNode && strings.length < 2) return null;
  const key = keyNode.type === 'property_identifier'
    ? adapter.getNodeText(keyNode, sourceCode)
    : stringValue(keyNode, adapter, sourceCode);
  const value = stringValue(valueNode, adapter, sourceCode);
  return { key, value };
}

/**
 * Is this string a credential *field selector* (`#password`, `.api_key`,
 * `input[name=token]`)? Extracts the field-name core and checks it against the
 * secret-name set.
 */
function isCredentialSelector(text: string): boolean {
  let core = text.trim().replace(/^['"]|['"]$/g, '');
  core = core.replace(/^[.#]/, '').trim();
  const bracket = core.match(/\[([^\[\]]+)\]$/);
  if (bracket) core = bracket[1];
  core = core.replace(/^name\s*=\s*["']?|["']?$/gi, '');
  core = core.replace(/["']/g, '').trim();
  return isSecretName(core);
}

/**
 * Flags hardcoded credentials, API keys, and tokens. Critical severity — a false
 * positive blocks the edit loop, so detection is precision-first (see the file
 * header for the near-miss classes that must stay silent).
 */
export class UniversalSecretsAnalyzer extends UniversalAnalyzer {
  readonly name = 'secrets';
  readonly description = 'Detects hardcoded credentials, API keys, and tokens';
  readonly category = 'security';

  protected async analyzeAST(
    ast: AST,
    adapter: LanguageAdapter,
    config: SecretsAnalyzerConfig,
    sourceCode: string,
  ): Promise<Violation[]> {
    const violations: Violation[] = [];
    const finalConfig = { ...DEFAULT_SECRETS_CONFIG, ...config };
    if (finalConfig.checkHardcodedSecrets === false) return violations;
    if (isTestOrFixtureFile(ast.filePath)) return violations;

    withRuleTiming('hardcoded-secret', () => {
      walkAST(ast.root, (node) => {
        const violation = this.inspectNode(node, adapter, sourceCode, ast.filePath);
        if (violation) violations.push(violation);
      });
    });

    return violations;
  }

  /**
   * Inspect one AST node for a hardcoded credential in a credential position;
   * returns the violation to report, or null.
   */
  private inspectNode(
    node: ASTNode,
    adapter: LanguageAdapter,
    sourceCode: string,
    filePath: string,
  ): Violation | null {
    // 1. `const <name> = '<value>'`
    if (node.type === 'variable_declarator') {
      const name = declaratorName(node, adapter, sourceCode);
      const value = directStringChild(node, adapter, sourceCode);
      if (name && value !== null && isSecretName(name) && looksLikeRealSecret(value)) {
        return this.makeViolation(filePath, node, name, value);
      }
      return null;
    }

    // 2. `<obj>.<field> = '<value>'` / `<field> = '<value>'`
    if (node.type === 'assignment_expression') {
      const key = assignmentKey(node, adapter, sourceCode);
      const value = directStringChild(node, adapter, sourceCode);
      if (key && value !== null && isSecretName(key) && looksLikeRealSecret(value)) {
        return this.makeViolation(filePath, node, key, value);
      }
      return null;
    }

    // 3. `{ <key>: '<value>' }`
    if (node.type === 'pair') {
      const pv = pairKeyAndValue(node, adapter, sourceCode);
      if (pv && isSecretName(pv.key) && looksLikeRealSecret(pv.value)) {
        return this.makeViolation(filePath, node, pv.key, pv.value);
      }
      return null;
    }

    // 4. `fn('<selector>', '<secret>')` — a credential selector string plus a
    //    sibling secret-value string (the page.type reference case).
    if (node.type === 'call_expression') {
      return this.checkCredentialCall(node, adapter, sourceCode, filePath);
    }

    return null;
  }

  private checkCredentialCall(
    node: ASTNode,
    adapter: LanguageAdapter,
    sourceCode: string,
    filePath: string,
  ): Violation | null {
    const argsNode = node.children?.find((c) => c.type === 'arguments');
    if (!argsNode) return null;
    const stringArgs = (argsNode.children ?? []).filter((c) => c.type === 'string');
    if (stringArgs.length < 2) return null;

    const hasSelector = stringArgs.some((a) => isCredentialSelector(stringValue(a, adapter, sourceCode)));
    if (!hasSelector) return null;

    for (const a of stringArgs) {
      const value = stringValue(a, adapter, sourceCode);
      if (isCredentialSelector(value)) continue; // the selector is not the secret
      if (looksLikeRealSecret(value)) {
        return this.makeViolation(filePath, node, undefined, value);
      }
    }
    return null;
  }

  private makeViolation(file: string, node: ASTNode, name: string | undefined, value: string): Violation {
    const label = name ? ` "${name}"` : '';
    const reference = name
      ? `process.env.${normalizeName(name).toUpperCase()}`
      : 'process.env.SECRET';
    return this.createViolation(
      file,
      node.location.start,
      `Hardcoded secret${label} detected: a ${value.length}-character credential is embedded in source. Move it to an environment variable or secret store.`,
      {
        severity: 'critical',
        rule: 'hardcoded-secret',
        resolution: {
          action: 'remove-hardcoded-secret',
          summary: `Replace the hardcoded${label} credential with a reference to an environment variable or secret store (e.g. ${reference}).`,
          symbols: name ? [name] : undefined,
          files: [file],
          lines: [node.location.start.line],
        },
      },
    );
  }
}
