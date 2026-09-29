/**
 * similar-expression.ts — `dry/similar-expression` (rule 22) at production scale.
 *
 * The expression half of the DRY family compares *shape fragments*, not code
 * blocks: an object literal's field names, or a call chain's method names. Two
 * fragments fire when they share `minShapeNames` (4) names via longest-common-
 * subsequence, are the same fragment *kind* (object vs chain), and target the
 * same thing. This corpus pins both sub-signals:
 *
 *   - object literal — `const cfg = {...}` built twice with the same field list
 *     but different values. Both carry target `cfg`, so the "built twice" test
 *     passes; the shared fields are `host, port, timeout, retries, ssl`.
 *   - call chain — `repo.load().normalize().validate().persist()` run twice.
 *     None of those method names is in the fluent-library set (query/schema
 *     builders, validators, commander, promises, DOM/stdlib), so it is treated
 *     as duplicated domain logic, not library API.
 *
 * The rule's anchor is the *second* fragment's start line — the repeat, not the
 * original. Fluent chains (`select().where()`, `string().trim().min()`) are
 * excluded at the rule: structurally similar by design, not duplicated logic.
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @fires dry/similar-expression 41 — the `cfg` object literal built twice (5 shared fields)
 *   @fires dry/similar-expression 58 — the four-method non-fluent call chain run twice
 */

/** An object literal built twice — the "built twice" object half. */
export function buildDevConfig() {
  const cfg = {
    host: 'localhost',
    port: 5432,
    timeout: 5000,
    retries: 3,
    ssl: true,
  };
  return cfg;
}

/** The same field list, different values — the repeat, not the original. */
export function buildProdConfig() {
  const cfg = {
    host: 'prod.db.internal',
    port: 5432,
    timeout: 5000,
    retries: 3,
    ssl: true,
  };
  return cfg;
}

/** A non-fluent call chain — duplicated domain logic, not library API. */
export function persistCustomer(repo: any) {
  return repo.load().normalize().validate().persist();
}

/** The same four-method chain, run a second time. */
export function persistVendor(repository: any) {
  return repository.load().normalize().validate().persist();
}
