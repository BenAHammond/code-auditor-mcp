package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"code-auditor-go/analyzer"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: %s <options-json> <file1> [file2] ...\n", os.Args[0])
		os.Exit(1)
	}

	// Parse options from JSON
	var options analyzer.AnalysisOptions
	if err := json.Unmarshal([]byte(os.Args[1]), &options); err != nil {
		fmt.Fprintf(os.Stderr, "Error parsing options: %v\n", err)
		os.Exit(1)
	}

	// Get file list
	files := os.Args[2:]
	if len(files) == 0 {
		fmt.Fprintf(os.Stderr, "No files provided for analysis\n")
		os.Exit(1)
	}

	// Filter Go files
	var goFiles []string
	for _, file := range files {
		if strings.HasSuffix(file, ".go") {
			goFiles = append(goFiles, file)
		}
	}

	if len(goFiles) == 0 {
		fmt.Fprintf(os.Stderr, "No Go files found in provided list\n")
		os.Exit(1)
	}

	// Create and run analyzer
	goAnalyzer := analyzer.NewAnalyzer(options)
	result, err := goAnalyzer.Analyze(goFiles)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Analysis error: %v\n", err)
		os.Exit(1)
	}

	// Output result as JSON
	output, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error marshaling result: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(string(output))
}