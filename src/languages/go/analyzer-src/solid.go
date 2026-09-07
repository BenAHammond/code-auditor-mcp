package analyzer

import (
	"go/ast"
	"strings"
)

// SOLIDAnalyzer analyzes Go code for SOLID principle violations
type SOLIDAnalyzer struct {
	parser    *Parser
	functions []Function
	structs   []Struct
	interfaces []Interface
}

// NewSOLIDAnalyzer creates a new SOLID analyzer
func NewSOLIDAnalyzer(parser *Parser) *SOLIDAnalyzer {
	return &SOLIDAnalyzer{
		parser:     parser,
		functions:  parser.ExtractFunctions(),
		structs:    parser.ExtractStructs(),
		interfaces: parser.ExtractInterfaces(),
	}
}

// Analyze performs SOLID principle analysis
func (s *SOLIDAnalyzer) Analyze() []Violation {
	var violations []Violation

	// Analyze Single Responsibility Principle
	violations = append(violations, s.analyzeSRP()...)

	// Analyze switch/type-switch size
	violations = append(violations, s.analyzeSwitchSize()...)

	// Analyze Liskov Substitution Principle
	violations = append(violations, s.analyzeLSP()...)

	// Analyze Interface Segregation Principle
	violations = append(violations, s.analyzeISP()...)

	return violations
}

// analyzeSRP analyzes Single Responsibility Principle violations
func (s *SOLIDAnalyzer) analyzeSRP() []Violation {
	var violations []Violation

	// Check functions for too many responsibilities
	for _, function := range s.functions {
		responsibilities := s.countFunctionResponsibilities(function)
		if responsibilities > 3 {
			violations = append(violations, Violation{
				File:     function.File,
				Line:     function.StartLine,
				Severity: "warning",
				Message:  "Function has many parameters, returns, or high complexity",
				Details: map[string]interface{}{
					"function":        function.Name,
					"responsibilities": responsibilities,
					"principle":       "SRP",
				},
				Suggestion: "Consider breaking this function into smaller, more focused functions",
				Analyzer:   "solid",
				Category:   "single-responsibility",
			})
		}
	}

	// Check structs for too many responsibilities
	for _, structInfo := range s.structs {
		responsibilities := s.countStructResponsibilities(structInfo)
		if responsibilities > 5 {
			violations = append(violations, Violation{
				File:     structInfo.File,
				Line:     structInfo.StartLine,
				Severity: "warning",
				Message:  "Struct has many fields",
				Details: map[string]interface{}{
					"struct":          structInfo.Name,
					"responsibilities": responsibilities,
					"principle":       "SRP",
					"fieldCount":      len(structInfo.Fields),
				},
				Suggestion: "Consider splitting this struct into smaller, more cohesive structs",
				Analyzer:   "solid",
				Category:   "single-responsibility",
			})
		}
	}

	return violations
}

// analyzeSwitchSize analyzes switch/type-switch *size* (`switch-size`).
//
// Spec-49: the old `open-closed` category claimed to detect the Open/Closed
// Principle from a raw case count. Case count is a size reading, not an OCP
// reading — whether a switch is "closed to extension" depends on whether it
// dispatches over a stable enum vs an extensible type, which the syntax-only
// go/parser cannot resolve. The honest OCP computation is blocked (needs type
// resolution); what remains is the size signal under an honest name.
func (s *SOLIDAnalyzer) analyzeSwitchSize() []Violation {
	var violations []Violation

	// Check for large switch/type-switch statements (a size reading only).
	for filePath, file := range s.parser.files {
		ast.Inspect(file, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.SwitchStmt:
				caseCount := s.countSwitchCases(node)
				if caseCount > 5 {
					pos := s.parser.fileSet.Position(node.Pos())
					violations = append(violations, Violation{
						File:     filePath,
						Line:     pos.Line,
						Severity: "suggestion",
						Message:  "Switch statement has many case clauses",
						Details: map[string]interface{}{
							"caseCount": caseCount,
							"kind":      "switch",
						},
						Suggestion: "Consider consolidating related cases or a table-driven lookup if the switch grows unwieldy",
						Analyzer:   "solid",
						Category:   "switch-size",
					})
				}
			case *ast.TypeSwitchStmt:
				caseCount := s.countTypeSwitchCases(node)
				if caseCount > 5 {
					pos := s.parser.fileSet.Position(node.Pos())
					violations = append(violations, Violation{
						File:     filePath,
						Line:     pos.Line,
						Severity: "suggestion",
						Message:  "Type switch has many case clauses",
						Details: map[string]interface{}{
							"caseCount": caseCount,
							"kind":      "type-switch",
						},
						Suggestion: "Consider consolidating related cases; a type switch over a sealed set is maintainable, but an open set grows unwieldy",
						Analyzer:   "solid",
						Category:   "switch-size",
					})
				}
			}
			return true
		})
	}

	return violations
}

// analyzeLSP analyzes Liskov Substitution Principle violations.
//
// A method that calls panic() breaks substitutability: a caller holding the
// interface (or embedding) has no way to recover from a panic the way it can
// from an error return. The honest, directly-observable signal is "the method
// body contains a panic() call" — we walk the AST for exactly that. We do not
// (yet) resolve whether the method overrides a parent, so the message claims
// only the panic, never the override.
func (s *SOLIDAnalyzer) analyzeLSP() []Violation {
	var violations []Violation

	for filePath, file := range s.parser.files {
		ast.Inspect(file, func(n ast.Node) bool {
			funcDecl, ok := n.(*ast.FuncDecl)
			if !ok {
				return true
			}
			// LSP governs methods only — a free function has no supertype to
			// violate. Test functions are test entry points, not production API.
			if funcDecl.Recv == nil || funcDecl.Body == nil || isTestFunction(funcDecl.Name.Name) {
				return true
			}
			if !methodCallsPanic(funcDecl) {
				return true
			}
			pos := s.parser.fileSet.Position(funcDecl.Pos())
			violations = append(violations, Violation{
				File:     filePath,
				Line:     pos.Line,
				Severity: "warning",
				Message:  "Method calls panic()",
				Details: map[string]interface{}{
					"function":  funcDecl.Name.Name,
					"principle": "LSP",
				},
				Suggestion: "Return an error instead of panicking so the method stays substitutable",
				Analyzer:   "solid",
				Category:   "liskov-substitution",
			})
			return true
		})
	}

	return violations
}

// analyzeISP analyzes interface *size* (`interface-size`).
//
// Spec-49: the old `interface-segregation` category claimed to detect the
// Interface Segregation Principle ("clients forced to depend on methods they do
// not use") from a raw method count. Method count is a size reading, not a
// segregation reading. The honest ISP computation (client-usage sets — which
// callers use which disjoint subsets of an interface's methods) needs type
// resolution / a call graph, which the syntax-only go/parser has not, so that
// reading is blocked (see the ledger). What remains is the size signal under an
// honest name.
func (s *SOLIDAnalyzer) analyzeISP() []Violation {
	var violations []Violation

	for _, interfaceInfo := range s.interfaces {
		if len(interfaceInfo.Methods) > 5 {
			violations = append(violations, Violation{
				File:     interfaceInfo.File,
				Line:     interfaceInfo.StartLine,
				Severity: "warning",
				Message:  "Interface has many methods",
				Details: map[string]interface{}{
					"interface":   interfaceInfo.Name,
					"methodCount": len(interfaceInfo.Methods),
					"principle":   "ISP",
				},
				Suggestion: "Consider splitting this large interface into smaller, more focused interfaces",
				Analyzer:   "solid",
				Category:   "interface-size",
			})
		}
	}

	return violations
}

// Helper methods for analysis

func (s *SOLIDAnalyzer) countFunctionResponsibilities(function Function) int {
	responsibilities := 1

	// Count different types of operations
	if function.Complexity > 10 {
		responsibilities++
	}

	// Check for multiple return types (excluding error)
	returns := strings.Split(function.ReturnType, ",")
	if len(returns) > 2 {
		responsibilities++
	}

	// Check parameter count
	if len(function.Parameters) > 5 {
		responsibilities++
	}

	return responsibilities
}

func (s *SOLIDAnalyzer) countStructResponsibilities(structInfo Struct) int {
	responsibilities := 1

	// Base on field count
	fieldCount := len(structInfo.Fields)
	if fieldCount > 10 {
		responsibilities += 2
	} else if fieldCount > 5 {
		responsibilities++
	}

	// Check for mixed data types indicating different responsibilities
	hasStrings := false
	hasNumbers := false
	hasCollections := false

	for _, field := range structInfo.Fields {
		switch {
		case strings.Contains(field.Type, "string"):
			hasStrings = true
		case strings.Contains(field.Type, "int") || strings.Contains(field.Type, "float"):
			hasNumbers = true
		case strings.Contains(field.Type, "[]") || strings.Contains(field.Type, "map"):
			hasCollections = true
		}
	}

	mixedTypes := 0
	if hasStrings {
		mixedTypes++
	}
	if hasNumbers {
		mixedTypes++
	}
	if hasCollections {
		mixedTypes++
	}

	if mixedTypes > 2 {
		responsibilities++
	}

	return responsibilities
}

func (s *SOLIDAnalyzer) countSwitchCases(switchStmt *ast.SwitchStmt) int {
	caseCount := 0
	if switchStmt.Body != nil {
		for _, stmt := range switchStmt.Body.List {
			if _, ok := stmt.(*ast.CaseClause); ok {
				caseCount++
			}
		}
	}
	return caseCount
}

func (s *SOLIDAnalyzer) countTypeSwitchCases(typeSwitchStmt *ast.TypeSwitchStmt) int {
	caseCount := 0
	if typeSwitchStmt.Body != nil {
		for _, stmt := range typeSwitchStmt.Body.List {
			if _, ok := stmt.(*ast.CaseClause); ok {
				caseCount++
			}
		}
	}
	return caseCount
}

// methodCallsPanic reports whether a function body contains a direct panic()
// call. It matches the exact call shape — a call expression whose function is
// the identifier `panic` — so a helper that merely has "panic" in its name or
// a doc comment does not trip it (the near-miss the old name-substring check
// false-positived on).
func methodCallsPanic(funcDecl *ast.FuncDecl) bool {
	callsPanic := false
	ast.Inspect(funcDecl.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		ident, ok := call.Fun.(*ast.Ident)
		if ok && ident.Name == "panic" {
			callsPanic = true
			return false
		}
		return true
	})
	return callsPanic
}