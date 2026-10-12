/**
 * verify:self — pure decision logic, extracted so gate-liveness tests can import
 * it without re-running the audit.
 *
 * This module is side-effect free: it exports the scope filter, the
 * correct-by-design exemption map, and the blocking-severity predicate that
 * `scripts/verify-self.mjs` applies to the self-audit report. The script keeps
 * the I/O (run the audit, read the report, print, exit); the decisions live here
 * so a regression — e.g. re-narrowing the predicate to `critical | severe`, or
 * silently dropping an exemption — fails a unit test instead of passing the gate
 * for months.
 */

/**
 * Spec 54 R3 — the gate blocks every severity on the ladder (`critical`,
 * `severe`, `high`), matching `BLOCKING_SEVERITIES` in `src/types.ts`. There is
 * no "informational" tier at the gate. `off` is a config state, never an emitted
 * finding.
 */
export function isBlockingSeverity(v) {
  return v.severity === 'critical' || v.severity === 'severe' || v.severity === 'high';
}

/**
 * Strip the `<appRoot>/src/` prefix from a report path so scope checks are
 * against the repo-relative path under `src/` (e.g. `analyzers/…`, `cli.ts`).
 * Returns null when the path is not under `<appRoot>/src/` — the dev tooling
 * under `scripts/`, `bench/`, `editors/`, `tests/` is not part of the shipped
 * `src` product, and a foreign `…/src/` elsewhere on disk is not this app's.
 *
 * When `appRoot` is omitted, the last `/src/` segment is stripped instead
 * (unit-test shorthand); the gate always passes the real app root.
 */
export function scopedPath(file, appRoot) {
  if (appRoot) {
    const prefix = appRoot.replace(/\/+$/, '') + '/src/';
    return file.startsWith(prefix) ? file.slice(prefix.length) : null;
  }
  const idx = file.lastIndexOf('/src/');
  if (idx === -1) return null;
  return file.slice(idx + '/src/'.length);
}

/**
 * The self-audit scope is the whole shipped product (Spec 68 §13.1): every file
 * under `src/` that is production source. Excluded, by directory and by
 * extension, are the tool's own test corpus and fixture corpora — test/spec
 * files and `__tests__`/`fixtures` directories carry deliberately-invalid data
 * (fake table names, hardcoded connection strings) that exists to be flagged by
 * the very rules it exercises. This is a *scope* boundary (Amendment 2), never
 * a per-rule exemption and never a suppression inside a rule: no rule body is
 * taught to ignore a name, and `SCOPED_EXEMPTIONS` does not grow. Plus one
 * whole-file exclusion (ruleRegistry.ts), a pure declarative data table whose
 * fixture content trips string-content detectors.
 */
export function inScope(file, appRoot) {
  const rel = scopedPath(file, appRoot);
  if (!rel) return false;
  if (/(^|\/)(__tests__|fixtures)\//.test(rel)) return false;
  if (/\.(test|spec)\.[^.]+$|\.test-d\.ts$|\.tst\.ts$/.test(rel)) return false;
  // ruleRegistry.ts is a pure declarative data table (the RULE_REGISTRY const
  // plus three interfaces — no executable logic). Its Spec 37 R3 rule samples
  // are intentional bad-code fixtures (e.g. a hardcoded connection string, a
  // string-concatenated SQL query) that exist to be flagged by the rules they
  // document. The string-content detectors (hardcoded-connection,
  // sql-injection) therefore flag them as false positives on the self-audit.
  // Excluding this data table removes only those fixture false positives; it
  // loses no coverage of analyzer logic (long functions / param counts /
  // runtime SQL) because a data table can host none of those.
  if (rel === 'analyzers/ruleRegistry.ts') return false;
  return true;
}

// --- Scoped exemptions (Spec 54 R3, Spec 68 §13.1) --------------------------
// Correct-by-design findings the all-three-severity gate would otherwise flag.
// Each is a *scope* decision — the code is correct and no refactor is warranted
// — not a severity re-label: the gate still blocks `high`, and these specific
// (file, rule) pairs are excluded with a rationale. Excluding a whole file (the
// `inScope` mechanism above) would be wrong here, because each of these files
// hosts real analyzer logic beyond the single flagged construct; the exemption
// is therefore keyed on the exact rule at the exact path.
//
// Spec 68 §13.1 emptied the three pre-§68 entries (RuntimeManager.ts ::
// solid/open-closed, and the two Go parser files :: switch-size) because they
// keyed on files the §9/§15 Go rework deleted — the Go subprocess source is gone
// and Go analysis now runs through the phase model's tree-sitter grammar. A dead
// (file, rule) exemption is the SKIP_RULES failure mode, so they are removed
// rather than left to rot.
//
// One post-§68 entry remains, for a reason, not as backlog. The Spec 68 §3.2
// secrets rework removed the legacy `UniversalSecretsAnalyzer` suppression
// filters — a minimum length, a placeholder word list, email/URL/camelCase shape
// tests, and a test/fixture skip — see `src/phase/rules/secrets.ts`. Those
// filters made a finding vanish without establishing anything about the site;
// the rule now decides a candidate is a secret on positive evidence only. A
// consequence is that QueryParser.ts's declarative operator map trips the rule:
// the key `token:` (a search-query operator label, one of `css:`/`value:`/
// `mechanism:`/`token:`) normalizes to the secret name `token`, and its value
// `styleToken` (a filter key, see METADATA_FILTER_KEYS) carries an uppercase
// letter, satisfying the rule's digit/upper/hard-symbol entropy test. Neither is
// a credential; `styleToken` is an internal identifier with no secret content.
// The fix is not to re-add a camelCase suppression (the exact filter removed in
// §3.2) nor to rename a referenced filter key to dodge a false positive; it is a
// correct-by-design exclusion at the one (file, rule) pair.
const SCOPED_EXEMPTIONS = new Map([
  ['search/QueryParser.ts', new Set(['hardcoded-secret'])],
]);

/** True when a scoped violation is a correct-by-design finding at a known (file, rule) pair. */
export function isScopedExempt(rel, rule) {
  const rules = SCOPED_EXEMPTIONS.get(rel);
  return rules ? rules.has(rule) : false;
}

/** Canonical key for a (file, rule) exemption, shared by the matcher and the staleness check. */
export function scopedExemptionKey(file, rule) {
  return `${file}\0${rule}`;
}

/**
 * An exemption is a *decision about a finding*, and a finding can stop existing.
 * Every (file, rule) pair in SCOPED_EXEMPTIONS must still fire: if a pair no
 * longer produces a scoped blocking violation (the code was fixed, refactored,
 * or the rule was renamed/removed), the exemption is dead and the gate fails
 * rather than letting the suppression list silently accumulate — the exact
 * shape that produced SKIP_RULES' 33 stale entries. `matchedKeys` is the set of
 * `scopedExemptionKey(file, rule)` that a violation actually matched this run.
 */
export function staleExemptions(matchedKeys) {
  const stale = [];
  for (const [file, rules] of SCOPED_EXEMPTIONS) {
    for (const rule of rules) {
      if (!matchedKeys.has(scopedExemptionKey(file, rule))) stale.push({ file, rule });
    }
  }
  return stale;
}
