/**
 * Corpus-derived fixture — D1/Workers report, dependency-inversion escape.
 *
 * Source: an external audit (CHANGELOG 3.9.1, "escapes-vs-held"), which found
 * `solid/dependency-inversion` firing on constructed values that *escape* the
 * class rather than being *held* as state. A value that is thrown or returned
 * is a value type, not a collaborator the class depends on.
 *
 * Expected: **no** `solid/dependency-inversion` on either class below. The
 * field-held collaborator (a genuine DIP break) is pinned separately in the
 * rule's unit spec; this fixture pins the report's two false positives:
 *
 *  - `throw new AppError(...)`      — a domain error value, thrown.
 *  - `return new QueryBuilder(this)` — a factory accessor value, returned.
 */

/** A domain error value type. */
export class AppError extends Error {
  /** Build the error with a message. */
  constructor(message: string) {
    super(message);
    this.name = 'AppError';
  }
}

/** A query builder value produced by a factory accessor. */
export class QueryBuilder {
  /** The owner repository (kept for parity with the knex Client accessor). */
  private owner: unknown;

  /** Build the builder against an owner. */
  constructor(owner: unknown) {
    this.owner = owner;
  }
}

/** A worker whose only construction throws a value type — not a held collaborator. */
export class RateLimiter {
  /** Reject with a domain error when the request is absent. */
  async fetch(request: unknown): Promise<string> {
    if (!request) {
      throw new AppError('missing request');
    }
    return 'ok';
  }
}

/** A repository exposing a factory accessor returning a fresh builder value. */
export class Repository {
  /** Build a query builder bound to this repository — a value, not a dependency. */
  builder(): QueryBuilder {
    return new QueryBuilder(this);
  }
}
