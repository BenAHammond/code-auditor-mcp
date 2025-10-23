package analyzer

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
)

// Parser handles Go AST parsing and entity extraction
type Parser struct {
	fileSet *token.FileSet
	files   map[string]*ast.File
	options AnalysisOptions
}

// NewParser creates a new Go parser
func NewParser(options AnalysisOptions) *Parser {
	return &Parser{
		fileSet: token.NewFileSet(),
		files:   make(map[string]*ast.File),
		options: options,
	}
}

// ParseFiles parses the given Go files
func (p *Parser) ParseFiles(filePaths []string) error {
	for _, filePath := range filePaths {
		if !strings.HasSuffix(filePath, ".go") {
			continue
		}

		file, err := parser.ParseFile(p.fileSet, filePath, nil, parser.ParseComments)
		if err != nil {
			return fmt.Errorf("failed to parse %s: %w", filePath, err)
		}

		p.files[filePath] = file
	}

	return nil
}

// ParseContent parses Go source code from a string
func (p *Parser) ParseContent(filePath, content string) error {
	if !strings.HasSuffix(filePath, ".go") {
		return fmt.Errorf("not a Go file: %s", filePath)
	}

	file, err := parser.ParseFile(p.fileSet, filePath, content, parser.ParseComments)
	if err != nil {
		return fmt.Errorf("failed to parse content for %s: %w", filePath, err)
	}

	p.files[filePath] = file
	return nil
}

// ExtractFunctions extracts all functions from parsed files
func (p *Parser) ExtractFunctions() []Function {
	var functions []Function

	for filePath, file := range p.files {
		ast.Inspect(file, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.FuncDecl:
				function := p.extractFunction(node, filePath, file)
				functions = append(functions, function)
			}
			return true
		})
	}

	return functions
}

// ExtractStructs extracts all structs from parsed files
func (p *Parser) ExtractStructs() []Struct {
	var structs []Struct

	for filePath, file := range p.files {
		ast.Inspect(file, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.GenDecl:
				if node.Tok == token.TYPE {
					for _, spec := range node.Specs {
						if typeSpec, ok := spec.(*ast.TypeSpec); ok {
							if structType, ok := typeSpec.Type.(*ast.StructType); ok {
								structInfo := p.extractStruct(typeSpec, structType, filePath, file)
								structs = append(structs, structInfo)
							}
						}
					}
				}
			}
			return true
		})
	}

	return structs
}

// ExtractInterfaces extracts all interfaces from parsed files
func (p *Parser) ExtractInterfaces() []Interface {
	var interfaces []Interface

	for filePath, file := range p.files {
		ast.Inspect(file, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.GenDecl:
				if node.Tok == token.TYPE {
					for _, spec := range node.Specs {
						if typeSpec, ok := spec.(*ast.TypeSpec); ok {
							if interfaceType, ok := typeSpec.Type.(*ast.InterfaceType); ok {
								interfaceInfo := p.extractInterface(typeSpec, interfaceType, filePath, file)
								interfaces = append(interfaces, interfaceInfo)
							}
						}
					}
				}
			}
			return true
		})
	}

	return interfaces
}

// extractFunction extracts function information from AST
func (p *Parser) extractFunction(funcDecl *ast.FuncDecl, filePath string, file *ast.File) Function {
	pos := p.fileSet.Position(funcDecl.Pos())
	end := p.fileSet.Position(funcDecl.End())

	function := Function{
		EntityInfo: EntityInfo{
			Name:      funcDecl.Name.Name,
			Type:      "function",
			File:      filePath,
			StartLine: pos.Line,
			EndLine:   end.Line,
			Package:   file.Name.Name,
		},
		IsMethod:   funcDecl.Recv != nil,
		IsExported: ast.IsExported(funcDecl.Name.Name),
	}

	// Extract receiver for methods
	if funcDecl.Recv != nil && len(funcDecl.Recv.List) > 0 {
		if field := funcDecl.Recv.List[0]; field.Type != nil {
			function.Receiver = p.typeToString(field.Type)
		}
	}

	// Extract parameters
	if funcDecl.Type.Params != nil {
		for _, param := range funcDecl.Type.Params.List {
			paramType := p.typeToString(param.Type)
			if len(param.Names) > 0 {
				for _, name := range param.Names {
					function.Parameters = append(function.Parameters, Parameter{
						Name:     name.Name,
						Type:     paramType,
						Language: "go",
					})
				}
			} else {
				// Anonymous parameter
				function.Parameters = append(function.Parameters, Parameter{
					Name:     "",
					Type:     paramType,
					Language: "go",
				})
			}
		}
	}

	// Extract return type
	if funcDecl.Type.Results != nil {
		var returnTypes []string
		for _, result := range funcDecl.Type.Results.List {
			returnTypes = append(returnTypes, p.typeToString(result.Type))
		}
		function.ReturnType = strings.Join(returnTypes, ", ")
	}

	// Build signature
	function.Signature = p.buildFunctionSignature(function)

	// Extract purpose from comments
	if funcDecl.Doc != nil {
		function.Purpose = p.extractPurposeFromComments(funcDecl.Doc.Text())
	}

	// Calculate complexity (basic implementation)
	function.Complexity = p.calculateComplexity(funcDecl)

	return function
}

// extractStruct extracts struct information from AST
func (p *Parser) extractStruct(typeSpec *ast.TypeSpec, structType *ast.StructType, filePath string, file *ast.File) Struct {
	pos := p.fileSet.Position(typeSpec.Pos())
	end := p.fileSet.Position(typeSpec.End())

	structInfo := Struct{
		EntityInfo: EntityInfo{
			Name:      typeSpec.Name.Name,
			Type:      "struct",
			File:      filePath,
			StartLine: pos.Line,
			EndLine:   end.Line,
			Package:   file.Name.Name,
		},
		IsExported: ast.IsExported(typeSpec.Name.Name),
	}

	// Extract fields
	if structType.Fields != nil {
		for _, field := range structType.Fields.List {
			fieldType := p.typeToString(field.Type)
			tag := ""
			if field.Tag != nil {
				tag = field.Tag.Value
			}

			if len(field.Names) > 0 {
				for _, name := range field.Names {
					structInfo.Fields = append(structInfo.Fields, Field{
						Name:       name.Name,
						Type:       fieldType,
						Tag:        tag,
						IsExported: ast.IsExported(name.Name),
					})
				}
			} else {
				// Embedded field
				structInfo.Fields = append(structInfo.Fields, Field{
					Name:       fieldType, // Use type as name for embedded fields
					Type:       fieldType,
					Tag:        tag,
					IsExported: true, // Embedded fields are typically exported
				})
			}
		}
	}

	// Build signature
	structInfo.Signature = fmt.Sprintf("type %s struct", structInfo.Name)

	return structInfo
}

// extractInterface extracts interface information from AST
func (p *Parser) extractInterface(typeSpec *ast.TypeSpec, interfaceType *ast.InterfaceType, filePath string, file *ast.File) Interface {
	pos := p.fileSet.Position(typeSpec.Pos())
	end := p.fileSet.Position(typeSpec.End())

	interfaceInfo := Interface{
		EntityInfo: EntityInfo{
			Name:      typeSpec.Name.Name,
			Type:      "interface",
			File:      filePath,
			StartLine: pos.Line,
			EndLine:   end.Line,
			Package:   file.Name.Name,
		},
		IsExported: ast.IsExported(typeSpec.Name.Name),
	}

	// Extract methods
	if interfaceType.Methods != nil {
		for _, method := range interfaceType.Methods.List {
			if len(method.Names) > 0 {
				// Named method
				for _, name := range method.Names {
					if funcType, ok := method.Type.(*ast.FuncType); ok {
						methodInfo := Method{
							Name:      name.Name,
							Signature: p.buildMethodSignature(name.Name, funcType),
						}

						// Extract parameters
						if funcType.Params != nil {
							for _, param := range funcType.Params.List {
								paramType := p.typeToString(param.Type)
								if len(param.Names) > 0 {
									for _, paramName := range param.Names {
										methodInfo.Parameters = append(methodInfo.Parameters, Parameter{
											Name:     paramName.Name,
											Type:     paramType,
											Language: "go",
										})
									}
								}
							}
						}

						// Extract return type
						if funcType.Results != nil {
							var returnTypes []string
							for _, result := range funcType.Results.List {
								returnTypes = append(returnTypes, p.typeToString(result.Type))
							}
							methodInfo.ReturnType = strings.Join(returnTypes, ", ")
						}

						interfaceInfo.Methods = append(interfaceInfo.Methods, methodInfo)
					}
				}
			}
		}
	}

	// Build signature
	interfaceInfo.Signature = fmt.Sprintf("type %s interface", interfaceInfo.Name)

	return interfaceInfo
}

// typeToString converts an AST type to string representation
func (p *Parser) typeToString(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		return p.typeToString(t.X) + "." + t.Sel.Name
	case *ast.StarExpr:
		return "*" + p.typeToString(t.X)
	case *ast.ArrayType:
		if t.Len == nil {
			return "[]" + p.typeToString(t.Elt)
		}
		return "[...]" + p.typeToString(t.Elt)
	case *ast.MapType:
		return "map[" + p.typeToString(t.Key) + "]" + p.typeToString(t.Value)
	case *ast.ChanType:
		dir := ""
		switch t.Dir {
		case ast.SEND:
			dir = "chan<- "
		case ast.RECV:
			dir = "<-chan "
		default:
			dir = "chan "
		}
		return dir + p.typeToString(t.Value)
	case *ast.FuncType:
		return "func" // Simplified for now
	case *ast.InterfaceType:
		return "interface{}"
	case *ast.StructType:
		return "struct{}"
	default:
		return "unknown"
	}
}

// buildFunctionSignature builds a function signature string
func (p *Parser) buildFunctionSignature(function Function) string {
	var parts []string

	// Add receiver for methods
	if function.IsMethod && function.Receiver != "" {
		parts = append(parts, fmt.Sprintf("func (%s)", function.Receiver))
	} else {
		parts = append(parts, "func")
	}

	// Add function name
	parts = append(parts, function.Name)

	// Add parameters
	var paramStrs []string
	for _, param := range function.Parameters {
		if param.Name != "" {
			paramStrs = append(paramStrs, fmt.Sprintf("%s %s", param.Name, param.Type))
		} else {
			paramStrs = append(paramStrs, param.Type)
		}
	}
	parts = append(parts, fmt.Sprintf("(%s)", strings.Join(paramStrs, ", ")))

	// Add return type
	if function.ReturnType != "" {
		parts = append(parts, function.ReturnType)
	}

	return strings.Join(parts, " ")
}

// buildMethodSignature builds a method signature string for interfaces
func (p *Parser) buildMethodSignature(name string, funcType *ast.FuncType) string {
	var parts []string
	parts = append(parts, name)

	// Add parameters
	var paramStrs []string
	if funcType.Params != nil {
		for _, param := range funcType.Params.List {
			paramType := p.typeToString(param.Type)
			if len(param.Names) > 0 {
				for _, paramName := range param.Names {
					paramStrs = append(paramStrs, fmt.Sprintf("%s %s", paramName.Name, paramType))
				}
			} else {
				paramStrs = append(paramStrs, paramType)
			}
		}
	}
	parts = append(parts, fmt.Sprintf("(%s)", strings.Join(paramStrs, ", ")))

	// Add return type
	if funcType.Results != nil {
		var returnTypes []string
		for _, result := range funcType.Results.List {
			returnTypes = append(returnTypes, p.typeToString(result.Type))
		}
		if len(returnTypes) > 0 {
			parts = append(parts, strings.Join(returnTypes, ", "))
		}
	}

	return strings.Join(parts, " ")
}

// extractPurposeFromComments extracts purpose from Go doc comments
func (p *Parser) extractPurposeFromComments(docText string) string {
	lines := strings.Split(strings.TrimSpace(docText), "\n")
	if len(lines) > 0 {
		// Take the first line as purpose, removing comment markers
		purpose := strings.TrimSpace(lines[0])
		purpose = strings.TrimPrefix(purpose, "//")
		purpose = strings.TrimSpace(purpose)
		return purpose
	}
	return ""
}

// calculateComplexity calculates basic cyclomatic complexity
func (p *Parser) calculateComplexity(funcDecl *ast.FuncDecl) int {
	complexity := 1 // Base complexity

	ast.Inspect(funcDecl, func(n ast.Node) bool {
		switch n.(type) {
		case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt, *ast.SwitchStmt, *ast.TypeSwitchStmt:
			complexity++
		case *ast.CaseClause:
			complexity++
		}
		return true
	})

	return complexity
}