# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.0] - 2024-12-21

### Added
- **Content Search** - Search within function bodies, not just metadata
  - New `searchMode` parameter: `metadata`, `content`, or `both`
  - Match context shows 2 lines before/after matches
  - Line-level match tracking with line numbers and columns
- **Enhanced Query Parsing** - Improved handling of complex queries
  - Support for nested quotes in search queries
  - Better handling of escaped characters
  - Proper parsing of queries like `"column: 'country'"`
- **Unused Imports Configuration** - Added configurable options for unused import detection
  - `checkLevel`: Choose between function-level or file-level analysis
  - `includeTypeOnlyImports`: Option to include/exclude type-only imports
  - `ignorePatterns`: Regex patterns to ignore specific imports (e.g., React)
- **DRY Analyzer Unused Import Detection** - DRY analyzer now detects and reports unused imports
  - New `checkUnusedImports` configuration option (default: true)
  - Reports unused imports as DRY violations with severity 'suggestion'
  - Properly handles namespace imports, named imports, and default imports
  - Excludes import declarations from usage detection to avoid false negatives

### Fixed
- **Unused Import Detection** - Fixed major issues causing ~40% false positive rate
  - Namespace imports (`import * as name`) now properly tracked when used
  - Property access on imported objects now correctly detected (e.g., `config.database.host`)
  - Method calls on imported objects now tracked (e.g., `logger.error()`)
  - DRY analyzer now properly reports unused imports as violations (not just metadata)
- **Search Results** - Now returns line-level matches instead of just function-level
- **File Filtering** - Improved file path filtering logic
  - Supports exact matches, glob patterns, and substring matching
  - Properly restricts results to specified file paths
- **Function Body Indexing** - Fixed missing body extraction for arrow functions and methods
- **FlexSearch Configuration** - Added body field to search index
- **SRP False Positives** - Fixed Single Responsibility Principle detection
  - No longer flags single-element responsibility groups
  - Better grouping logic for related functionality

## [1.2.0] - 2024-12-20

### Changed
- **Simplified MCP tool set** - Reduced from 16 tools to 6 core tools for better usability
  - `audit_run` → `audit` - Now handles both files and directories
  - `audit_check_health` → `audit_health` - Clearer naming
  - `search_functions` → `search_code` - Better reflects natural language search capability
  - `generate_ai_configs` → `generate_ai_config` - Consistent singular naming
  - Combined `bulk_cleanup`, `deep_sync`, `clear_index` → `sync_index` with modes
  - Removed redundant tools: `audit_analyze_file`, `register_functions`, `index_functions`, `audit_list_analyzers`, `list_ai_tools`, `get_ai_tool_info`, `validate_ai_config`

### Added
- Function indexing during audits - audit tools now index functions by default (set `indexFunctions: false` to disable)
- Avoids duplicate file parsing by collecting functions during the audit process
- New `sync_index` tool with modes: `sync` (default), `cleanup`, `reset`
- Audit tools now use `syncFileIndex` to properly handle function deletions, additions, and updates

### Fixed
- Fixed MCP standalone server trying to pass non-existent `--json` flag to CLI
- MCP tools (`audit`, `audit_health`) now work correctly via npx and Claude
- Updated mcp-standalone.ts to support all 6 simplified tools (was missing 4 tools)

## [1.1.0] - 2024-12-20

### Added
- **Enhanced Code Index with FlexSearch** - Full-text search with intelligent tokenization
  - Natural language search queries (e.g., "validate email", "user authentication")
  - CamelCase/PascalCase tokenization for better search results
  - Synonym expansion for common programming terms
  - Multi-strategy search (exact match, AND logic, OR logic)
  - Support for search operators (type:, param:, lang:)
  
- **AI Tool Configuration Generator** - Auto-generate configurations for AI coding assistants
  - Support for 10+ AI tools: Cursor, Continue, Copilot, Claude, Zed, Windsurf, Cody, Aider, Cline, PearAI
  - Automatic MCP server URL configuration
  - Validation tool for generated configurations
  
- **Index Maintenance Tools**
  - `bulk_cleanup` - Remove entries for deleted files
  - `deep_sync` - Re-scan all indexed files to update signatures
  - File synchronization support for incremental updates
  
- **Query Parser** - Advanced search query parsing
  - 30+ synonym groups for common programming terms
  - Phrase search support
  - Exclusion terms support
  - Filter operators for precise searches
  
- **Comprehensive Documentation**
  - TOOLS-DOCUMENTATION.md with detailed usage examples
  - Workflow integration guide
  - Best practices for "search before code" methodology

### Fixed
- Multi-word search queries now work correctly
- Function names with camelCase/snake_case are properly searchable
- Search index properly updates when files change

### Changed
- FlexSearch configuration updated from 'forward' to 'full' tokenization
- Search results now include relevance scores
- CodeIndexDB now uses singleton pattern for better resource management

## [1.0.1] - 2024-12-15

### Initial Release
- SOLID principles analyzer
- DRY (Don't Repeat Yourself) analyzer
- Security pattern analyzer
- Component architecture analyzer
- Data access pattern analyzer
- MCP server integration
- Multiple output formats (HTML, JSON, CSV)
- Framework-specific configurations