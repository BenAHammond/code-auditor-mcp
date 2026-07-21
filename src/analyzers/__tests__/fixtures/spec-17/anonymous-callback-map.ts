/**
 * Spec-17 R8 Fixture 1: anonymous-callback-map
 * Report section: R1.1 — Skip anonymous/inline callables
 *
 * .map() callback arrows should produce ZERO documentation findings.
 */

const users = [
  { id: 1, name: "Alice" },
  { id: 2, name: "Bob" },
  { id: 3, name: "Charlie" },
];

// These are anonymous callbacks — not export-level API surface
const result = users.map((r) => ({
  slug: r.name.toLowerCase(),
  displayName: r.name.toUpperCase(),
  score: r.id * 10,
}));

const filtered = users.filter((u) => u.id > 1);

const doubled = users.reduce((acc, u) => acc + u.id * 2, 0);
