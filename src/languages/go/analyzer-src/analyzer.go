package analyzer

import (
	"strings"
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
	for _, analyzerName := range a.options.Analyzers {
		switch analyzerName {
		case "solid":
			violations := a.runSOLIDAnalysis()
			result.Violations = append(result.Violations, violations...)
		case "imports":
			violations := a.runImportAnalysis()
			result.Violations = append(result.Violations, violations...)
		case "errors":
			violations := a.runErrorAnalysis()
			result.Violations = append(result.Violations, violations...)
		case "goroutines":
			violations := a.runGoroutineAnalysis()
			result.Violations = append(result.Violations, violations...)
		case "channels":
			violations := a.runChannelAnalysis()
			result.Violations = append(result.Violations, violations...)
		}
	}

	// Generate index entries
	indexer := NewIndexer(a.parser)
	result.IndexEntries = indexer.GenerateIndexEntries()

	// Filter violations by severity
	result.Violations = a.filterViolationsBySeverity(result.Violations)

	// Calculate execution time
	result.Metrics.ExecutionTime = time.Since(startTime).Milliseconds()

	return result, nil
}

// AnalyzeContent performs analysis of Go content from a string
func (a *Analyzer) AnalyzeContent(filePath, content string) (*AnalysisResult, error) {
	startTime := time.Now()

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
	for _, analyzerName := range a.options.Analyzers {
		switch analyzerName {
		case "solid":
			violations := a.runSOLIDAnalysis()
			result.Violations = append(result.Violations, violations...)
		case "imports":
			violations := a.runImportAnalysis()
			result.Violations = append(result.Violations, violations...)
		case "errors":
			violations := a.runErrorAnalysis()
			result.Violations = append(result.Violations, violations...)
		case "goroutines":
			violations := a.runGoroutineAnalysis()
			result.Violations = append(result.Violations, violations...)
		case "channels":
			violations := a.runChannelAnalysis()
			result.Violations = append(result.Violations, violations...)
		}
	}

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
				Message:  "File has many imports - consider organizing or reducing dependencies",
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

// runErrorAnalysis analyzes error handling patterns
func (a *Analyzer) runErrorAnalysis() []Violation {
	var violations []Violation

	functions := a.parser.ExtractFunctions()
	for _, function := range functions {
		// Check if function returns error but doesn't handle errors from calls
		if hasErrorReturn(function) {
			// This is a simplified check - a full implementation would analyze the AST
			// to check for proper error handling
			if function.Complexity > 5 && !containsErrorHandling(function.Name) {
				violations = append(violations, Violation{
					File:     function.File,
					Line:     function.StartLine,
					Severity: "suggestion",
					Message:  "Function returns error but may not handle all internal errors properly",
					Details: map[string]interface{}{
						"function": function.Name,
					},
					Suggestion: "Ensure all error-returning calls are properly handled",
					Analyzer:   "errors",
					Category:   "error-handling",
				})
			}
		}
	}

	return violations
}

// runGoroutineAnalysis analyzes goroutine usage for potential issues
func (a *Analyzer) runGoroutineAnalysis() []Violation {
	var violations []Violation

	// This is a simplified implementation
	// A full implementation would analyze the AST for goroutine patterns
	functions := a.parser.ExtractFunctions()
	for _, function := range functions {
		if containsGoroutine(function.Name) && !containsWaitGroup(function.Name) {
			violations = append(violations, Violation{
				File:     function.File,
				Line:     function.StartLine,
				Severity: "warning",
				Message:  "Function uses goroutines but may not properly synchronize",
				Details: map[string]interface{}{
					"function": function.Name,
				},
				Suggestion: "Consider using sync.WaitGroup or channels for goroutine synchronization",
				Analyzer:   "goroutines",
				Category:   "concurrency",
			})
		}
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
				Message:  "Complex function uses channels - review for potential deadlocks",
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

	var filtered []Violation
	for _, violation := range violations {
		if severityOrder[violation.Severity] >= minLevel {
			filtered = append(filtered, violation)
		}
	}

	return filtered
}

// Helper functions for simplified analysis

func hasErrorReturn(function Function) bool {
	return function.ReturnType != "" && 
		   (function.ReturnType == "error" || 
		    func() bool {
		    	parts := splitReturnTypes(function.ReturnType)
		    	for _, part := range parts {
		    		if part == "error" {
		    			return true
		    		}
		    	}
		    	return false
		    }())
}

func containsErrorHandling(functionName string) bool {
	// Simplified check based on naming patterns
	errorPatterns := []string{"handle", "check", "validate", "verify"}
	for _, pattern := range errorPatterns {
		if containsSubstring(functionName, pattern) {
			return true
		}
	}
	return false
}

func containsGoroutine(functionName string) bool {
	// Simplified check based on naming patterns
	return containsSubstring(functionName, "go") || 
		   containsSubstring(functionName, "async") ||
		   containsSubstring(functionName, "concurrent")
}

func containsWaitGroup(functionName string) bool {
	// Simplified check based on naming patterns
	return containsSubstring(functionName, "wait") ||
		   containsSubstring(functionName, "sync")
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

func splitReturnTypes(returnType string) []string {
	// Simple split by comma - in practice would need proper parsing
	var parts []string
	current := ""
	
	for _, char := range returnType {
		if char == ',' {
			if current != "" {
				parts = append(parts, strings.TrimSpace(current))
				current = ""
			}
		} else {
			current += string(char)
		}
	}
	
	if current != "" {
		parts = append(parts, strings.TrimSpace(current))
	}
	
	return parts
}