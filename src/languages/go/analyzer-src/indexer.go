package analyzer

import (
	"fmt"
	"path/filepath"
)

// Indexer creates index entries for Go entities
type Indexer struct {
	parser *Parser
}

// NewIndexer creates a new indexer
func NewIndexer(parser *Parser) *Indexer {
	return &Indexer{
		parser: parser,
	}
}

// GenerateIndexEntries creates index entries for all parsed entities
func (i *Indexer) GenerateIndexEntries() []IndexEntry {
	var entries []IndexEntry

	// Index functions
	functions := i.parser.ExtractFunctions()
	for _, function := range functions {
		entry := i.createFunctionIndexEntry(function)
		entries = append(entries, entry)
	}

	// Index structs
	structs := i.parser.ExtractStructs()
	for _, structInfo := range structs {
		entry := i.createStructIndexEntry(structInfo)
		entries = append(entries, entry)
	}

	// Index interfaces
	interfaces := i.parser.ExtractInterfaces()
	for _, interfaceInfo := range interfaces {
		entry := i.createInterfaceIndexEntry(interfaceInfo)
		entries = append(entries, entry)
	}

	return entries
}

// createFunctionIndexEntry creates an index entry for a function
func (i *Indexer) createFunctionIndexEntry(function Function) IndexEntry {
	return IndexEntry{
		ID:         i.generateID("function", function.File, function.Name, function.StartLine),
		Name:       function.Name,
		Type:       "function",
		Language:   "go",
		File:       function.File,
		Signature:  function.Signature,
		Parameters: function.Parameters,
		Purpose:    function.Purpose,
		Context:    i.generateContext(function.EntityInfo),
		StartLine:  function.StartLine,
		EndLine:    function.EndLine,
		Metadata: map[string]interface{}{
			"isMethod":     function.IsMethod,
			"isExported":   function.IsExported,
			"receiver":     function.Receiver,
			"returnType":   function.ReturnType,
			"complexity":   function.Complexity,
			"package":      function.Package,
			"dependencies": function.Dependencies,
		},
	}
}

// createStructIndexEntry creates an index entry for a struct
func (i *Indexer) createStructIndexEntry(structInfo Struct) IndexEntry {
	return IndexEntry{
		ID:        i.generateID("struct", structInfo.File, structInfo.Name, structInfo.StartLine),
		Name:      structInfo.Name,
		Type:      "struct",
		Language:  "go",
		File:      structInfo.File,
		Signature: structInfo.Signature,
		Purpose:   i.generateStructPurpose(structInfo),
		Context:   i.generateContext(structInfo.EntityInfo),
		StartLine: structInfo.StartLine,
		EndLine:   structInfo.EndLine,
		Metadata: map[string]interface{}{
			"isExported": structInfo.IsExported,
			"fieldCount": len(structInfo.Fields),
			"fields":     i.serializeFields(structInfo.Fields),
			"methods":    structInfo.Methods,
			"package":    structInfo.Package,
		},
	}
}

// createInterfaceIndexEntry creates an index entry for an interface
func (i *Indexer) createInterfaceIndexEntry(interfaceInfo Interface) IndexEntry {
	return IndexEntry{
		ID:        i.generateID("interface", interfaceInfo.File, interfaceInfo.Name, interfaceInfo.StartLine),
		Name:      interfaceInfo.Name,
		Type:      "interface",
		Language:  "go",
		File:      interfaceInfo.File,
		Signature: interfaceInfo.Signature,
		Purpose:   i.generateInterfacePurpose(interfaceInfo),
		Context:   i.generateContext(interfaceInfo.EntityInfo),
		StartLine: interfaceInfo.StartLine,
		EndLine:   interfaceInfo.EndLine,
		Metadata: map[string]interface{}{
			"isExported":   interfaceInfo.IsExported,
			"methodCount":  len(interfaceInfo.Methods),
			"methods":      i.serializeMethods(interfaceInfo.Methods),
			"package":      interfaceInfo.Package,
		},
	}
}

// generateID creates a unique ID for an entity
func (i *Indexer) generateID(entityType, file, name string, line int) string {
	return fmt.Sprintf("go:%s:%s:%s:%d", entityType, filepath.Base(file), name, line)
}

// generateContext creates context information for an entity
func (i *Indexer) generateContext(entity EntityInfo) string {
	return fmt.Sprintf("Go %s in package %s at %s:%d", 
		entity.Type, entity.Package, filepath.Base(entity.File), entity.StartLine)
}

// generateStructPurpose creates a purpose description for a struct
func (i *Indexer) generateStructPurpose(structInfo Struct) string {
	if structInfo.Purpose != "" {
		return structInfo.Purpose
	}

	fieldCount := len(structInfo.Fields)
	if fieldCount == 0 {
		return fmt.Sprintf("Empty struct %s", structInfo.Name)
	}

	return fmt.Sprintf("Data structure with %d fields representing %s", 
		fieldCount, i.inferStructPurpose(structInfo))
}

// generateInterfacePurpose creates a purpose description for an interface
func (i *Indexer) generateInterfacePurpose(interfaceInfo Interface) string {
	if interfaceInfo.Purpose != "" {
		return interfaceInfo.Purpose
	}

	methodCount := len(interfaceInfo.Methods)
	if methodCount == 0 {
		return fmt.Sprintf("Empty interface %s", interfaceInfo.Name)
	}

	return fmt.Sprintf("Interface defining %d methods for %s behavior", 
		methodCount, i.inferInterfacePurpose(interfaceInfo))
}

// inferStructPurpose tries to infer the purpose of a struct from its name and fields
func (i *Indexer) inferStructPurpose(structInfo Struct) string {
	name := structInfo.Name
	
	// Common patterns in Go struct names
	if containsAny(name, []string{"Config", "Configuration"}) {
		return "configuration data"
	}
	if containsAny(name, []string{"Request", "Req"}) {
		return "request data"
	}
	if containsAny(name, []string{"Response", "Resp"}) {
		return "response data"
	}
	if containsAny(name, []string{"Handler", "Controller"}) {
		return "request handling"
	}
	if containsAny(name, []string{"Service", "Manager"}) {
		return "business logic"
	}
	if containsAny(name, []string{"Repository", "Repo", "Store"}) {
		return "data access"
	}
	if containsAny(name, []string{"Model", "Entity"}) {
		return "data model"
	}
	if containsAny(name, []string{"Client", "Adapter"}) {
		return "external integration"
	}

	return "entity data"
}

// inferInterfacePurpose tries to infer the purpose of an interface from its name and methods
func (i *Indexer) inferInterfacePurpose(interfaceInfo Interface) string {
	name := interfaceInfo.Name
	
	// Common patterns in Go interface names
	if containsAny(name, []string{"Reader", "Writer", "ReadWriter"}) {
		return "I/O operations"
	}
	if containsAny(name, []string{"Handler", "Processor"}) {
		return "request processing"
	}
	if containsAny(name, []string{"Repository", "Store"}) {
		return "data storage"
	}
	if containsAny(name, []string{"Service", "Provider"}) {
		return "service operations"
	}
	if containsAny(name, []string{"Client", "Adapter"}) {
		return "external communication"
	}
	if containsAny(name, []string{"Validator", "Checker"}) {
		return "validation logic"
	}
	if containsAny(name, []string{"Builder", "Factory"}) {
		return "object creation"
	}

	return "behavioral contract"
}

// serializeFields converts struct fields to a serializable format
func (i *Indexer) serializeFields(fields []Field) []map[string]interface{} {
	var serialized []map[string]interface{}
	
	for _, field := range fields {
		serialized = append(serialized, map[string]interface{}{
			"name":       field.Name,
			"type":       field.Type,
			"tag":        field.Tag,
			"isExported": field.IsExported,
		})
	}
	
	return serialized
}

// serializeMethods converts interface methods to a serializable format
func (i *Indexer) serializeMethods(methods []Method) []map[string]interface{} {
	var serialized []map[string]interface{}
	
	for _, method := range methods {
		serialized = append(serialized, map[string]interface{}{
			"name":       method.Name,
			"signature":  method.Signature,
			"parameters": method.Parameters,
			"returnType": method.ReturnType,
		})
	}
	
	return serialized
}

// containsAny checks if a string contains any of the given substrings
func containsAny(str string, substrings []string) bool {
	for _, substring := range substrings {
		if len(str) >= len(substring) {
			for i := 0; i <= len(str)-len(substring); i++ {
				if str[i:i+len(substring)] == substring {
					return true
				}
			}
		}
	}
	return false
}