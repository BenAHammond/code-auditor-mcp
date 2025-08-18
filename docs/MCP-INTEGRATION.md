# MCP Integration Plan

## Overview

This document outlines the plan for converting the Code Auditor into a Model Context Protocol (MCP) server. The MCP integration will enable AI assistants like Claude to use the code auditor's capabilities as tools during conversations.

## Planned Architecture

### MCP Server Structure

```
code-auditor-mcp/
├── src/
│   ├── server.ts           # MCP server implementation
│   ├── tools/              # MCP tool definitions
│   │   ├── analyze-file.ts
│   │   ├── analyze-project.ts
│   │   ├── check-solid.ts
│   │   ├── find-duplicates.ts
│   │   ├── check-security.ts
│   │   ├── analyze-component.ts
│   │   ├── check-data-access.ts
│   │   └── generate-report.ts
│   ├── adapters/           # Adapters for existing analyzers
│   └── schemas/            # Tool input/output schemas
└── mcp.json               # MCP server manifest
```

## Planned MCP Tools

### 1. analyze-file
Analyze a single file for all enabled quality checks.

**Input Schema:**
```json
{
  "filePath": "string",
  "analyzers": ["solid", "dry", "security"],
  "options": {
    "minSeverity": "warning"
  }
}
```

**Output Schema:**
```json
{
  "violations": [
    {
      "type": "string",
      "severity": "critical|warning|suggestion",
      "line": "number",
      "column": "number",
      "message": "string",
      "recommendation": "string"
    }
  ],
  "summary": {
    "totalViolations": "number",
    "bySeverity": {}
  }
}
```

### 2. analyze-project
Run a complete project audit with configurable options.

**Input Schema:**
```json
{
  "projectPath": "string",
  "config": {
    "includePaths": ["string"],
    "excludePaths": ["string"],
    "enabledAnalyzers": ["string"]
  }
}
```

**Output Schema:**
```json
{
  "summary": {
    "filesAnalyzed": "number",
    "totalViolations": "number",
    "healthScore": "number"
  },
  "topIssues": [],
  "recommendations": []
}
```

### 3. check-solid
Check for SOLID principle violations in specified files.

**Input Schema:**
```json
{
  "files": ["string"],
  "principles": ["SRP", "OCP", "LSP", "ISP", "DIP"],
  "thresholds": {
    "maxMethodsPerClass": "number",
    "maxComplexity": "number"
  }
}
```

### 4. find-duplicates
Find duplicate code across the codebase.

**Input Schema:**
```json
{
  "searchPath": "string",
  "minLines": "number",
  "similarity": "number",
  "excludeTests": "boolean"
}
```

### 5. check-security
Verify security patterns in API endpoints and routes.

**Input Schema:**
```json
{
  "files": ["string"],
  "patterns": {
    "authRequired": ["string"],
    "publicAllowed": ["string"]
  }
}
```

### 6. analyze-component
Analyze UI component architecture and complexity.

**Input Schema:**
```json
{
  "componentPath": "string",
  "framework": "react|vue|angular|svelte",
  "checks": ["complexity", "props", "errorBoundary"]
}
```

### 7. check-data-access
Review database queries for security and performance.

**Input Schema:**
```json
{
  "files": ["string"],
  "database": "postgres|mysql|mongodb",
  "checkFor": ["sql-injection", "n+1", "missing-index"]
}
```

### 8. generate-report
Generate a formatted report from analysis results.

**Input Schema:**
```json
{
  "results": {},
  "format": "html|json|csv|markdown",
  "options": {
    "includeCodeSnippets": "boolean",
    "groupByFile": "boolean"
  }
}
```

## Implementation Strategy

### Phase 1: Core MCP Server Setup
1. Create basic MCP server using existing MCP server as reference
2. Implement server lifecycle (start, stop, health check)
3. Set up tool registration system
4. Create JSON schema definitions for all tools

### Phase 2: Analyzer Adapters
1. Create adapter layer to wrap existing analyzers
2. Convert analyzer results to MCP-compatible format
3. Handle streaming for large file analysis
4. Implement caching for performance

### Phase 3: Tool Implementation
1. Implement each tool using the adapter layer
2. Add input validation using JSON schemas
3. Create comprehensive error handling
4. Add progress reporting for long operations

### Phase 4: Enhanced Features
1. Add file watching capabilities
2. Implement incremental analysis
3. Create context preservation between calls
4. Add result caching and invalidation

## Technical Considerations

### Performance
- Stream results for large analyses
- Cache analysis results with smart invalidation
- Use worker threads for CPU-intensive operations
- Implement request debouncing

### Error Handling
- Graceful degradation when analyzers fail
- Clear error messages with recovery suggestions
- Timeout handling for long-running operations
- Input validation with helpful error messages

### Security
- Sandboxed file system access
- Path traversal prevention
- Resource usage limits
- Safe handling of untrusted code

## Integration Examples

### Claude Desktop Integration
```json
{
  "mcpServers": {
    "code-auditor": {
      "command": "npx",
      "args": ["code-auditor-mcp"],
      "env": {
        "AUDIT_MAX_FILES": "1000",
        "AUDIT_TIMEOUT": "30000"
      }
    }
  }
}
```

### Usage in Conversation
```
User: Can you check if my UserService class follows SOLID principles?

Claude: I'll analyze the UserService class for SOLID principle compliance.

[Uses check-solid tool with UserService.ts]

Based on the analysis, I found:
- Single Responsibility: ✓ The class has a focused purpose
- Open/Closed: ⚠️ Warning - Direct modification of user data without abstraction
- Dependency Inversion: ✓ Uses interfaces for dependencies

Would you like me to show you how to refactor the data modification to follow Open/Closed principle?
```

## Benefits of MCP Integration

### For AI Assistants
- Direct access to code quality analysis
- Real-time feedback during code review
- Ability to suggest specific improvements
- Context-aware recommendations

### For Developers
- Integrated code quality checks in AI conversations
- Immediate feedback on code changes
- Learning opportunities through AI explanations
- Automated refactoring suggestions

### For Teams
- Consistent code quality standards
- Automated code review assistance
- Knowledge sharing through AI
- Reduced review cycle time

## Reference Implementation

The MCP server will be based on the following structure:

```typescript
// server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

class CodeAuditorMCPServer {
  private server: Server;
  private auditor: AuditRunner;
  
  constructor() {
    this.server = new Server({
      name: 'code-auditor-mcp',
      version: '1.0.0'
    });
    
    this.auditor = new AuditRunner();
    this.registerTools();
  }
  
  private registerTools() {
    // Register each tool with schema validation
    this.server.setRequestHandler('tools/list', () => this.listTools());
    this.server.setRequestHandler('tools/call', (request) => this.callTool(request));
  }
  
  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
```

## Next Steps

1. **Finalize Tool Specifications**: Review and refine the 8 planned tools
2. **Create JSON Schemas**: Define precise input/output schemas
3. **Build Prototype**: Start with 2-3 core tools
4. **Test Integration**: Test with Claude Desktop
5. **Iterate Based on Feedback**: Refine based on real usage
6. **Document Best Practices**: Create usage guides
7. **Publish to MCP Registry**: Make available to community

## Resources

- [MCP Specification](https://modelcontextprotocol.io/docs)
- [MCP SDK](https://github.com/modelcontextprotocol/sdk)
- [Example MCP Servers](https://github.com/modelcontextprotocol/servers)
- Current Code Auditor source in `code-auditor/` directory