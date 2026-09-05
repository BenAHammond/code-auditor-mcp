package analyzer

import (
	"go/ast"
	"go/token"
	"sort"
	"time"
)

// Analyzer is the main Go code analyzer
type Analyzer struct {
	options AnalysisOptions
	parser  *Parser
}

// NewAnalyzer creates a new Go analyzer
func NewAnalyzer(options AnalysisOptions) *Analyzer {
	parser := NewParser(options)
	return &Analyzer{
		options: options,
		parser:  parser,
	}
}

// Analyze performs comprehensive analysis of Go files
func (a *Analyzer) Analyze(files []string) (*AnalysisResult, error) {
	startTime := time.Now()

	// Exclude *_test.go files before parsing: test code is not production API.
	// Mirrors languages/testConventions.ts go.filePatterns.
	files = excludeTestFiles(files)

	// Parse all files
	if err := a.parser.ParseFiles(files); err != nil {
		return nil, err
	}

	result := &AnalysisResult{
		Violations:   []Violation{},
		IndexEntries: []IndexEntry{},
		Metrics: Metrics{
			FilesAnalyzed: int64(len(files)),
			ExecutionTime: 0, // Will be set at the end
		},
		Errors: []Error{},
	}

	// Run enabled analyzers
	a.runEnabledAnalyzers(result)

	// Generate index entries
	indexer := NewIndexer(a.parser)
	result.IndexEntries = indexer.GenerateIndexEntries()

	// Filter violations by severity
	result.Violations = a.filterViolationsBySeverity(result.Violations)

	// Calculate execution time
	result.Metrics.ExecutionTime = time.Since(startTime).Milliseconds()

	return result, nil
}

// runEnabledAnalyzers runs each enabled analyzer and appends its violations to
// the result. Shared by Analyze and AnalyzeContent to avoid duplicated dispatch.
func (a *Analyzer) runEnabledAnalyzers(result *AnalysisResult) {
	for _, analyzerName := range a.options.Analyzers {
		switch analyzerName {
		case "solid":
			result.Violations = append(result.Violations, a.runSOLIDAnalysis()...)
		case "imports":
			result.Violations = append(result.Violations, a.runImportAnalysis()...)
		case "errors":
			result.Violations = append(result.Violations, a.runErrorAnalysis()...)
		case "goroutines":
			result.Violations = append(result.Violations, a.runGoroutineAnalysis()...)
		case "channels":
			result.Violations = append(result.Violations, a.runChannelAnalysis()...)
		}
	}
}

// AnalyzeContent performs analysis of Go content from a string
func (a *Analyzer) AnalyzeContent(filePath, content string) (*AnalysisResult, error) {
	startTime := time.Now()

	// A *_test.go file is test code, not production API — exempt it the same
	// way the multi-file path does (languages/testConventions.ts go.filePatterns).
	if isTestFile(filePath) {
		return &AnalysisResult{
			Violations:   []Violation{},
			IndexEntries: []IndexEntry{},
			Metrics: Metrics{
				FilesAnalyzed: 0,
				ExecutionTime: 0,
			},
			Errors: []Error{},
		}, nil
	}

	// Parse content instead of file
	if err := a.parser.ParseContent(filePath, content); err != nil {
		return nil, err
	}

	result := &AnalysisResult{
		Violations:   []Violation{},
		IndexEntries: []IndexEntry{},
		Metrics: Metrics{
			FilesAnalyzed: 1,
			ExecutionTime: 0, // Will be set at the end
		},
		Errors: []Error{},
	}

	// Run enabled analyzers
	a.runEnabledAnalyzers(result)

	// Generate index entries
	indexer := NewIndexer(a.parser)
	result.IndexEntries = indexer.GenerateIndexEntries()

	// Filter violations by severity
	result.Violations = a.filterViolationsBySeverity(result.Violations)

	// Calculate execution time
	result.Metrics.ExecutionTime = time.Since(startTime).Milliseconds()

	return result, nil
}

// runSOLIDAnalysis runs SOLID principle analysis
func (a *Analyzer) runSOLIDAnalysis() []Violation {
	solidAnalyzer := NewSOLIDAnalyzer(a.parser)
	return solidAnalyzer.Analyze()
}

// runImportAnalysis analyzes import usage and organization
func (a *Analyzer) runImportAnalysis() []Violation {
	var violations []Violation

	for filePath, file := range a.parser.files {
		// Check for unused imports
		if len(file.Imports) > 10 {
			violations = append(violations, Violation{
				File:     filePath,
				Line:     1,
				Severity: "suggestion",
				Message:  "File has many imports - consider organizing or reducing import count",
				Details: map[string]interface{}{
					"importCount": len(file.Imports),
				},
				Suggestion: "Group related imports and consider if all are necessary",
				Analyzer:   "imports",
				Category:   "import-organization",
			})
		}

		// Check for dot imports (considered bad practice)
		for _, importSpec := range file.Imports {
			if importSpec.Name != nil && importSpec.Name.Name == "." {
				pos := a.parser.fileSet.Position(importSpec.Pos())
				violations = append(violations, Violation{
					File:     filePath,
					Line:     pos.Line,
					Severity: "warning",
					Message:  "Dot import detected - can lead to namespace pollution",
					Details: map[string]interface{}{
						"import": importSpec.Path.Value,
					},
					Suggestion: "Use explicit import names instead of dot imports",
					Analyzer:   "imports",
					Category:   "import-style",
				})
			}
		}
	}

	return violations
}

// runErrorAnalysis analyzes error handling patterns.
//
// It performs an errcheck-style walk: an error identifier assigned from a call
// result that is never compared, returned, passed to another call, or
// explicitly ignored is a dropped error — a likely bug regardless of what the
// enclosing function is named. This replaces the old name-substring proxy
// ("handle"/"check"/"validate"/"verify") that fired on any function whose name
// merely contained one of those words.
func (a *Analyzer) runErrorAnalysis() []Violation {
	var violations []Violation

	for filePath, file := range a.parser.files {
		ast.Inspect(file, func(n ast.Node) bool {
			funcDecl, ok := n.(*ast.FuncDecl)
			if !ok || funcDecl.Body == nil || isTestFunction(funcDecl.Name.Name) {
				return true
			}
			if !a.functionDropsError(funcDecl) {
				return true
			}
			pos := a.parser.fileSet.Position(funcDecl.Pos())
			violations = append(violations, Violation{
				File:     filePath,
				Line:     pos.Line,
				Severity: "suggestion",
				Message:  "Function assigns an error that is never checked, returned, or propagated",
				Details: map[string]interface{}{
					"function": funcDecl.Name.Name,
				},
				Suggestion: "Check the error, return it, or explicitly ignore it with '_ = err'",
				Analyzer:   "errors",
				Category:   "error-handling",
			})
			return true
		})
	}

	return violations
}

// runGoroutineAnalysis analyzes goroutine usage for potential issues.
//
// It walks the AST for a `go` statement and reports the function when a
// goroutine is launched with no synchronization mechanism — sync primitives
// (Add/Done/Wait/Lock/Unlock/RLock/RUnlock) or a channel send/receive —
// anywhere in the same function. This replaces the old name-substring proxy
// ("go"/"async"/"concurrent") that fired on any function whose name merely
// contained those substrings.
func (a *Analyzer) runGoroutineAnalysis() []Violation {
	var violations []Violation

	for filePath, file := range a.parser.files {
		ast.Inspect(file, func(n ast.Node) bool {
			funcDecl, ok := n.(*ast.FuncDecl)
			if !ok || funcDecl.Body == nil || isTestFunction(funcDecl.Name.Name) {
				return true
			}
			hasGo, hasSync := a.analyzeConcurrency(funcDecl)
			if !hasGo || hasSync {
				return true
			}
			pos := a.parser.fileSet.Position(funcDecl.Pos())
			violations = append(violations, Violation{
				File:     filePath,
				Line:     pos.Line,
				Severity: "warning",
				Message:  "Function launches a goroutine without synchronization",
				Details: map[string]interface{}{
					"function": funcDecl.Name.Name,
				},
				Suggestion: "Use sync.WaitGroup or a channel to synchronize the goroutine",
				Analyzer:   "goroutines",
				Category:   "concurrency",
			})
			return true
		})
	}

	return violations
}

// runChannelAnalysis analyzes channel usage for potential deadlocks
func (a *Analyzer) runChannelAnalysis() []Violation {
	var violations []Violation

	// This is a simplified implementation
	// A full implementation would analyze the AST for channel operations
	functions := a.parser.ExtractFunctions()
	for _, function := range functions {
		if containsChannel(function.Signature) && function.Complexity > 3 {
			violations = append(violations, Violation{
				File:     function.File,
				Line:     function.StartLine,
				Severity: "suggestion",
				Message:  "Complex function uses channels - review for proper synchronization",
				Details: map[string]interface{}{
					"function":   function.Name,
					"complexity": function.Complexity,
				},
				Suggestion: "Ensure proper channel synchronization to avoid deadlocks",
				Analyzer:   "channels",
				Category:   "concurrency",
			})
		}
	}

	return violations
}

// filterViolationsBySeverity filters violations based on minimum severity
func (a *Analyzer) filterViolationsBySeverity(violations []Violation) []Violation {
	if a.options.MinSeverity == "" {
		return violations
	}

	severityOrder := map[string]int{
		"suggestion": 1,
		"warning":    2,
		"critical":   3,
	}

	minLevel := severityOrder[a.options.MinSeverity]
	if minLevel == 0 {
		return violations
	}

	// A non-nil empty slice so "no violations" serializes to [] not null — a
	// nil slice marshals to JSON null, which the TypeScript caller reads as a
	// crash rather than an empty result (the same silent-empty class this whole
	// subprocess boundary is built to remove).
	filtered := make([]Violation, 0, len(violations))
	for _, violation := range violations {
		if severityOrder[violation.Severity] >= minLevel {
			filtered = append(filtered, violation)
		}
	}

	return filtered
}

// Helper functions for analysis

// syncMethodNames are the selector names on sync primitives that signal a
// function is synchronizing its goroutines (sync.WaitGroup and sync.Mutex /
// sync.RWMutex method sets).
var syncMethodNames = map[string]bool{
	"Add":     true,
	"Done":    true,
	"Wait":    true,
	"Lock":    true,
	"Unlock":  true,
	"RLock":   true,
	"RUnlock": true,
}

// functionDropsError reports whether a function body assigns an error from a
// call result and never checks, returns, passes, or explicitly ignores that
// same error on the same path. It collects the source positions of every `err`
// binding-from-call and every "checking" use, then flags an assignment whose
// next use of `err` is a reassignment (or the end of the function) rather than
// a check. Position ordering (not identifier pointer identity) is what links a
// use to its binding, since each `err` occurrence is a distinct AST node.
func (a *Analyzer) functionDropsError(funcDecl *ast.FuncDecl) bool {
	var assignPositions []token.Pos
	var checkPositions []token.Pos

	ast.Inspect(funcDecl.Body, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.AssignStmt:
			if assignHasCallRHS(node) {
				for _, lhs := range node.Lhs {
					if ident, ok := lhs.(*ast.Ident); ok && ident.Name == "err" {
						assignPositions = append(assignPositions, ident.Pos())
					}
				}
			}
			// Explicit ignore: `_ = err`
			if len(node.Lhs) == 1 && len(node.Rhs) == 1 && isBlankIdent(node.Lhs[0]) {
				if ident, ok := node.Rhs[0].(*ast.Ident); ok && ident.Name == "err" {
					checkPositions = append(checkPositions, ident.Pos())
				}
			}
		case *ast.BinaryExpr:
			// `err != nil` / `err == nil`
			if node.Op == token.NEQ || node.Op == token.EQL {
				for _, side := range []ast.Expr{node.X, node.Y} {
					if ident, ok := side.(*ast.Ident); ok && ident.Name == "err" {
						checkPositions = append(checkPositions, ident.Pos())
					}
				}
			}
		case *ast.ReturnStmt:
			for _, res := range node.Results {
				if ident, ok := res.(*ast.Ident); ok && ident.Name == "err" {
					checkPositions = append(checkPositions, ident.Pos())
				}
			}
		case *ast.CallExpr:
			for _, arg := range node.Args {
				if ident, ok := arg.(*ast.Ident); ok && ident.Name == "err" {
					checkPositions = append(checkPositions, ident.Pos())
				}
			}
		}
		return true
	})

	sort.Slice(assignPositions, func(i, j int) bool { return assignPositions[i] < assignPositions[j] })
	sort.Slice(checkPositions, func(i, j int) bool { return checkPositions[i] < checkPositions[j] })

	// An assigned `err` is handled iff a check falls strictly after it and
	// before the next assignment (or the end of the function).
	for i, assign := range assignPositions {
		var upper token.Pos
		if i+1 < len(assignPositions) {
			upper = assignPositions[i+1]
		} else {
			upper = token.Pos(1<<62 - 1) // function end (effectively +inf)
		}
		handled := false
		for _, check := range checkPositions {
			if check > assign && check < upper {
				handled = true
				break
			}
		}
		if !handled {
			return true
		}
	}
	return false
}

// assignHasCallRHS reports whether any right-hand side of an assignment is a
// call expression (the `x, err := f()` shape that produces an error).
func assignHasCallRHS(stmt *ast.AssignStmt) bool {
	for _, rhs := range stmt.Rhs {
		if _, ok := rhs.(*ast.CallExpr); ok {
			return true
		}
	}
	return false
}

// isBlankIdent reports whether an expression is the blank identifier `_`.
func isBlankIdent(expr ast.Expr) bool {
	ident, ok := expr.(*ast.Ident)
	return ok && ident.Name == "_"
}

// analyzeConcurrency reports whether a function body launches a goroutine
// (hasGo) and whether it contains any synchronization signal (hasSync): a
// sync.Add/Done/Wait/Lock/Unlock/RLock/RUnlock call or a channel send/receive.
func (a *Analyzer) analyzeConcurrency(funcDecl *ast.FuncDecl) (hasGo, hasSync bool) {
	ast.Inspect(funcDecl.Body, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.GoStmt:
			hasGo = true
		case *ast.SendStmt:
			hasSync = true
		case *ast.UnaryExpr:
			if node.Op == token.ARROW {
				hasSync = true
			}
		case *ast.SelectorExpr:
			if syncMethodNames[node.Sel.Name] {
				hasSync = true
			}
		}
		return true
	})
	return hasGo, hasSync
}

func containsChannel(signature string) bool {
	return containsSubstring(signature, "chan")
}

func containsSubstring(str, substr string) bool {
	if len(str) < len(substr) {
		return false
	}
	for i := 0; i <= len(str)-len(substr); i++ {
		if str[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// excludeTestFiles removes *_test.go files from a file list. Test files are
// compiled only by `go test`, never as production API — they are exempt from
// analysis and indexing the same way the TypeScript pipeline excludes test
// files at discovery (see testconventions.go).
func excludeTestFiles(files []string) []string {
	out := make([]string, 0, len(files))
	for _, f := range files {
		if !isTestFile(f) {
			out = append(out, f)
		}
	}
	return out
}