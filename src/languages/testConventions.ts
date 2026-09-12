/**
 * Per-language test-file and test-function conventions.
 *
 * `documentation.exemptPatterns` was a hardcoded TS/JS list of path substrings
 * (`.test.`, `.spec.`, `__tests__`, `/tests?/`) that only described one
 * language family. When the Go adapter shipped, none of those patterns matched
 * Go's actual test convention — `*_test.go` files and `Test*`/`Benchmark*`/
 * `Example*`/`Fuzz*` functions — so the documentation analyzer re-flagged every
 * Go test function as "exported function lacks documentation" (618 of 762
 * findings on a real Go corpus).
 *
 * The fix is not four more strings appended to the TS/JS list; it is a
 * per-language table of test conventions that travels with the language, so a
 * new language (Python's `test_*.py` / `test_*`, Rust's `#[cfg(test)]`) brings
 * its own conventions instead of waiting for someone to notice the gap after a
 * corpus run. A language absent from this table simply has no test convention
 * and is not exempted — the failure is a visible empty result, not a silent
 * wrong one.
 */

export interface TestConvention {
  /** Regexes matched against a file path — a match marks the file a test file. */
  filePatterns: RegExp[];
  /** Regexes matched against a function name — a match marks the function a test function. */
  functionPatterns: RegExp[];
}

const TEST_CONVENTIONS: Record<string, TestConvention> = {
  // typescript/javascript test files are still served by the user-configurable
  // `exemptPatterns` list (`.test.`, `.spec.`, `__tests__`, …) for backward
  // compatibility; they are not duplicated here. The table is the home for
  // conventions that a generic path-regex list cannot express per language.
  typescript: { filePatterns: [], functionPatterns: [] },
  javascript: { filePatterns: [], functionPatterns: [] },
  go: {
    // `go test` compiles only `*_test.go`; exported Test/Benchmark/Example/Fuzz
    // funcs are the testing package's entry points, never public API.
    filePatterns: [/_test\.go$/i],
    functionPatterns: [/^Test/, /^Benchmark/, /^Example/, /^Fuzz/],
  },
  // python: { filePatterns: [/^test_.*\.py$/i, /.*_test\.py$/i], functionPatterns: [/^test_/] },
  // rust:   { filePatterns: [], functionPatterns: [] }, // #[cfg(test)] is module-scoped, not name-scoped
};

/**
 * True when `filePath` is a test file under `language`'s native convention.
 * Keys off the canonical adapter name (`go`, `typescript`, `javascript`).
 */
export function isTestFile(language: string, filePath: string): boolean {
  const convention = TEST_CONVENTIONS[language];
  return !!convention && convention.filePatterns.some((re) => re.test(filePath));
}

/**
 * True when `name` is a test function under `language`'s native convention.
 */
export function isTestFunction(language: string, name: string): boolean {
  const convention = TEST_CONVENTIONS[language];
  return !!convention && convention.functionPatterns.some((re) => re.test(name));
}

/**
 * Language-agnostic test/spec path predicate for RULE-LEVEL test exclusion
 * (Spec 55 R3). Unlike the per-language `isTestFile` above (driven by
 * `TEST_CONVENTIONS`), this is a single shared path heuristic for the generic
 * TS/JS test-file shapes — `*.test.*` / `*.spec.*` filenames and `test/` /
 * `tests/` / `__tests__/` directory segments, plus Go's `*_test.go`. It is
 * used by rules that must never fire on test files at all (`loop-query`,
 * `unfiltered-query`, `too-many-queries`): the shape is a file-scope signal,
 * not a per-language convention, so it is one predicate rather than a table
 * entry. Segment anchoring (`/test/`) avoids matching `contest/`, `latest/`,
 * etc., which a bare `/test\//` substring would.
 */
export function isTestOrSpecPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  return (
    /\.(test|spec)\.[^/]+$/.test(p) ||
    /(^|\/)(test|tests|__tests__)(\/|$)/.test(p) ||
    /_test\.go$/.test(p)
  );
}
