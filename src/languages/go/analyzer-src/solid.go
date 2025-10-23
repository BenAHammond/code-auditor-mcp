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

	// Analyze Open/Closed Principle
	violations = append(violations, s.analyzeOCP()...)

	// Analyze Liskov Substitution Principle
	violations = append(violations, s.analyzeLSP()...)

	// Analyze Interface Segregation Principle
	violations = append(violations, s.analyzeISP()...)

	// Analyze Dependency Inversion Principle
	violations = append(violations, s.analyzeDIP()...)

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
				Message:  "Function has too many responsibilities",
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
				Message:  "Struct has too many responsibilities",
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

// analyzeOCP analyzes Open/Closed Principle violations
func (s *SOLIDAnalyzer) analyzeOCP() []Violation {
	var violations []Violation

	// Check for large switch/case statements that could benefit from polymorphism
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
						Message:  "Large switch statement detected - consider using polymorphism",
						Details: map[string]interface{}{
							"caseCount": caseCount,
							"principle": "OCP",
						},
						Suggestion: "Consider using interfaces and polymorphism instead of large switch statements",
						Analyzer:   "solid",
						Category:   "open-closed",
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
						Message:  "Large type switch detected - consider using interfaces",
						Details: map[string]interface{}{
							"caseCount": caseCount,
							"principle": "OCP",
						},
						Suggestion: "Consider using interfaces with method dispatch instead of type switches",
						Analyzer:   "solid",
						Category:   "open-closed",
					})
				}
			}
			return true
		})
	}

	return violations
}

// analyzeLSP analyzes Liskov Substitution Principle violations
func (s *SOLIDAnalyzer) analyzeLSP() []Violation {
	var violations []Violation

	// Check for methods that panic or return errors in ways that violate LSP
	for _, function := range s.functions {
		if s.functionThrowsUnexpectedPanic(function) {
			violations = append(violations, Violation{
				File:     function.File,
				Line:     function.StartLine,
				Severity: "warning",
				Message:  "Method may violate Liskov Substitution Principle by panicking",
				Details: map[string]interface{}{
					"function":  function.Name,
					"principle": "LSP",
				},
				Suggestion: "Consider returning an error instead of panicking to maintain substitutability",
				Analyzer:   "solid",
				Category:   "liskov-substitution",
			})
		}
	}

	return violations
}

// analyzeISP analyzes Interface Segregation Principle violations
func (s *SOLIDAnalyzer) analyzeISP() []Violation {
	var violations []Violation

	// Check for fat interfaces
	for _, interfaceInfo := range s.interfaces {
		if len(interfaceInfo.Methods) > 5 {
			violations = append(violations, Violation{
				File:     interfaceInfo.File,
				Line:     interfaceInfo.StartLine,
				Severity: "warning",
				Message:  "Interface has too many methods",
				Details: map[string]interface{}{
					"interface":   interfaceInfo.Name,
					"methodCount": len(interfaceInfo.Methods),
					"principle":   "ISP",
				},
				Suggestion: "Consider splitting this interface into smaller, more focused interfaces",
				Analyzer:   "solid",
				Category:   "interface-segregation",
			})
		}
	}

	return violations
}

// analyzeDIP analyzes Dependency Inversion Principle violations
func (s *SOLIDAnalyzer) analyzeDIP() []Violation {
	var violations []Violation

	// Check for direct dependencies on concrete types instead of interfaces
	for _, structInfo := range s.structs {
		concreteDeps := s.countConcreteDependencies(structInfo)
		if concreteDeps > 3 {
			violations = append(violations, Violation{
				File:     structInfo.File,
				Line:     structInfo.StartLine,
				Severity: "suggestion",
				Message:  "Struct has many concrete dependencies",
				Details: map[string]interface{}{
					"struct":             structInfo.Name,
					"concreteDependencies": concreteDeps,
					"principle":          "DIP",
				},
				Suggestion: "Consider depending on interfaces instead of concrete types",
				Analyzer:   "solid",
				Category:   "dependency-inversion",
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

func (s *SOLIDAnalyzer) functionThrowsUnexpectedPanic(function Function) bool {
	// This is a simplified check - in a real implementation,
	// we would analyze the AST for panic() calls
	return strings.Contains(strings.ToLower(function.Name), "panic") ||
		strings.Contains(strings.ToLower(function.Purpose), "panic")
}

func (s *SOLIDAnalyzer) countConcreteDependencies(structInfo Struct) int {
	concreteDeps := 0

	for _, field := range structInfo.Fields {
		// Check if field type looks like a concrete type (not interface)
		if !strings.Contains(field.Type, "interface") &&
			!strings.HasPrefix(field.Type, "*") && // Pointers might be interfaces
			!s.isBuiltinType(field.Type) {
			concreteDeps++
		}
	}

	return concreteDeps
}

func (s *SOLIDAnalyzer) isBuiltinType(typeName string) bool {
	builtinTypes := []string{
		"bool", "string", "int", "int8", "int16", "int32", "int64",
		"uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
		"byte", "rune", "float32", "float64", "complex64", "complex128",
	}

	for _, builtin := range builtinTypes {
		if typeName == builtin {
			return true
		}
	}

	return false
}