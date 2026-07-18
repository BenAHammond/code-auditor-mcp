# Search Operator Reference

`code-audit search <query>` supports operators for precise queries against the code index.

## Operators

### Type & Location

| Operator | Aliases | Example | Description |
|----------|---------|---------|-------------|
| `file:` | `path:` | `file:src/auth` | Files whose path matches the glob |
| `lang:` | `language:` | `lang:typescript` | Files in a specific language |
| `type:` | — | `type:.ts` | Files with a specific extension |
| `exported:` | — | `exported:` | Exported functions/components only |

### Complexity

| Operator | Example | Description |
|----------|---------|-------------|
| `complexity:N` | `complexity:10` | Exact cyclomatic complexity |
| `complexity:>N` | `complexity:>10` | Greater than N |
| `complexity:<N` | `complexity:<5` | Less than N |
| `complexity:N..M` | `complexity:5..15` | Range (inclusive) |
| `complexity:N-M` | `complexity:5-15` | Range (inclusive) |

### Documentation

| Operator | Aliases | Example | Description |
|----------|---------|---------|-------------|
| `jsdoc:` | `doc:` | `jsdoc:` | Has JSDoc documentation |

### Signatures

| Operator | Aliases | Example | Description |
|----------|---------|---------|-------------|
| `param:` | `parameter:` | `param:userId` | Has a parameter named userId |
| `return:` | `returns:` | `return:Promise` | Return type contains Promise |

### React/Components

| Operator | Aliases | Example | Description |
|----------|---------|---------|-------------|
| `component:` | — | `component:functional` | Component type: functional, class, memo, forwardRef |
| `hook:` | `hooks:` | `hook:useState` | Components using a specific hook |
| `prop:` | `props:` | `prop:onClick` | Components with a specific prop |
| `entity:` | — | `entity:function` | Entity type: function or component |

### Call Graph & Dependencies

| Operator | Aliases | Example | Description |
|----------|---------|---------|-------------|
| `calls:` | — | `calls:validateUser` | Functions that call a specific function |
| `calledby:` | `dependents-of:`, `used-by:` | `calledby:UserService` | Functions called by a specific function |
| `dep:` | `dependency:`, `uses:` | `dep:express` | Functions importing a specific module |
| `depends-on:` | `imports-from:` | `depends-on:lodash` | Functions depending on a module |
| `unused-imports` | `dead-imports` | `unused-imports` | Functions with unused imports |

### Free-text & Matching

| Feature | Example | Description |
|---------|---------|-------------|
| Terms | `validate user` | Search function names, signatures, JSDoc, bodies via FTS5 |
| Exact phrase | `"user authentication"` | Double-quoted exact phrase match |
| Excluded terms | `validation -email` | Exclude results matching a term |
| Fuzzy search | `~` or `fuzzy` | Enable fuzzy matching |
| Stemming | `stem` or `stemming` | Enable word stemming |

## Combining Operators

Operators combine with AND semantics. Examples:

```bash
# Complex Go functions that call validateUser
code-audit search "calls:validateUser lang:go complexity:>10"

# Exported TypeScript functions with JSDoc in the auth directory
code-audit search "exported: lang:typescript jsdoc: file:src/auth"

# Functional components using useState but not useEffect
code-audit search "component:functional hook:useState -useEffect"

# Functions depending on lodash (to audit lodash usage before removing it)
code-audit search "dep:lodash lang:typescript"

# Find dead imports across the codebase
code-audit search "unused-imports"
```

## Symbol Lookup

Use `--definition` to look up a specific symbol's full metadata:

```bash
code-audit search --definition "UserService.createUser"
```

Returns: signature, parameters, return type, JSDoc, dependencies, callers, complexity, file location.

## Options

| Flag | Description |
|------|-------------|
| `--json` | Output results as JSON |
| `--limit N` | Maximum results (default: 20) |
| `--language <lang>` | Filter results by language |
| `--definition` | Look up a specific symbol by name instead of searching |

## How It Works

Free-text terms are run through the QueryParser which:
1. Extracts operators (`calls:`, `lang:`, etc.) and their values
2. Extracts exact phrases (quoted strings)
3. Expands terms with synonym expansion (e.g., `get` → `fetch`, `retrieve`, `obtain`)
4. Splits camelCase (`getUserData` → `get`, `user`, `data`) and snake_case identifiers
5. Compiles to SQL with FTS5 MATCH expressions against the `functions_fts` virtual table

This means `search "getUser"` will match `getUserData`, `fetchUser`, `retrieveUser`, etc. — much broader than grep.
