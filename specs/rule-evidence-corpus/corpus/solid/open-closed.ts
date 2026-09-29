/**
 * open-closed.ts — `solid/open-closed` (rule 3) at production scale.
 *
 * The Open/Closed Principle: a class should be open for extension but closed
 * for modification. The signal this rule reads is `instanceof` against a
 * *user-defined* type inside a class body — a switch-on-type that will need to
 * change every time a new subtype is added, rather than dispatching through
 * polymorphism. It fires one finding per class (anchored at the class
 * declaration line) when that class tests `instanceof` against at least one
 * domain type.
 *
 * Two exclusions keep the signal honest, and this corpus pins both:
 *
 *   1. Built-ins are excluded at the *producer* (`BUILTIN_TYPES` in
 *      fileSymbols.ts): `instanceof Date` / `instanceof Response` /
 *      `instanceof ReadableStream` are platform type-checks, not extensibility
 *      signals. A class that only tests built-ins never even reaches the rule.
 *
 *   2. Error subclasses are excluded at the *rule*: `isErrorSubclass` resolves
 *      the target up its `extends` chain against the corpus-wide class
 *      declarations, so `instanceof PaymentError` (where `PaymentError extends
 *      Error`) is a catch-dispatch guard, not an OCP violation. This is NOT a
 *      `/Error$/` name test — a name that merely *ends* in "Error" but does not
 *      extend Error still fires, and an Error subclass whose name does not end
 *      in "Error" still quiets.
 *
 * `dependency-inversion` (old rule 16) is intentionally absent from this
 * corpus: Spec 68 tombstoned it, and its real signal — "a concrete type is
 * instantiated where its interface/abstract base was declared in-repo" — is not
 * computed by any current rule. That gap is documented in REPORT.md, not faked
 * here.
 *
 * ── Expected verdicts (human, not the tool) ────────────────────────────────
 *   @fires solid/open-closed 68 — instanceof a plain domain type (PaymentMethod) is an OCP violation
 *   @quiet solid/open-closed 78 — instanceof an Error subclass (PaymentError) is a catch-dispatch guard
 *   @quiet solid/open-closed 88 — instanceof an Error subclass whose name does NOT end in "Error" (PaymentFailure extends Error) still quiets — the extends-chain walk, not a name test
 *   @fires solid/open-closed 98 — instanceof a type that merely ENDS in "Error" but does not extend Error (RecordError) still fires — name is not sufficient
 *   @quiet solid/open-closed 108 — instanceof a web-platform global (Response) is excluded as builtin
 *   @quiet solid/open-closed 115 — instanceof a builtin primitive wrapper (Date) is excluded
 *   @quiet solid/open-closed 122 — no instanceof at all stays quiet
 */

/** A plain domain type — not an error, not built-in. */
class PaymentMethod {
  constructor(readonly kind: 'card' | 'invoice' | 'voucher') {}
}

/** A domain model that merely *ends* in "Error" but is not an exception. */
class RecordError {
  constructor(readonly code: string, readonly message: string) {}
}

/** A real error type. */
class PaymentError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** An error type whose name does NOT end in "Error" — still an Error subclass. */
class PaymentFailure extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** `instanceof` a plain domain type — the OCP violation. */
export class BillingService {
  settle(value: unknown) {
    if (value instanceof PaymentMethod) {
      return value.kind;
    }
    return 'unknown';
  }
}

/** `instanceof` an Error subclass — a catch-dispatch guard, not a violation. */
export class PaymentGuard {
  guard(value: unknown) {
    if (value instanceof PaymentError) {
      return value.message;
    }
    return null;
  }
}

/** `instanceof` a non-"Error"-named Error subclass — still a guard. */
export class FailureGuard {
  guard(value: unknown) {
    if (value instanceof PaymentFailure) {
      return value.message;
    }
    return null;
  }
}

/** `instanceof` a type that only *ends* in "Error" — name is not sufficient. */
export class RecordInspector {
  inspect(value: unknown) {
    if (value instanceof RecordError) {
      return value.code;
    }
    return null;
  }
}

/** `instanceof` a web-platform global — excluded as builtin. */
export class HttpGateway {
  isResponse(value: unknown) {
    return value instanceof Response;
  }
}

/** `instanceof` a builtin primitive wrapper — excluded. */
export class Scheduler {
  isScheduled(value: unknown) {
    return value instanceof Date;
  }
}

/** No `instanceof` at all — nothing to flag. */
export class NoChecks {
  run(): string {
    return 'done';
  }
}
