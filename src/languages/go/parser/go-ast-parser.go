package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/ioutil"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// SourceLocation represents a position in source code
type SourceLocation struct {
	Start Position `json:"start"`
	End   Position `json:"end"`
}

// Position represents a line/column position
type Position struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

// FunctionInfo represents a parsed Go function
type FunctionInfo struct {
	Name       string         `json:"name"`
	Location   SourceLocation `json:"location"`
	Parameters []ParameterInfo `json:"parameters"`
	ReturnType string         `json:"returnType"`
	IsAsync    bool           `json:"isAsync"`
	IsExported bool           `json:"isExported"`
	IsMethod   bool           `json:"isMethod"`
	ClassName  string         `json:"className,omitempty"`
	Receiver   *ParameterInfo `json:"receiver,omitempty"`
	JSDoc      string         `json:"jsDoc,omitempty"`
}

// ParameterInfo represents a function parameter
type ParameterInfo struct {
	Name         string `json:"name"`
	Type         string `json:"type"`
	IsOptional   bool   `json:"isOptional"`
	DefaultValue string `json:"defaultValue,omitempty"`
}

// InterfaceInfo represents a parsed Go interface
type InterfaceInfo struct {
	Name       string               `json:"name"`
	Location   SourceLocation       `json:"location"`
	Members    []InterfaceMember    `json:"members"`
	Extends    []string             `json:"extends"`
	IsExported bool                 `json:"isExported"`
}

// InterfaceMember represents a method in an interface
type InterfaceMember struct {
	Name     string         `json:"name"`
	Type     string         `json:"type"`
	Location SourceLocation `json:"location"`
}

// StructInfo represents a parsed Go struct
type StructInfo struct {
	Name       string           `json:"name"`
	Location   SourceLocation   `json:"location"`
	Methods    []FunctionInfo   `json:"methods"`
	Properties []PropertyInfo   `json:"properties"`
	Extends    string           `json:"extends,omitempty"`
	Implements []string         `json:"implements"`
	IsAbstract bool             `json:"isAbstract"`
	IsExported bool             `json:"isExported"`
	JSDoc      string           `json:"jsDoc,omitempty"`
}

// PropertyInfo represents a struct field
type PropertyInfo struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Visibility string `json:"visibility"`
	IsStatic   bool   `json:"isStatic"`
	IsReadonly bool   `json:"isReadonly"`
}

// ImportInfo represents a Go import
type ImportInfo struct {
	Source     string            `json:"source"`
	Specifiers []ImportSpecifier `json:"specifiers"`
	Location   SourceLocation    `json:"location"`
}

// ImportSpecifier represents import details
type ImportSpecifier struct {
	Name        string `json:"name"`
	Alias       string `json:"alias,omitempty"`
	IsDefault   bool   `json:"isDefault"`
	IsNamespace bool   `json:"isNamespace"`
}

// PackageInfo represents Go package information
type PackageInfo struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Location SourceLocation `json:"location"`
}

// ParseError represents a parsing error
type ParseError struct {
	Message  string         `json:"message"`
	Location SourceLocation `json:"location"`
	Severity string         `json:"severity"`
}

// ASTResponse is the main response structure
type ASTResponse struct {
	Functions  []FunctionInfo  `json:"functions"`
	Interfaces []InterfaceInfo `json:"interfaces"`
	Structs    []StructInfo    `json:"structs"`
	Imports    []ImportInfo    `json:"imports"`
	Packages   []PackageInfo   `json:"packages"`
	Errors     []ParseError    `json:"errors"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: %s <go-file-path>\n", os.Args[0])
		os.Exit(1)
	}

	filePath := os.Args[1]
	
	// Read the Go source file
	src, err := ioutil.ReadFile(filePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading file: %v\n", err)
		os.Exit(1)
	}

	// Parse the Go source code
	response := parseGoFile(filePath, string(src))
	
	// Output JSON response
	output, err := json.MarshalIndent(response, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error marshaling JSON: %v\n", err)
		os.Exit(1)
	}
	
	fmt.Print(string(output))
}

func parseGoFile(filePath string, src string) ASTResponse {
	response := ASTResponse{
		Functions:  []FunctionInfo{},
		Interfaces: []InterfaceInfo{},
		Structs:    []StructInfo{},
		Imports:    []ImportInfo{},
		Packages:   []PackageInfo{},
		Errors:     []ParseError{},
	}

	// Create a new token file set
	fset := token.NewFileSet()
	
	// Parse the Go source code
	node, err := parser.ParseFile(fset, filePath, src, parser.ParseComments)
	if err != nil {
		response.Errors = append(response.Errors, ParseError{
			Message:  err.Error(),
			Location: SourceLocation{Start: Position{Line: 1, Column: 1}, End: Position{Line: 1, Column: 1}},
			Severity: "error",
		})
		return response
	}

	// Extract package information
	if node.Name != nil {
		pos := fset.Position(node.Name.Pos())
		response.Packages = append(response.Packages, PackageInfo{
			Name: node.Name.Name,
			Path: filepath.Dir(filePath),
			Location: SourceLocation{
				Start: Position{Line: pos.Line, Column: pos.Column},
				End:   Position{Line: pos.Line, Column: pos.Column + len(node.Name.Name)},
			},
		})
	}

	// Extract imports
	for _, imp := range node.Imports {
		importInfo := extractImportInfo(fset, imp)
		response.Imports = append(response.Imports, importInfo)
	}

	// Walk the AST and extract declarations
	ast.Inspect(node, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.FuncDecl:
			funcInfo := extractFunctionInfo(fset, x)
			response.Functions = append(response.Functions, funcInfo)
			
		case *ast.GenDecl:
			if x.Tok == token.TYPE {
				for _, spec := range x.Specs {
					switch typeSpec := spec.(type) {
					case *ast.TypeSpec:
						switch typeSpec.Type.(type) {
						case *ast.InterfaceType:
							interfaceInfo := extractInterfaceInfo(fset, typeSpec)
							response.Interfaces = append(response.Interfaces, interfaceInfo)
						case *ast.StructType:
							structInfo := extractStructInfo(fset, typeSpec)
							response.Structs = append(response.Structs, structInfo)
						}
					}
				}
			}
		}
		return true
	})

	return response
}

func extractFunctionInfo(fset *token.FileSet, fn *ast.FuncDecl) FunctionInfo {
	pos := fset.Position(fn.Pos())
	end := fset.Position(fn.End())
	
	funcInfo := FunctionInfo{
		Name: fn.Name.Name,
		Location: SourceLocation{
			Start: Position{Line: pos.Line, Column: pos.Column},
			End:   Position{Line: end.Line, Column: end.Column},
		},
		Parameters: []ParameterInfo{},
		IsAsync:    false, // Go doesn't have async/await
		IsExported: ast.IsExported(fn.Name.Name),
		IsMethod:   fn.Recv != nil,
	}

	// Extract receiver (for methods)
	if fn.Recv != nil && len(fn.Recv.List) > 0 {
		recv := fn.Recv.List[0]
		receiverType := extractTypeString(recv.Type)
		funcInfo.ClassName = cleanTypeName(receiverType)
		
		receiverName := ""
		if len(recv.Names) > 0 {
			receiverName = recv.Names[0].Name
		}
		
		funcInfo.Receiver = &ParameterInfo{
			Name: receiverName,
			Type: receiverType,
		}
	}

	// Extract parameters
	if fn.Type.Params != nil {
		for _, field := range fn.Type.Params.List {
			paramType := extractTypeString(field.Type)
			
			if len(field.Names) == 0 {
				// Unnamed parameter
				funcInfo.Parameters = append(funcInfo.Parameters, ParameterInfo{
					Name: "",
					Type: paramType,
				})
			} else {
				// Named parameters
				for _, name := range field.Names {
					funcInfo.Parameters = append(funcInfo.Parameters, ParameterInfo{
						Name: name.Name,
						Type: paramType,
					})
				}
			}
		}
	}

	// Extract return type
	if fn.Type.Results != nil && len(fn.Type.Results.List) > 0 {
		returnTypes := []string{}
		for _, field := range fn.Type.Results.List {
			returnTypes = append(returnTypes, extractTypeString(field.Type))
		}
		funcInfo.ReturnType = strings.Join(returnTypes, ", ")
	} else {
		funcInfo.ReturnType = "void"
	}

	// Extract documentation
	if fn.Doc != nil {
		funcInfo.JSDoc = fn.Doc.Text()
	}

	return funcInfo
}

func extractInterfaceInfo(fset *token.FileSet, typeSpec *ast.TypeSpec) InterfaceInfo {
	pos := fset.Position(typeSpec.Pos())
	end := fset.Position(typeSpec.End())
	
	interfaceInfo := InterfaceInfo{
		Name: typeSpec.Name.Name,
		Location: SourceLocation{
			Start: Position{Line: pos.Line, Column: pos.Column},
			End:   Position{Line: end.Line, Column: end.Column},
		},
		Members:    []InterfaceMember{},
		Extends:    []string{},
		IsExported: ast.IsExported(typeSpec.Name.Name),
	}

	if interfaceType, ok := typeSpec.Type.(*ast.InterfaceType); ok {
		for _, method := range interfaceType.Methods.List {
			switch methodType := method.Type.(type) {
			case *ast.FuncType:
				// Method signature
				if len(method.Names) > 0 {
					methodPos := fset.Position(method.Pos())
					methodEnd := fset.Position(method.End())
					
					interfaceInfo.Members = append(interfaceInfo.Members, InterfaceMember{
						Name: method.Names[0].Name,
						Type: "method",
						Location: SourceLocation{
							Start: Position{Line: methodPos.Line, Column: methodPos.Column},
							End:   Position{Line: methodEnd.Line, Column: methodEnd.Column},
						},
					})
				}
			case *ast.Ident:
				// Embedded interface
				interfaceInfo.Extends = append(interfaceInfo.Extends, methodType.Name)
			}
		}
	}

	return interfaceInfo
}

func extractStructInfo(fset *token.FileSet, typeSpec *ast.TypeSpec) StructInfo {
	pos := fset.Position(typeSpec.Pos())
	end := fset.Position(typeSpec.End())
	
	structInfo := StructInfo{
		Name: typeSpec.Name.Name,
		Location: SourceLocation{
			Start: Position{Line: pos.Line, Column: pos.Column},
			End:   Position{Line: end.Line, Column: end.Column},
		},
		Methods:    []FunctionInfo{},
		Properties: []PropertyInfo{},
		Implements: []string{},
		IsAbstract: false,
		IsExported: ast.IsExported(typeSpec.Name.Name),
	}

	if structType, ok := typeSpec.Type.(*ast.StructType); ok {
		for _, field := range structType.Fields.List {
			fieldType := extractTypeString(field.Type)
			
			if len(field.Names) == 0 {
				// Embedded field
				structInfo.Properties = append(structInfo.Properties, PropertyInfo{
					Name:       cleanTypeName(fieldType),
					Type:       fieldType,
					Visibility: getVisibility(fieldType),
					IsStatic:   false,
					IsReadonly: false,
				})
			} else {
				// Named fields
				for _, name := range field.Names {
					structInfo.Properties = append(structInfo.Properties, PropertyInfo{
						Name:       name.Name,
						Type:       fieldType,
						Visibility: getVisibility(name.Name),
						IsStatic:   false,
						IsReadonly: false,
					})
				}
			}
		}
	}

	return structInfo
}

func extractImportInfo(fset *token.FileSet, imp *ast.ImportSpec) ImportInfo {
	pos := fset.Position(imp.Pos())
	end := fset.Position(imp.End())
	
	importPath, _ := strconv.Unquote(imp.Path.Value)
	
	importInfo := ImportInfo{
		Source: importPath,
		Location: SourceLocation{
			Start: Position{Line: pos.Line, Column: pos.Column},
			End:   Position{Line: end.Line, Column: end.Column},
		},
		Specifiers: []ImportSpecifier{},
	}

	// Handle import alias
	alias := ""
	if imp.Name != nil {
		alias = imp.Name.Name
	}

	importInfo.Specifiers = append(importInfo.Specifiers, ImportSpecifier{
		Name:        filepath.Base(importPath),
		Alias:       alias,
		IsDefault:   true,  // Go imports are typically namespace imports
		IsNamespace: true,
	})

	return importInfo
}

func extractTypeString(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.StarExpr:
		return "*" + extractTypeString(t.X)
	case *ast.ArrayType:
		return "[]" + extractTypeString(t.Elt)
	case *ast.MapType:
		return "map[" + extractTypeString(t.Key) + "]" + extractTypeString(t.Value)
	case *ast.ChanType:
		return "chan " + extractTypeString(t.Value)
	case *ast.InterfaceType:
		return "interface{}"
	case *ast.StructType:
		return "struct{}"
	case *ast.FuncType:
		return "func"
	case *ast.SelectorExpr:
		return extractTypeString(t.X) + "." + t.Sel.Name
	default:
		return "unknown"
	}
}

func cleanTypeName(typeName string) string {
	// Remove pointer indicators and get base type name
	typeName = strings.TrimPrefix(typeName, "*")
	if idx := strings.LastIndex(typeName, "."); idx >= 0 {
		return typeName[idx+1:]
	}
	return typeName
}

func getVisibility(name string) string {
	if len(name) > 0 && name[0] >= 'A' && name[0] <= 'Z' {
		return "public"
	}
	return "private"
}