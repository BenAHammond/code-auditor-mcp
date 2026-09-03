# Invariant Rule Kinds

Five rule kinds are available in `.codeauditor.json`. Rules are validated at startup — bad configs fail the audit, not silently skipped.

## Rule Kinds

### `import-ban`

Prevent importing a given module (glob) from any file, unless the importing file matches an `except` path glob.

```json
{
  "id": "no-lodash",
  "kind": "import-ban",
  "severity": "critical",
  "module": "lodash",
  "message": "Use native ES2022+ equivalents instead of lodash"
}
```

With exceptions:
```json
{
  "id": "no-moment",
  "kind": "import-ban",
  "severity": "warning",
  "module": "moment",
  "except": ["src/legacy/**"],
  "message": "Use date-fns or Temporal. Moment is only allowed in legacy code."
}
```

### `call-constraint`

Allow or deny callers of a function. Exactly one of `allowFrom` or `denyFrom` must be specified.

```json
{
  "id": "eval-only-in-dev",
  "kind": "call-constraint",
  "severity": "critical",
  "callee": "eval",
  "allowFrom": ["src/dev-tools/**"],
  "message": "eval() is forbidden outside dev tools"
}
```

```json
{
  "id": "no-eval-in-prod",
  "kind": "call-constraint",
  "severity": "critical",
  "callee": "eval",
  "denyFrom": ["src/production/**", "src/server/**"],
  "message": "eval() is not allowed in production code"
}
```

The `callee` field can include a file path qualifier: `"src/utils/security.ts#sanitizeInput"` restricts the rule to calls to `sanitizeInput` only from that specific file.

### `module-boundary`

Files matching the `from` glob may not import from files matching the `to` glob.

```json
{
  "id": "ui-no-db",
  "kind": "module-boundary",
  "severity": "critical",
  "from": "src/ui/**",
  "to": "src/database/**",
  "message": "UI layer must not import from database layer. Use the API layer."
}
```

```json
{
  "id": "shared-no-features",
  "kind": "module-boundary",
  "severity": "warning",
  "from": "src/shared/**",
  "to": "src/features/**",
  "message": "Shared modules must not depend on feature modules."
}
```

### `naming`

Exported symbols in files matching the `path` glob must match the `exports` regex pattern.

```json
{
  "id": "hooks-prefix",
  "kind": "naming",
  "severity": "warning",
  "path": "src/**/use*.ts",
  "exports": "^use[A-Z]",
  "message": "Custom hooks exported from hook files must start with 'use' followed by an uppercase letter."
}
```

```json
{
  "id": "constants-upper",
  "kind": "naming",
  "severity": "suggestion",
  "path": "src/**/constants.ts",
  "exports": "^[A-Z][A-Z0-9_]*$",
  "message": "Exported constants should use UPPER_SNAKE_CASE."
}
```

### `ast-pattern`

Match AST nodes using [ast-grep](https://ast-grep.github.io/) pattern syntax. Uses `@ast-grep/napi` to parse source per-file and find pattern matches. Optionally restrict to files matching `path` and/or a specific `language`.

```json
{
  "id": "no-new-function",
  "kind": "ast-pattern",
  "severity": "critical",
  "pattern": "new Function($$$)",
  "message": "new Function() is eval-by-another-name — forbidden in this codebase"
}
```

With language and path constraints:
```json
{
  "id": "no-console-log-ts",
  "kind": "ast-pattern",
  "severity": "warning",
  "pattern": "console.log($$$)",
  "language": "typescript",
  "path": "src/production/**",
  "message": "Remove console.log before merging to production code."
}
```

`$$$` matches zero or more nodes (like `...` in rest patterns). `$$$ARGS` is a named meta-variable. See the [ast-grep pattern guide](https://ast-grep.github.io/guide/pattern-syntax.html) for full syntax.

## Severity Levels

Severity ranks how urgent a finding is to fix. It never decides whether a
finding is real, and it never licenses leaving one unresolved. Whether an edit
is *blocked* is a separate axis: the edit hook gates on invariant rules that
declare `gating: true` (a binary, per-rule flag), not on severity.

| Severity | What it means |
|----------|---------------|
| `critical` | Security vulnerabilities, data-loss risks |
| `warning` | Architecture violations, tech debt, missing documentation |
| `suggestion` | Smaller defects — naming, conventions, minor correctness |

> **Severity ranks urgency, never whether a finding is real.** There is no
> "noise" tier — every finding is a defect to resolve. A finding that does not
> block the edit still fails the review unless it is fixed, or the rule that
> produces it is edited in `.codeauditor.json`. There is no "waive" — a finding
> leaves the queue only by being resolved or by changing the rule that fires it.
> Documentation findings are not stylistic: missing
> JSDoc is a maintainability defect, not a nicety.

## Validation

Rules are validated against `invariant-rules.schema.json` on startup. Common errors:

- **Missing required field**: each kind has required fields (e.g., `import-ban` requires `module`)
- **Invalid severity**: must be one of `critical`, `warning`, `suggestion`
- **Invalid kind**: must be one of the five kinds above
- **Both allowFrom and denyFrom**: `call-constraint` requires exactly one
- **Empty pattern**: `ast-pattern` requires a non-empty `pattern` string
- **Invalid language**: `ast-pattern` language must be `typescript`, `javascript`, or `go`

Run `code-audit config rules-check` to validate `.codeauditor.json` after editing it.
