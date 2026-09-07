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

	// Analyze function/struct size (was the single-responsibility proxy)
	violations = append(violations, s.analyzeFunctionSize()...)
	violations = append(violations, s.analyzeStructSize()...)

	// Analyze switch/type-switch size
	violations = append(violations, s.analyzeSwitchSize()...)

	// Analyze Liskov Substitution Principle
	violations = append(violations, s.analyzeLSP()...)

	// Analyze Interface Segregation Principle
	violations = append(violations, s.analyzeISP()...)

	return violations
}

// analyzeFunctionSize analyzes function *size* (`function-size`).
//
// Spec-49: the old `single-responsibility` category claimed the Single
// Responsibility Principle from a composite of three size signals — complexity,
// return count, and parameter count. "Responsibility" is semantic; the
// syntax-only go/parser has no cohesion analysis, so the SRP reading is blocked
// (see the ledger). What remains is the size signal under an honest name: a
// function with high complexity AND multiple returns AND many parameters is
// large in every dimension.
func (s *SOLIDAnalyzer) analyzeFunctionSize() []Violation {
	var violations []Violation

	for _, function := range s.functions {
		returns := strings.Split(function.ReturnType, ",")
		complex := function.Complexity > 10
		multiReturn := len(returns) > 2
		manyParams := len(function.Parameters) > 5
		if complex && multiReturn && manyParams {
			violations = append(violations, Violation{
				File:     function.File,
				Line:     function.StartLine,
				Severity: "warning",
				Message:  "Function has many parameters, multiple returns, and high complexity",
				Details: map[string]interface{}{
					"function":   function.Name,
					"complexity": function.Complexity,
					"parameters": len(function.Parameters),
					"returns":    len(returns),
				},
				Suggestion: "Consider breaking this function into smaller, more focused functions",
				Analyzer:   "solid",
				Category:   "function-size",
			})
		}
	}

	return violations
}

// analyzeStructSize analyzes struct *size* (`struct-size`).
//
// Spec-49: the old `single-responsibility` struct variant claimed SRP from a
// composite of field count and a `mixedTypes` substring heuristic. Two defects:
// the composite score could never exceed 4 (the fire threshold was 5), so the
// rule was dead code; and `strings.Contains(field.Type, "int")` false-matched
// `*Point` (a pointer whose type name merely contains "int"). The SRP reading is
// blocked; the honest size reading is a direct field count.
func (s *SOLIDAnalyzer) analyzeStructSize() []Violation {
	var violations []Violation

	for _, structInfo := range s.structs {
		if len(structInfo.Fields) > 10 {
			violations = append(violations, Violation{
				File:     structInfo.File,
				Line:     structInfo.StartLine,
				Severity: "warning",
				Message:  "Struct has many fields",
				Details: map[string]interface{}{
					"struct":     structInfo.Name,
					"fieldCount": len(structInfo.Fields),
				},
				Suggestion: "Consider splitting this struct into smaller, more focused structs",
				Analyzer:   "solid",
				Category:   "struct-size",
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