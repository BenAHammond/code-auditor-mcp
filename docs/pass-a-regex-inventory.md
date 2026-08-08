# Pass A — Regex Inventory (Parser Replacement Spec Set)

> Read-only reference. Produced 2026-08-03. Each regex listed is a literal in the
> current source tree. Quoted from source with path:line-range prefixes. No
> recommendations or modifications.

---

## A1 — Every Regex Literal with Special Chars, Grouped by Format

Special chars tracked: `{` `}` `(` `)` `[` `]` `"` `'` `` ` `` `/*` `//` `<` `>`

### Group: SQL

| # | File:Line(s) | Pattern | Purpose |
|---|---|---|---|
| 1 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:166` | `/(CREATE)\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\x60[^\x60]+\x60\|"[^"]+"\|\w+)\|(DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\x60[^\x60]+\x60\|"[^"]+"\|\w+)\|(ALTER)\s+TABLE\s+(\x60[^\x60]+\x60\|"[^"]+"\|\w+)\s+RENAME\s+TO\s+(\x60[^\x60]+\x60\|"[^"]+"\|\w+)/gi` | Parse DDL: CREATE/DROP/ALTER TABLE with backtick/double-quote/unquoted identifiers |
| 2 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:467` | `/^migrations_dir\s*=\s*['"](.+?)['"]/` | Parse `migrations_dir` value from wrangler.toml (TOML line) |
| 3 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:511` | `/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\x60[^\x60]+\x60\|"[^"]+"\|\w+)/gi` | Extract CREATE TABLE from migration SQL files |
| 4 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:536` | `/(?:pgTable\|mysqlTable\|sqliteTable)\s*\(\s*['"]([^'"]+)['"]/g` | Extract Drizzle ORM table names from builder calls |
| 5 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:623` | `new RegExp(\x60\\b${escapeRegex(receiver)}\\.${escapeRegex(method)}\\s*\\(\x60)` | Dynamic regex: find `.method(` calls on a specific DB receiver variable |
| 6 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:632` | `new RegExp(\x60\\b${escapeRegex(tag)}\x60\\s*SELECT\|...\\s*INSERT\|...\\s*UPDATE\|...\\s*DELETE\|...\\s*CREATE\x60, 'i')` | Dynamic regex: detect SQL keywords inside tagged template literal (e.g. `` sql\x60SELECT...\x60 ``) |
| 7 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:823` | `new RegExp(regex.source, regex.flags)` | Clone an existing regex with its flags (wraps other SQL regexes) |
| 8 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:884` | `/\bWITH\s+([\p{L}_][\p{L}\p{N}_]*)\s+AS\s*\(/giu` | CTE detection in SQL text |
| 9 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:891` | `/\b(?:FROM\|JOIN)\s+[\p{L}_][\p{L}\p{N}_]*\s+AS\s+([\p{L}_][\p{L}\p{N}_]*)\b/giu` | Explicit table aliases in SQL |
| 10 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:899` | `/\b(?:FROM\|JOIN)\s*\([^)]*\)\s+([\p{L}_][\p{L}\p{N}_]*)\b/giu` | Subquery aliases in SQL |
| 11 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:910` | `/\b(?:FROM\|JOIN)\s+([\p{L}_][\p{L}\p{N}_]*)\s+([\p{L}_][\p{L}\p{N}_]*)\b/giu` | Bare table + alias detection in SQL |
| 12 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:939` | `/\$\{[^}]+\}/g` | Strip template literal interpolations from SQL strings |
| 13 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:1093` | `new RegExp(pattern.source, pattern.flags)` | Clone a regex (receiver/method/tag matching) with its flags |
| 14 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:1699-1711` | `new RegExp(pattern.replace('*', '.*'))` | Dynamic regex from glob patterns for JSON schema→data file matching |
| 15 | `src/analyzers/universal/UniversalDataAccessAnalyzer.ts:104-105` | `/from\s*\(\s*["'\x60]?([\p{L}\p{N}_]+)["'\x60]` and `/table\s*[:=]\s*["'\x60]?([\p{L}\p{N}_]+)["'\x60]` | Detect ORM `from()` and `table:` calls in Drizzle |
| 16 | `src/analyzers/universal/UniversalDataAccessAnalyzer.ts:112` | `/FROM\s+["'\x60]?([\p{L}\p{N}_]+)["'\x60]?/giu`, `/JOIN\s+["'\x60]?([\p{L}\p{N}_]+)["'\x60]?/giu`, `/UPDATE\s+["'\x60]?([\p{L}\p{N}_]+)["'\x60]` | SQL keyword table references in raw SQL strings |
| 17 | `src/analyzers/universal/UniversalDataAccessAnalyzer.ts:113` | `/\.from\s*\(\s*["'\x60]?([\p{L}\p{N}_]+)["'\x60]` | Drizzle `.from()` call with table name |
| 18 | `src/analyzers/universal/UniversalDataAccessAnalyzer.ts:920` | `varName.replace(/[.*+?^${}()\|[\]\\]/g, '\\$&')` | Escape regex-special chars for dynamic SQL pattern matching |
| 19 | `src/analyzers/universal/UniversalDataAccessAnalyzer.ts:1011` | `/\.from\s*\(\s*([\p{L}_][\p{L}\p{N}_]*)\s*\)/gu` | ORM `.from()` call table reference extraction |
| 20 | `src/analyzers/universal/UniversalDataAccessAnalyzer.ts:1020` | `/db\.([\p{L}_][\p{L}\p{N}_]*)\.\p{L}[\p{L}\p{N}_]*\s*\(/gu` | Dynamic DB call detection (e.g. `db.users.find()`) |
| 21 | `src/analyzers/universal/UniversalDataAccessAnalyzer.ts:1218` | `/\.(\w+)\s*[<(]/` | Extract method name from call expression text |
| 22 | `src/analyzers/universal/UniversalDataAccessAnalyzer.ts:1246` | `/([\p{L}\p{N}_]+)\s*\(/u` | Extract callable name before open-paren |
| 23 | `src/analyzers/orm/drizzleAdapter.ts:117` | `/\.from\s*\(\s*(\w+)\s*\)/` | Drizzle `.from(TableName)` pattern |
| 24 | `src/analyzers/orm/drizzleAdapter.ts:129` | `/\.insert\s*\(\s*(\w+)\s*\)/` | Drizzle `.insert(TableName)` pattern |
| 25 | `src/analyzers/orm/drizzleAdapter.ts:141` | `/\.update\s*\(\s*(\w+)\s*\)/` | Drizzle `.update(TableName)` pattern |
| 26 | `src/analyzers/orm/drizzleAdapter.ts:153` | `/\.delete\s*\(\s*(\w+)\s*\)/` | Drizzle `.delete(TableName)` pattern |
| 27 | `src/analyzers/orm/drizzleAdapter.ts:229` | `/\{\s*([\s\S]*)\s*\}\s*\)?/` | Extract Drizzle column definition object from builder arg |
| 28 | `src/analyzers/orm/drizzleAdapter.ts:236` | `/(\w+)\s*:\s*(\w+)\s*\(/g` | Extract Drizzle column name:type pairs from column defs |
| 29 | `src/analyzers/orm/prismaAdapter.ts:87` | `/prisma\s*\.\s*(\w+)\s*\.\s*(\w+)\s*\(/` | Prisma client call detection (e.g. `prisma.user.findMany()`) |
| 30 | `src/pipelineAdapters.ts:815` | `/(?:pgTable\|mysqlTable\|sqliteTable)\s*\(\s*['"]([^'"]+)['"]/g` | Drizzle ORM table name extraction in schema-code visitor |
| 31 | `src/pipelineAdapters.ts:826` | `/\x60([^\x60]*(?:CREATE\|DROP\|ALTER)\s+(?:TABLE\|VIRTUAL\s+TABLE)\s+[^\x60]+)\x60/gis` | DO-local DDL in template literals (schema-code visitor) |
| 32 | `src/pipelineAdapters.ts:827` | `/(["'])((?:\s*(?:CREATE\|DROP\|ALTER)\s+(?:TABLE\|VIRTUAL\s+TABLE)\s+[^"']+))\1/gis` | DO-local DDL in string literals (schema-code visitor) |

### Group: Prisma

| # | File:Line(s) | Pattern | Purpose |
|---|---|---|---|
| 33 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:550` | `/model\s+(\w+)\s*\{/g` | Extract model names from Prisma schema files |
| 34 | `src/analyzers/orm/prismaAdapter.ts:136` | `/model\s+(\w+)\s*\{/g` | Extract model names (same pattern, in Prisma adapter) |
| 35 | `src/analyzers/orm/prismaAdapter.ts:197` | `/^(\w+)\s+(\w+)(\?)?/` | Parse field definitions in Prisma model blocks |
| 36 | `src/pipelineAdapters.ts:943` | `/model\s+(\w+)\s*\{/g` | Model extraction in schema-prisma pipeline visitor |

### Group: CSS

| # | File:Line(s) | Pattern | Purpose |
|---|---|---|---|
| 37 | `src/styles/tailwindUtilityExpander.ts:55` | `/^(?:[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*\|\[.+?\]):/` | Tailwind variant prefix detection (e.g. `hover:`, `[&_p]:`) |
| 38 | `src/styles/tailwindUtilityExpander.ts:62` | `/^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*-\[.+\]$/` | Arbitrary value utilities (e.g. `w-[300px]`) |
| 39 | `src/styles/tailwindUtilityExpander.ts:70` | `/^(.+)\/(\d{1,3})$/` | Opacity modifier split (e.g. `bg-red-500/50`) |
| 40 | `src/styles/tailwindUtilityExpander.ts:77` | `/^-(.+)$/` | Negative utility prefix (e.g. `-mt-4`) |
| 41 | `src/styles/styleIndexer.ts:210` | `/(?:className\|class)\s*=\s*(?:"([^"]*)"\|'([^']*)'\|\\{(["'\x60])((?:(?!\3).)*)\3\})/g` | Extract class name strings from JSX/HTML class/className attributes |
| 42 | `src/styles/tailwindConfigLoader.ts:300` | `/@theme(?:\s+\w+)?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g` | Extract CSS `@theme` blocks with nested braces |
| 43 | `src/styles/tailwindConfigLoader.ts:307` | `/--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g` | Extract CSS custom property declarations (e.g. `--color: value;`) |
| 44 | `src/styles/styleExtractor.ts:78` | `/--([a-zA-Z0-9_-]+)\s*:\s*([^;};]+)/g` | Extract CSS variable declarations from style strings |
| 45 | `src/styles/styleExtractor.ts:613` | `/([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(?:'([^']*)'\|"([^"]*)"\|\x60([^\x60]*)\x60\|([\d.]+))/g` | Extract inline style property:value pairs from JSX objects |
| 46 | `src/styles/styleExtractor.ts:695` | `/class(Name)?\s*=\s*"([^"]*)"/g` | Extract className="..." from JSX sources |
| 47 | `src/styles/styleExtractor.ts:726` | `/style\s*=\s*"([^"]*)"/g` | Extract style="..." inline style strings |
| 48 | `src/styles/styleExtractor.ts:817` | `/'([^']*)'\|"([^"]*)"/g` | Extract single- and double-quoted string values from CSS/JSX |
| 49 | `src/styles/tailwindProbe.ts:398` | `/@theme(?:\s+\w+)?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g` | @theme block extraction (duplicate of #42, used in probe mode) |
| 50 | `src/analyzers/universal/UniversalStylesAnalyzer.ts:1027` | `/rgb\(\s*(\d+)\s*,?\s*(\d+)\s*,?\s*(\d+)\s*\)/` | Parse `rgb()` color values for token detection |
| 51 | `src/analyzers/universal/UniversalStylesAnalyzer.ts:1094` | `/^(-?\d+(?:\.\d+)?)\s*(px\|rem\|em\|%\|vh\|vw\|pt\|cm\|mm)?$/` | Parse CSS dimension values for unit analysis |

### Group: TOML

| # | File:Line(s) | Pattern | Purpose |
|---|---|---|---|
| 52 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:467` | `/^migrations_dir\s*=\s*['"](.+?)['"]/` | Parse `migrations_dir` from wrangler.toml line-by-line (also listed under SQL group) |

### Group: TypeScript

| # | File:Line(s) | Pattern | Purpose |
|---|---|---|---|
| 53 | `src/invariants/ruleEngine.ts:100` | `/^import\b[\s\S]*?['"]([^'"]+)['"]/gm` | Static import detection for import-ban rules |
| 54 | `src/invariants/ruleEngine.ts:113` | `/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g` | Dynamic `import()` detection for call-constraint rules |
| 55 | `src/invariants/ruleEngine.ts:125` | `/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g` | `require()` detection |
| 56 | `src/invariants/ruleEngine.ts:604` | `/^export\s+(?:(?:default\s+)?(?:function\|class)\s+([\p{L}\p{N}_]+)\|(?:const\|let\|var)\s+([\p{L}\p{N}_]+))/gmu` | Export declaration detection for module-boundary rules |
| 57 | `src/invariants/ruleEngine.ts:615` | `/^export\s*\{([^}]+)\}/gm` | Named export lists detection |
| 58 | `src/conventions/conventionMiner.ts:279-292` | `new RegExp(\x60export\\s+default\\s+(?:function\|class\|const\|let\|var)?\\s*${escaped}\\b\x60)` + 5 more | Export pattern detection for convention classification (6 dynamic regexes via `new RegExp()`) |
| 59 | `src/analyzers/documentationAnalyzer.ts:91-92` | `/\/\*\*\|\*\/\|\s*\*\s?/g` | Strip JSDoc comment markers from doc text |
| 60 | `src/analyzers/documentationAnalyzer.ts:102` | `/@param\s+\{?\w+\}?\s*(?:\[\s*)?(\w+)/g` | Extract `@param` tags from JSDoc |
| 61 | `src/languages/typescript/TreeSitterTypeScriptAdapter.ts:1286,1311,1326` | `/^[$\p{L}_][\p{L}\p{N}_$]*$/u` | Validate JavaScript identifiers in template literal argument detection |
| 62 | `src/languages/go/GoAdapter.ts:880,905,915,937` | `/^[\p{L}_][\p{L}\p{N}_]*$/u`, `/^(fmt\.\|strings\.)(...)$/u`, `/^fmt\.(Sprintf\|Fprintf\|Errorf\|Appendf)$/u` | Go identifier and formatter function detection |
| 63 | `src/languages/go/GoAdapter.ts:828` | `/^(.*?\.)?(Sprintf\|Sprintf\|Sprint\|Sprintln\|Join\|Appendf\|Errorf\|Fprintf)$/` | Go formatting function selector matching |
| 64 | `src/utils/jsDocParser.ts:132` | `/@(\w+)([\s\S]*?)(?=@\w+\s\|$)/g` | Extract JSDoc tags with content |
| 65 | `src/churn/churnExtractor.ts` — not read; regex patterns exist | Git blame parsing | Identify changed functions and churn metrics |

### Group: JSON

| # | File:Line(s) | Pattern | Purpose |
|---|---|---|---|
| 66 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:1724` | `dataFileName.replace(/\.(data\|example\|test)\.json$/, '')` | Strip `.data.json` / `.example.json` / `.test.json` suffix for schema matching |
| 67 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:1728` | `schemaFileName.replace(/[.-]?schema\.json$/, '')` | Strip `.schema.json` / `-schema.json` suffix for schema→data matching |
| 68 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:1805` | `new RegExp(schema.pattern)` | Dynamic regex from JSON Schema `pattern` property for string validation |

### Group: None (utility / structural / generic)

These regexes don't parse a specific language format — they match structural patterns in arbitrary text or serve as utility helpers.

| # | File:Line(s) | Pattern | Purpose |
|---|---|---|---|
| 69 | `src/pipelineAdapters.ts:249` | `/\s+/g` | Whitespace normalization for function fingerprinting |
| 70 | `src/pipelineAdapters.ts:1039` | `/^(\d+)/` | Extract numeric prefix from migration file names |
| 71 | `src/codeIndexDB.ts:64` | `/\s+/g` | Whitespace normalization (same as #69) |
| 72 | `src/codeIndexDB.ts:2277` | `/\*/g`, `/\?/g`, `/\//g` | Glob-to-regex conversion (wildcard → `.*`, `?` → `.`, path separator escaping) |
| 73 | `src/codeIndexDB.ts:2504` | `p.replace(/\*/g, '.*')` | Glob pattern to regex for file path matching |
| 74 | `src/codeIndexDB-enhanced.ts:366` | `query.split(/\s+/)`, `t.replace(/"/g, '""')` | FTS5 query tokenization and SQL string escaping |
| 75 | `src/codeIndexDB-enhanced.ts:583` | `/(\p{Lu})/gu` | CamelCase tokenization via uppercase letter detection |
| 76 | `src/codeIndexDB-enhanced.ts:595` | `/\s+/` | Whitespace split for purpose word tokenization |
| 77 | `src/analyzers/provenance.ts:913` | `s.replace(/[.*+?^${}()\|[\]\\]/g, '\\$&')` | Regex metacharacter escaping |
| 78 | `src/analyzers/provenance.ts:1353` | `/^[\p{L}_$][\p{L}\p{N}_$]*/u` | Valid identifier start character detection |
| 79 | `src/analyzers/universal/UniversalSchemaAnalyzer.ts:2002` | `s.replace(/[.*+?^${}()\|[\]\\]/g, '\\$&')` | Regex metacharacter escaping (duplicate of #77) |
| 80 | `src/analyzers/universal/UniversalDataAccessAnalyzer.ts:920` | `varName.replace(/[.*+?^${}()\|[\]\\]/g, '\\$&')` | Regex metacharacter escaping (duplicate of #77) |
| 81 | `src/analyzers/universal/UniversalDRYAnalyzer.ts:364` | `normalized.replace(/\$\{[^}]*\}/g, 'ID')` | Normalize template literal interpolations to `ID` |
| 82 | `src/analyzers/universal/UniversalDRYAnalyzer.ts:367-370` | `/(['"\x60])\1/g`, `/\x60[^\x60]*\x60/g`, `/'[^']*'/g`, `/"[^"]*"/g` | Normalize string literals to `LIT` for code clone detection |
| 83 | `src/analyzers/universal/UniversalDRYAnalyzer.ts:373` | `/\b\d+\.?\d*\b/g` | Normalize numeric literals to `LIT` |
| 84 | `src/analyzers/universal/UniversalDRYAnalyzer.ts:376` | `/\/[^/*][^/]*\/[gimsuy]*/g` | Normalize regex literals to `LIT` |
| 85 | `src/analyzers/universal/UniversalDRYAnalyzer.ts:379` | `/\b(true\|false\|null\|undefined)\b/g` | Normalize boolean/null literals to `LIT` |
| 86 | `src/analyzers/universal/UniversalDRYAnalyzer.ts:383` | `/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g` | Normalize identifiers for code clone detection |
| 87 | `src/analyzers/universal/UniversalDRYAnalyzer.ts:545` | `/\/\/.*$/gm` | Strip line comments |
| 88 | `src/analyzers/universal/UniversalDRYAnalyzer.ts:547` | `/\/\*[\s\S]*?\*\//g` | Strip block comments |
| 89 | `src/analyzers/universal/UniversalDRYAnalyzer.ts:682` | `pattern.replace(/\*/g, '.*')` | Glob-to-regex in DRY pattern matching |
| 90 | `src/analyzers/universal/UniversalDRYAnalyzer.ts:736-737` | `text1.split(/\s+/)` | Tokenize text by whitespace |
| 91 | `src/analyzers/cross-language/SchemaValidator.ts:453-454` | `/[-_]/g`, `/request\|response\|dto\|model/g` | Name normalization for schema field matching |
| 92 | `src/analyzers/cross-language/SchemaValidator.ts:517` | `version.replace(/^v/, '').split('.')` | Version string parsing (strip `v` prefix, split on `.`) |
| 93 | `src/analyzers/crossDomain/CrossDomainAnalyzer.ts:676` | `g.replace(/\*\*/g, '%').replace(/\*/g, '%')` | Glob-to-SQL LIKE pattern conversion |
| 94 | `src/analyzers/universal/UniversalStylesAnalyzer.ts:756` | `v.replace(/,\s+/g, ',')` | Comma-space normalization in CSS value lists |
| 95 | `src/invariants/ruleEngine.ts:234` | `/\.(ts\|tsx\|js\|jsx\|mjs\|cjs)$/` | File extension match for module resolution |
| 96 | `src/utils/fileDiscovery.ts:194,255-262` | `pattern.replace(/\*/g, '.*')`, `pattern.replace(/[.+^${}()\|[\]\\]/g, '\\$&')`, `/\*\*\//g`, `/\*/g`, `/\?/g` | Glob pattern to regex conversion |
| 97 | `src/utils/dependencyExtractor.ts:27` | `/^["']\|["']$/g` | Strip surrounding quotes from import specifiers |
| 98 | `src/reporting/csvReportGenerator.ts:197` | `value.replace(/"/g, '""')` | CSV string escaping (double-quote doubling) |
| 99 | `src/reporting/htmlReportGenerator.ts:379` | `/[&<>"']/g` | HTML entity escaping |
| 100 | `src/reporting/sarifReportGenerator.ts:108` | `name.replace(/[^a-z0-9-]/g, '-')` | SARIF rule ID slugification |
| 101 | `src/reporting/sarifReportGenerator.ts:278-280` | `filePath.replace(/\\/g, '/')` | Backslash to forward-slash normalization |
| 102 | `src/reporting/sarifReportGenerator.ts:294` | `fullRuleId.replace(/\//g, '-')` | Slash-to-dash for SARIF URI fragments |
| 103 | `src/graph/blastRadius.ts:135` | `n.replace(/'/g, "''")` | SQL string escaping in graph queries |
| 104 | `src/graph/importGraph.ts:127,158,202,212,615` | `fp.replace(/\\/g, '/')` | Backslash normalization (5 sites) |
| 105 | `src/graph/importGraph.ts:700` | `/export\s+(type\|interface)\s+\w+/g` | Type/interface export detection |
| 106 | `src/graph/outputFormatter.ts:62` | `id.replace(/[^a-zA-Z0-9_]/g, '_')` | Graph node ID sanitization |
| 107 | `src/graph/outputFormatter.ts:72` | `label.replace(/"/g, '\\"').replace(/\n/g, '\\n')` | DOT format string escaping |

---

## A2 — Tree-Sitter Adapter Existence and Pipeline Reachability

### SQL regex sites

**Adapter exists?** DOES NOT EXIST. No `TreeSitterSqlAdapter`, no `sql` parser registered in `tree-sitter/parser.ts`, no `.sql` extension registered with any `LanguageAdapter`.

**Pipeline reachability:** SQL files (`.sql`) enter the pipeline as **raw tuples** (no adapter matches → `orphans` path at `src/pipeline.ts:121`). The `schema-sql` pipeline visitor (`src/pipelineAdapters.ts:757+`) declares extension `.sql` and receives the raw `sourceCode` string. The regex-based DDL extraction happens in that visitor, calling `UniversalSchemaAnalyzer.processMigrationSource()`.

All SQL regexes at sites in:
- `UniversalSchemaAnalyzer.ts` (DDL, CTE, FROM/JOIN, table alias patterns)
- `UniversalDataAccessAnalyzer.ts` (SQL keyword matching, ORM patterns)
- `drizzleAdapter.ts` / `prismaAdapter.ts` (ORM call patterns)
- `pipelineAdapters.ts:815,826,827,943` (visitor-side extraction)

are reachable from the pipeline via `createSchemaCodeVisitor()`, `createSchemaSqlVisitor()`, `createSchemaReducer()`, `createDataAccessVisitor()`, and `createDataAccessReducer()`.

### Prisma regex sites

**Adapter exists?** DOES NOT EXIST. No tree-sitter-prisma adapter. No `.prisma` extension registered with any `LanguageAdapter`.

**Pipeline reachability:** Prisma files (`.prisma`) enter as **raw tuples**. The `schema-prisma` pipeline visitor (`src/pipelineAdapters.ts:943`) declares extension `.prisma` and receives raw `sourceCode`. The `UniversalSchemaAnalyzer` and `prismaAdapter.ts` regexes process the raw source strings.

### CSS regex sites

**Adapter exists?** YES — `TreeSitterCssAdapter` at `src/languages/tree-sitter/TreeSitterCssAdapter.ts:43`. Registered for `.css` and `.scss` extensions at `src/languages/index.ts:31`.

**Pipeline reachability:** CSS files (`.css`, `.scss`) are **parsed** into AST tuples via the CSS adapter. However, the style-related regexes in:
- `src/styles/styleIndexer.ts:210`
- `src/styles/styleExtractor.ts:78,613,695,726,817`
- `src/styles/tailwindUtilityExpander.ts:55,62,70,77`
- `src/styles/tailwindConfigLoader.ts:300,307`
- `src/styles/tailwindProbe.ts:398`

operate on the **source text** (or source-sliced substrings), NOT on the AST. The CSS adapter (`TreeSitterCssAdapter`) has AST nodes for `declaration`, `at_rule`, `class_name`, `id_name`, `tag_name`, etc., but the style analyzers do not traverse these nodes. They use string-level regex matching on `sourceCode` or `content` text.

The `UniversalStylesAnalyzer` regexes (CSS values, rgb parsing, dimensions) at `src/analyzers/universal/UniversalStylesAnalyzer.ts:1027,1094` process the `styles` and `classes` data extracted from the index, not raw CSS.

**Key gap**: The CSS tree-sitter adapter exists and runs, but no pipeline visitor/analyzer currently reads CSS AST nodes. The adapter's `parse()` method produces a valid AST, but pipeline style visitors (`createStyleIndexVisitor()`, `createStylesReducer()`) use regex-based text scanning instead of tree-sitter node traversal.

### TOML regex sites

**Adapter exists?** DOES NOT EXIST. No tree-sitter-toml adapter.

**Pipeline reachability:** TOML files (`.toml`) enter as **raw tuples**. The `UniversalSchemaAnalyzer` processes `wrangler.toml` content via manual line-by-line scanning (`content.split('\n')` at `src/analyzers/universal/UniversalSchemaAnalyzer.ts:456`) with a regex match per line.

### TypeScript regex sites

**Adapter exists?** YES — `TreeSitterTypeScriptAdapter` at `src/languages/typescript/TreeSitterTypeScriptAdapter.ts`. Registered for `.ts`, `.tsx`, `.js`, `.jsx`.

**Pipeline reachability:** TypeScript/JavaScript files enter as **parsed** tuples with full AST. However, the TypeScript-specific regexes listed in group "TypeScript" serve different purposes:

1. **Invariant rule regexes** (`ruleEngine.ts:100,113,125,604,615`): These operate on `sourceCode` text, NOT on AST nodes. The invariant rule engine applies regexes directly to file content strings. A tree-sitter adapter IS available for these files, but the rule engine chooses text-based matching over AST traversal.

2. **Convention miner regexes** (`conventionMiner.ts:279-292`): Also operate on source text via `new RegExp()`, looking for export patterns. An AST is available but not used.

3. **Documentation regexes** (`documentationAnalyzer.ts:91-92,102`): JSDoc comment extraction. The tree-sitter adapter provides `getDocumentation()` at the AST level, but these regexes strip JSDoc markers from the raw text.

4. **Identifier validation regexes** (`TreeSitterTypeScriptAdapter.ts:1286,1311,1326`): These ARE inside the tree-sitter adapter itself, used during AST traversal to validate template literal argument names. They complement tree-sitter's structural understanding.

### JSON regex sites

**Adapter exists?** DOES NOT EXIST. No tree-sitter-json adapter.

**Pipeline reachability:** JSON files (`.json`) enter as **raw tuples**. The `schema-json` pipeline visitor (`src/pipelineAdapters.ts`) declares extension `.json` and `JSON.parse`s the raw content. The regex patterns at `UniversalSchemaAnalyzer.ts:1724,1728` operate on file names, not file content (for schema→data matching). The regex at `:1805` validates against JSON Schema string patterns dynamically.

---

## A3 — String-Based Scanning Without Regex

### Sites that use non-regex string operations for parsing/analysis

1. **`src/analyzers/universal/UniversalSchemaAnalyzer.ts:456`** — Line-by-line TOML scanning:
   ```
   for (const line of wranglerContent.split('\n')) {
   ```
   Splits wrangler.toml content into lines, then applies regex per line (hybrid approach). The line-splitting itself is non-regex.

2. **`src/analyzers/universal/UniversalSchemaAnalyzer.ts:1224`** — Substring callee extraction:
   ```
   const receiver = calleeText.substring(0, dotIdx);
   ```
   Uses `substring()` to split a call expression into receiver and method parts.

3. **`src/analyzers/cross-language/SchemaValidator.ts:517`** — Version parsing:
   ```
   version.replace(/^v/, '').split('.').map(Number)
   ```
   Uses `.split('.')` after regex prefix stripping (hybrid).

4. **`src/analyzers/cross-language/APIContractAnalyzer.ts:293-294`** — Endpoint matching:
   ```
   endpointPath.split('/')
   callUrl.split('/').map(part => part.split('?')[0])
   ```
   Non-regex path segment comparison for API contract checking.

5. **`src/analyzers/cross-language/DependencyGraphBuilder.ts:408-409`** — Path-based module resolution:
   ```
   parts.includes('src')
   const srcIndex = parts.indexOf('src')
   ```
   Uses string matching to locate the `src` directory in import paths.

6. **`src/analyzers/reactAnalyzer.ts:218,244-263,287-289`** — JSX string scanning:
   ```
   component.context?.includes('=>')
   component.jsxElements.includes('img')
   component.context?.includes('alt=')
   component.context?.includes('.map(')
   component.context?.includes('key=')
   ```
   Uses `String.includes()` to check for specific JSX patterns in the component body text.

7. **`src/analyzers/provenance.ts:716`** — AST node type matching:
   ```
   types.includes(child.type)
   ```
   Uses array `includes()` to match AST node types by string comparison (no regex).

8. **`src/analyzers/provenance.ts:859`** — Substring source code search:
   ```
   sourceCode.includes(binding)
   ```
   Checks if a binding name appears anywhere in the source.

### Summary of string-scanning patterns

| Approach | Sites | Used for |
|---|---|---|
| `.split('\n')` + loop | 1 site | TOML/wrangler line processing |
| `.split('/')` | 3+ sites | URL and path segment decomposition |
| `.substring()` | 1 site | Call expression decomposition |
| `.includes()` | 25+ sites | JSX pattern checks, import filtering, path matching |
| `.indexOf()` | 2 sites | Directory boundary detection in paths |
| `.startsWith()` | 3 sites | Hook naming convention check, package matching |
| `.endsWith()` | 4 sites | Test file detection |
| `.charAt()` / `.slice()` | 1 site | React hook renaming suggestion |

**No sites use character-by-character manual tokenizers or index-walking parsers** for structured-language parsing. All structured parsing (SQL DDL, Prisma models, CSS declarations) uses regex. The non-regex string operations are limited to:
- Path/URL segment splitting
- Substring containment checks
- Line looping with per-line regex

---

### Key takeaways (for spec writing)

1. **SQL** is the largest regex footprint with 32 patterns across 5 files, all operating on raw text (no adapter).
2. **CSS** has a tree-sitter adapter but NO pipeline visitor consumes its AST — all 15 CSS regexes operate on raw text.
3. **Prisma** and **TOML** have no adapters; all parsing is regex-on-raw-text.
4. **TypeScript** has a mature adapter, but 3 analyzer subsystems (invariants, conventions, documentation) bypass the AST for text-level regex matching on export/import patterns and JSDoc tags.
5. **JSON** has no adapter; file-name matching uses regex, file content uses `JSON.parse()`.
6. **No manual tokenizer/state-machine parsers exist** — all structured format parsing is regex-based.
7. **2 regex-escaping utilities** exist at 3 sites (`UniversalSchemaAnalyzer.ts:2002`, `UniversalDataAccessAnalyzer.ts:920`, `provenance.ts:913`) — identical `/[.*+?^${}()|[\]\\]/g, '\\$&'` pattern — representing a duplicated utility.
