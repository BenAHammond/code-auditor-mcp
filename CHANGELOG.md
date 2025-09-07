# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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