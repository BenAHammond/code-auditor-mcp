package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"code-auditor-go/analyzer"
)

// JSON-RPC request structure
type Request struct {
	Method string      `json:"method"`
	Params interface{} `json:"params"`
	ID     interface{} `json:"id"`
}

// JSON-RPC response structure
type Response struct {
	Result interface{} `json:"result,omitempty"`
	Error  *RPCError   `json:"error,omitempty"`
	ID     interface{} `json:"id"`
}

// RPC error structure
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Analysis parameters structure
type AnalysisParams struct {
	Files   []string                `json:"files"`
	Options analyzer.AnalysisOptions `json:"options"`
}

// Content analysis parameters structure
type ContentAnalysisParams struct {
	File    string                  `json:"file"`
	Content string                  `json:"content"`
	Options analyzer.AnalysisOptions `json:"options"`
}

func main() {
	// Log startup to stderr (won't interfere with JSON-RPC on stdout)
	fmt.Fprintf(os.Stderr, "[GoAnalyzer] Starting Go analyzer server\n")
	
	// Create a buffered reader for stdin
	reader := bufio.NewReader(os.Stdin)

	for {
		// Read a line from stdin
		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				fmt.Fprintf(os.Stderr, "[GoAnalyzer] EOF reached\n")
				break
			}
			fmt.Fprintf(os.Stderr, "[GoAnalyzer] Read error: %v\n", err)
			sendError(-1, fmt.Sprintf("Error reading input: %v", err), nil)
			continue
		}

		line = strings.TrimSpace(line)
		fmt.Fprintf(os.Stderr, "[GoAnalyzer] Received: %s\n", line)
		
		if line == "" {
			fmt.Fprintf(os.Stderr, "[GoAnalyzer] Empty line, skipping\n")
			continue
		}

		// Parse JSON-RPC request
		var req Request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			fmt.Fprintf(os.Stderr, "[GoAnalyzer] Parse error: %v\n", err)
			sendError(-32700, "Parse error", req.ID)
			continue
		}

		fmt.Fprintf(os.Stderr, "[GoAnalyzer] Handling request: %s\n", req.Method)
		// Handle the request
		handleRequest(req)
	}
	fmt.Fprintf(os.Stderr, "[GoAnalyzer] Server shutting down\n")
}

func handleRequest(req Request) {
	switch req.Method {
	case "analyze":
		handleAnalyze(req)
	case "analyzeContent":
		handleAnalyzeContent(req)
	case "ping":
		sendResult("pong", req.ID)
	case "version":
		sendResult("1.0.0", req.ID)
	default:
		sendError(-32601, "Method not found", req.ID)
	}
}

func handleAnalyze(req Request) {
	// Parse parameters
	paramsBytes, err := json.Marshal(req.Params)
	if err != nil {
		sendError(-32602, "Invalid params", req.ID)
		return
	}

	var params AnalysisParams
	if err := json.Unmarshal(paramsBytes, &params); err != nil {
		sendError(-32602, "Invalid params", req.ID)
		return
	}

	// Filter Go files
	var goFiles []string
	for _, file := range params.Files {
		if strings.HasSuffix(file, ".go") {
			goFiles = append(goFiles, file)
		}
	}

	if len(goFiles) == 0 {
		sendError(-32603, "No Go files provided", req.ID)
		return
	}

	// Create and run analyzer
	goAnalyzer := analyzer.NewAnalyzer(params.Options)
	result, err := goAnalyzer.Analyze(goFiles)
	if err != nil {
		sendError(-32603, fmt.Sprintf("Analysis failed: %v", err), req.ID)
		return
	}

	// Send successful result
	sendResult(result, req.ID)
}

func sendResult(result interface{}, id interface{}) {
	response := Response{
		Result: result,
		ID:     id,
	}
	sendResponse(response)
}

func sendError(code int, message string, id interface{}) {
	response := Response{
		Error: &RPCError{
			Code:    code,
			Message: message,
		},
		ID: id,
	}
	sendResponse(response)
}

func sendResponse(response Response) {
	data, err := json.Marshal(response)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error marshaling response: %v\n", err)
		return
	}

	fmt.Println(string(data))
}

func handleAnalyzeContent(req Request) {
	// Parse parameters
	paramsBytes, err := json.Marshal(req.Params)
	if err != nil {
		sendError(-32602, "Invalid params", req.ID)
		return
	}

	var params ContentAnalysisParams
	if err := json.Unmarshal(paramsBytes, &params); err != nil {
		sendError(-32602, "Invalid params", req.ID)
		return
	}

	// Validate file extension
	if !strings.HasSuffix(params.File, ".go") {
		sendError(-32603, "Not a Go file", req.ID)
		return
	}

	// Create and run analyzer with content
	goAnalyzer := analyzer.NewAnalyzer(params.Options)
	result, err := goAnalyzer.AnalyzeContent(params.File, params.Content)
	if err != nil {
		sendError(-32603, fmt.Sprintf("Content analysis failed: %v", err), req.ID)
		return
	}

	// Send successful result
	sendResult(result, req.ID)
}