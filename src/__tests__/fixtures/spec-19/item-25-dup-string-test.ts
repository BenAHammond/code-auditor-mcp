/**
 * Spec-19 item 25 — duplicate-string-literal useless positive.
 * Test fixture name string "test-user-001" repeated.
 * Verdict: USELESS — test fixture identifiers repeated by design.
 * duplicate-string-literal is retired (checkStrings: false). Produces 0 violations.
 *
 * String "test-user-001" appears 4 times, each with length > 10.
 * Would trigger duplicate-string-literal >2 occurrences if the rule were active.
 */

const USER_A = "test-user-001";
const USER_B = "test-user-001";
const USER_C = "test-user-001";
const USER_D = "test-user-001";

export function createTestUsers(): string[] {
  return [USER_A, USER_B, USER_C, USER_D];
}
