package analyzer

import "strings"

// Go test conventions — mirrors languages/testConventions.ts.
//
// `go test` compiles only `*_test.go` files; within them the `testing` package
// recognizes Test/Benchmark/Example/Fuzz-prefixed functions as entry points.
// Test code is not production API: it is exempt from analysis and indexing the
// same way the TypeScript pipeline exempts `.test.`/`.spec.` files. One
// per-language convention, not a hardcoded TS/JS list.

// isTestFile reports whether filePath is a Go test file (`*_test.go`).
func isTestFile(filePath string) bool {
	return strings.HasSuffix(filePath, "_test.go")
}

// isTestFunction reports whether name is a Go test function
// (Test*/Benchmark*/Example*/Fuzz*).
func isTestFunction(name string) bool {
	return strings.HasPrefix(name, "Test") ||
		strings.HasPrefix(name, "Benchmark") ||
		strings.HasPrefix(name, "Example") ||
		strings.HasPrefix(name, "Fuzz")
}
