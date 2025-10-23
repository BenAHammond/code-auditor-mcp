package analyzer

// AnalysisOptions represents options for the analysis
type AnalysisOptions struct {
	Analyzers   []string `json:"analyzers"`
	MinSeverity string   `json:"minSeverity"`
	Timeout     int      `json:"timeout"`
	Language    string   `json:"language"`
	Verbose     bool     `json:"verbose"`
}

// AnalysisResult represents the result of code analysis
type AnalysisResult struct {
	Violations   []Violation  `json:"violations"`
	IndexEntries []IndexEntry `json:"indexEntries"`
	Metrics      Metrics      `json:"metrics"`
	Errors       []Error      `json:"errors"`
}

// Violation represents a code quality violation
type Violation struct {
	File        string                 `json:"file"`
	Line        int                    `json:"line"`
	Column      int                    `json:"column"`
	Severity    string                 `json:"severity"`
	Message     string                 `json:"message"`
	Details     map[string]interface{} `json:"details,omitempty"`
	Snippet     string                 `json:"snippet,omitempty"`
	Suggestion  string                 `json:"suggestion,omitempty"`
	Analyzer    string                 `json:"analyzer"`
	Category    string                 `json:"category"`
}

// IndexEntry represents an entity in the code index
type IndexEntry struct {
	ID         string                 `json:"id"`
	Name       string                 `json:"name"`
	Type       string                 `json:"type"`
	Language   string                 `json:"language"`
	File       string                 `json:"file"`
	Signature  string                 `json:"signature"`
	Parameters []Parameter            `json:"parameters"`
	Purpose    string                 `json:"purpose"`
	Context    string                 `json:"context"`
	StartLine  int                    `json:"startLine"`
	EndLine    int                    `json:"endLine"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
}

// Parameter represents a function parameter
type Parameter struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Optional bool   `json:"optional"`
	Language string `json:"language"`
}

// Metrics represents analysis metrics
type Metrics struct {
	FilesAnalyzed int64 `json:"filesAnalyzed"`
	ExecutionTime int64 `json:"executionTime"`
}

// Error represents an analysis error
type Error struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	File    string `json:"file,omitempty"`
	Line    int    `json:"line,omitempty"`
}

// EntityInfo represents information about a Go entity
type EntityInfo struct {
	Name       string
	Type       string
	File       string
	StartLine  int
	EndLine    int
	Signature  string
	Parameters []Parameter
	ReturnType string
	Purpose    string
	Context    string
	Receiver   string // For methods
	Package    string
}

// Function represents a Go function
type Function struct {
	EntityInfo
	IsMethod     bool
	IsExported   bool
	Complexity   int
	Dependencies []string
}

// Struct represents a Go struct
type Struct struct {
	EntityInfo
	Fields     []Field
	Methods    []string
	IsExported bool
}

// Interface represents a Go interface
type Interface struct {
	EntityInfo
	Methods    []Method
	IsExported bool
}

// Field represents a struct field
type Field struct {
	Name       string
	Type       string
	Tag        string
	IsExported bool
}

// Method represents an interface method
type Method struct {
	Name       string
	Signature  string
	Parameters []Parameter
	ReturnType string
}

// SOLIDViolation represents SOLID principle violations specific to Go
type SOLIDViolation struct {
	Principle   string // SRP, OCP, LSP, ISP, DIP
	Entity      string
	Description string
	Suggestion  string
	Severity    string
	Examples    []string
}

// Package represents a Go package
type Package struct {
	Name      string
	Path      string
	Files     []string
	Imports   []string
	Exports   []string
	Functions []Function
	Structs   []Struct
	Interfaces []Interface
}