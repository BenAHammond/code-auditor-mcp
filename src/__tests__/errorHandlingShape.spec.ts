/**
 * Spec-49 — `conventions/error-handling` (order #7 remainder, ledger row 38).
 *
 * The authenticity ledger marked `conventions/error-handling` crude with one
 * gap: the error-handling shape is classified by a *first-match regex over raw
 * body text*, which (a) collapses a body that mixes two shapes down to whichever
 * one the regex saw first, and (b) misclassifies text — a string or comment
 * containing `try {` reads as a try/catch, `if (errorMessage)` reads as `if-err`.
 *
 * The honest signal is structural: walk the function body's AST and classify
 * the error-handling shape from real nodes —
 *   - `try-catch`      — a `catch_clause` (a real try/catch, not `try`/`finally`)
 *   - `promise-catch`  — a `.catch(...)` call
 *   - `if-err`         — an `if` whose condition references an `err`/`error` value
 *   - `go-style`       — a `.success` member access
 * A body exhibiting *more than one* distinct shape is ambiguous and must be
 * excluded (null), never collapsed to the first match.
 *
 * These tests run the real `detectErrorHandlingShape` against stored body text
 * (the `{...}` statement_block captured into `functions.metadata_json.body`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initParsers } from '../languages/index.js';
import { detectErrorHandlingShape } from '../conventions/conventionMiner.js';

beforeAll(async () => {
  await initParsers();
}, 30_000);

/** A clean try/catch body — the canonical `try-catch` shape. */
const TRY_CATCH_BODY = `{
  try {
    return await db.query("SELECT * FROM users");
  } catch (e) {
    return null;
  }
}`;

/** A clean `.catch()` body — the `promise-catch` shape. */
const PROMISE_CATCH_BODY = `{
  return db.query("SELECT * FROM users").catch(() => null);
}`;

/** A string literal that merely *contains* `try {` — no real try/catch. The old
 *  regex saw the substring and called it `try-catch`; the honest predicate must
 *  not. */
const STRING_LITERAL_BODY = `{
  const s = "try { this is not a real try block";
  return s;
}`;

/** A body that mixes try/catch AND `.catch()` — two distinct shapes. The old
 *  first-match regex collapsed it to `try-catch`; the honest predicate must
 *  recognise the ambiguity and return null. */
const MULTI_SHAPE_BODY = `{
  try {
    return await f();
  } catch (e) {
    return fallback().catch(() => null);
  }
}`;

/** `if (errorMessage)` — the condition references a string, not an error value.
 *  The old regex matched the `err` prefix of `errorMessage`; the honest
 *  predicate must not. */
const IF_ERROR_MESSAGE_BODY = `{
  if (errorMessage) {
    return errorMessage;
  }
  return null;
}`;

/** `if (err)` — a bare error-presence check, the canonical `if-err` shape. */
const IF_ERR_BODY = `{
  if (err) {
    return err;
  }
  return null;
}`;

/** `if (err instanceof Error)` — type narrowing, not an error-presence check.
 *  A structural detector that merely looks for an `err` identifier would
 *  misclassify this as `if-err`. */
const IF_ERR_INSTANCEOF_BODY = `{
  if (err instanceof Error) {
    return err.message;
  }
  return null;
}`;

/** `r.success` — a Zod `safeParse()` result boolean, not error handling. The
 *  old `.success` regex (and a structural `.success` member-access check)
 *  misclassify this as `go-style`; the honest predicate must not. */
const SUCCESS_FIELD_BODY = `{
  const r = EmbedArticleOutputSchema.safeParse(parsed);
  if (!r.success) {
    return null;
  }
  return r.data;
}`;

/** A body with no error handling at all — must be excluded (null) under both. */
const NO_ERROR_BODY = `{
  return db.query("SELECT * FROM users");
}`;

describe('detectErrorHandlingShape — structural, not a first-match regex over raw text', () => {
  it('detects a try/catch body (positive)', () => {
    expect(detectErrorHandlingShape(TRY_CATCH_BODY)).toBe('try-catch');
  });

  it('detects a .catch() promise body (positive)', () => {
    expect(detectErrorHandlingShape(PROMISE_CATCH_BODY)).toBe('promise-catch');
  });

  it('detects a bare `if (err)` body (positive)', () => {
    expect(detectErrorHandlingShape(IF_ERR_BODY)).toBe('if-err');
  });

  it('does NOT treat a string literal "try {" as try-catch (inverse near-miss)', () => {
    expect(detectErrorHandlingShape(STRING_LITERAL_BODY)).toBeNull();
  });

  it('does NOT collapse a multi-shape body to its first shape (inverse near-miss)', () => {
    expect(detectErrorHandlingShape(MULTI_SHAPE_BODY)).toBeNull();
  });

  it('does NOT treat `if (errorMessage)` as if-err — only err/error values count (inverse near-miss)', () => {
    expect(detectErrorHandlingShape(IF_ERROR_MESSAGE_BODY)).toBeNull();
  });

  it('does NOT treat `if (err instanceof Error)` as if-err — that is type narrowing (inverse near-miss)', () => {
    expect(detectErrorHandlingShape(IF_ERR_INSTANCEOF_BODY)).toBeNull();
  });

  it('does NOT treat `r.success` as go-style — that is a result boolean, not error handling (inverse near-miss)', () => {
    expect(detectErrorHandlingShape(SUCCESS_FIELD_BODY)).toBeNull();
  });

  it('returns null for a body with no error handling (near-miss)', () => {
    expect(detectErrorHandlingShape(NO_ERROR_BODY)).toBeNull();
  });
});
