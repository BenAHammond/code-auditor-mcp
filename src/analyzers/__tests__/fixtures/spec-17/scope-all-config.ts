/**
 * Spec-17 R8 Fixture 19: scope-all-config
 * Report section: R1.4 — scope: "all" restores coverage minus callbacks
 *
 * With scope: "all", anonymous callbacks are still skipped (R1.1),
 * but NAMED internal functions (not exported, not methods) ARE flagged.
 *
 * Assert: internalFunction → finding, callback arrows → no findings.
 */

// Callback — always skipped regardless of scope (R1.1)
const items = [1, 2, 3].map((x) => x * 2);

// Named internal function — should be flagged under scope: "all"
function internalFunction(a: number, b: number): number {
  const product = a * b;
  const sum = a + b;
  if (product > sum) {
    return product;
  }
  return sum;
}

// Another named internal — should be flagged
function helper(name: string, age: number): string {
  const greeting = `Hello, ${name}`;
  const years = age > 1 ? `${age} years` : "1 year";
  return `${greeting}. Age: ${years}.`;
}

// Named function exported — always flagged (was already in scope)
export function getFormattedAge(age: number): string {
  return helper("User", age);
}
