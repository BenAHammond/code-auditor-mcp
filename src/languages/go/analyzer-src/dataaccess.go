package analyzer

import (
	"go/ast"
	"go/token"
	"regexp"
	"strconv"
	"strings"
)

// runDataAccessAnalysis analyzes database-access patterns on `database/sql`
// method calls. It is the Go-subprocess counterpart of the TypeScript
// `UniversalDataAccessAnalyzer` + schema Stage-4 reducer, emitting the same
// bare rule IDs at the same ledger severities.
//
// Provenance differs, and that difference is load-bearing. The TypeScript
// analyzer derives "tenant table" and "known table" from *declared* sources —
// `.codeauditor.json` (`orgFilterTables`, `schemas`) and DDL migrations — the
// three-tier model Spec 62 Amendment B unified. The Go subprocess is
// self-contained: it does not read the project config, and Go source carries no
// DDL. It therefore substitutes hardcoded heuristics for the two declared
// inputs:
//
//   - `tenantTables` — the common multi-tenant table names — stands in for
//     "declared tenancy".
//   - `knownTables` — a small recognized-name list — stands in for a schema
//     catalog.
//
// The rules remain honest *within* those substitutes: `missing-org-filter`
// claims "no tenant predicate" (not "no filter") exactly as its TS counterpart,
// and `unknown-table` fires only on a singular/plural near-miss of a recognized
// name (the `user` vs `users` shape), never on a genuinely novel table the
// subprocess cannot prove unknown.

// tenantTables are the table names the self-contained Go analyzer treats as
// tenant-scoped (the TS pipeline reads this from config or DDL; Go has neither).
var tenantTables = map[string]bool{
	"users": true, "projects": true, "orders": true, "customers": true,
	"accounts": true, "teams": true,
}

// knownTables are the table names the self-contained Go analyzer recognizes.
// A table outside this set is flagged `unknown-table` only when it is a
// singular/plural near-miss of a known name — never merely for being novel.
var knownTables = map[string]bool{
	"users": true, "projects": true, "orders": true, "customers": true,
	"accounts": true, "teams": true, "products": true, "sessions": true,
	"payments": true, "invoices": true, "organizations": true,
}

// tableExtractRe matches `FROM <table>` / `INTO <table>` / `UPDATE <table>`
// (optionally backtick/double/single-quoted, optionally schema-prefixed).
var tableExtractRe = regexp.MustCompile(`(?i)\b(?:from|into|update)\s+[` + "`\"']?([A-Za-z_][A-Za-z0-9_.]*)")

// whereRe matches a row-limiting clause (WHERE/HAVING/LIMIT).
var whereRe = regexp.MustCompile(`(?i)\b(where|having|limit)\b`)

// tenantPredRe matches a tenant column referenced as a word anywhere in the SQL.
var tenantPredRe = regexp.MustCompile(`(?i)\b(organization_id|organisation_id|org_id|tenant_id|team_id|account_id|customer_id|company_id|workspace_id)\b`)

func (a *Analyzer) runDataAccessAnalysis() []Violation {
	var violations []Violation

	for filePath, file := range a.parser.files {
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			method, isDB := dbMethodName(call)
			if !isDB || len(call.Args) == 0 {
				return true
			}
			sqlExpr := call.Args[0]

			// sql-injection-risk: a dynamically-constructed SQL string is an
			// injection surface; a raw string literal with `$1` placeholders is
			// not. The dynamic case returns early — its table name is not
			// resolvable, so the table-based rules below cannot apply.
			if isDynamicSQL(sqlExpr) {
				if !containsSQLVerb(sqlFormatString(sqlExpr)) {
					return true
				}
				pos := a.parser.fileSet.Position(call.Pos())
				violations = append(violations, Violation{
					File:     filePath,
					Line:     pos.Line,
					Severity: "critical",
					Message:  "SQL query is built with string formatting instead of parameterized placeholders",
					Details: map[string]interface{}{
						"method": method,
					},
					Suggestion: "Use $1/$2 placeholders and pass the values as separate arguments",
					Analyzer:   "go",
					Rule:       "sql-injection-risk",
				})
				return true
			}

			sqlText := literalString(sqlExpr)
			if sqlText == "" {
				// A variable-held SQL string: neither provably static nor
				// provably dynamic. Leave it alone rather than guess.
				return true
			}

			verb := sqlVerb(sqlText)
			table := extractTable(sqlText)
			if table == "" {
				return true
			}

			// unknown-table: a recognized-name near-miss (`user` → `users`).
			if near, known := nearMissTable(table); !known && near != "" {
				pos := a.parser.fileSet.Position(call.Pos())
				violations = append(violations, Violation{
					File:     filePath,
					Line:     pos.Line,
					Severity: "critical",
					Message:  "Reference to unknown table \"" + table + "\" (did you mean \"" + near + "\"?)",
					Details: map[string]interface{}{
						"table":      table,
						"suggestion": near,
					},
					Suggestion: "Rename the table reference \"" + table + "\" to \"" + near + "\"",
					Analyzer:   "go",
					Rule:       "unknown-table",
				})
			}

			hasWhere := whereRe.MatchString(sqlText)
			hasTenantPred := tenantPredRe.MatchString(sqlText)

			// missing-org-filter: a row-affecting query (SELECT/UPDATE/DELETE) on
			// a tenant table with no tenant predicate. INSERT is excluded — an
			// insert does not filter existing rows; it should carry the tenant
			// column as a value, not a predicate.
			if tenantTables[table] && verb != "INSERT" && !hasTenantPred {
				pos := a.parser.fileSet.Position(call.Pos())
				violations = append(violations, Violation{
					File:     filePath,
					Line:     pos.Line,
					Severity: "critical",
					Message:  "Query on \"" + table + "\" has no organization/tenant predicate",
					Details: map[string]interface{}{
						"table":  table,
						"method": method,
					},
					Suggestion: "Add the tenant column (organization_id / org_id) to the WHERE predicate",
					Analyzer:   "go",
					Rule:       "missing-org-filter",
				})
			}

			// unfiltered-query: a write (INSERT/UPDATE/DELETE) with no
			// WHERE/HAVING/LIMIT. INSERT counts as a write here — the corpus pins
			// it — whereas the TS rule scopes writes to DELETE/UPDATE; an
			// unparameterized mass INSERT is the same "no filter" shape.
			if isWriteVerb(verb) && !hasWhere {
				pos := a.parser.fileSet.Position(call.Pos())
				violations = append(violations, Violation{
					File:     filePath,
					Line:     pos.Line,
					Severity: "high",
					Message:  "Write query on \"" + table + "\" has no WHERE/HAVING/LIMIT",
					Details: map[string]interface{}{
						"table":  table,
						"method": method,
					},
					Suggestion: "Add a WHERE/HAVING/LIMIT to scope the write",
					Analyzer:   "go",
					Rule:       "unfiltered-query",
				})
			}

			return true
		})
	}

	return violations
}

// dbMethodName reports whether the call is a `database/sql` method invocation
// and returns the selector name. The method set is the `database/sql` query/
// exec/prepare surface (and its Context variants); it deliberately excludes
// `Close`, `Commit`, `Rollback`, `Err`, and `Next`, which are not SQL-bearing.
func dbMethodName(call *ast.CallExpr) (string, bool) {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return "", false
	}
	switch sel.Sel.Name {
	case "Query", "QueryRow", "Exec", "Prepare",
		"QueryContext", "QueryRowContext", "ExecContext", "PrepareContext":
		return sel.Sel.Name, true
	}
	return "", false
}

// isDynamicSQL reports whether the SQL argument is constructed at runtime
// (string formatting or concatenation) rather than a single string literal.
func isDynamicSQL(expr ast.Expr) bool {
	switch e := expr.(type) {
	case *ast.BasicLit:
		return false
	case *ast.CallExpr:
		// Any call producing the SQL (fmt.Sprintf, a query builder, …) is
		// dynamic — its text is not a constant the analyzer can inspect.
		return true
	case *ast.BinaryExpr:
		return e.Op == token.ADD
	default:
		// A bare identifier is a variable-held string: treated as static (not
		// flagged), since there is no construction site to name as the risk.
		return false
	}
}

// literalString returns the unquoted value of a string literal, or "".
func literalString(expr ast.Expr) string {
	lit, ok := expr.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return ""
	}
	s, err := strconv.Unquote(lit.Value)
	if err != nil {
		return lit.Value
	}
	return s
}

// sqlFormatString returns the format string of a Sprintf-style call (its first
// argument when that argument is a literal), else "".
func sqlFormatString(expr ast.Expr) string {
	call, ok := expr.(*ast.CallExpr)
	if !ok || len(call.Args) == 0 {
		return ""
	}
	return literalString(call.Args[0])
}

// containsSQLVerb reports whether a (possibly dynamic) SQL fragment contains a
// DML keyword — the signal that a formatted string is actually SQL, not e.g.
// a `fmt.Sprintf` of a display label passed as a query argument by accident.
func containsSQLVerb(s string) bool {
	up := strings.ToUpper(s)
	return strings.Contains(up, "SELECT") ||
		strings.Contains(up, "INSERT") ||
		strings.Contains(up, "UPDATE") ||
		strings.Contains(up, "DELETE") ||
		strings.Contains(up, "FROM")
}

// sqlVerb returns the leading DML keyword of a SQL statement, or "".
func sqlVerb(sql string) string {
	up := strings.ToUpper(strings.TrimSpace(sql))
	switch {
	case strings.HasPrefix(up, "SELECT"):
		return "SELECT"
	case strings.HasPrefix(up, "INSERT"):
		return "INSERT"
	case strings.HasPrefix(up, "UPDATE"):
		return "UPDATE"
	case strings.HasPrefix(up, "DELETE"):
		return "DELETE"
	}
	return ""
}

// extractTable returns the lowercased table name referenced by FROM/INTO/UPDATE,
// or "". A schema prefix (`public.users`) is stripped to the bare name.
func extractTable(sql string) string {
	m := tableExtractRe.FindStringSubmatch(sql)
	if m == nil {
		return ""
	}
	table := m[1]
	if idx := strings.LastIndexByte(table, '.'); idx >= 0 {
		table = table[idx+1:]
	}
	return strings.ToLower(table)
}

// nearMissTable reports whether a table name is known; when it is not, and it is
// a singular/plural near-miss of a known name, it returns the corrected name.
// The `user` vs `users` singular→plural direction is what fires `unknown-table`.
func nearMissTable(table string) (near string, known bool) {
	if knownTables[table] {
		return "", true
	}
	if knownTables[table+"s"] {
		return table + "s", false
	}
	if knownTables[table+"es"] {
		return table + "es", false
	}
	if strings.HasSuffix(table, "s") {
		if base := strings.TrimSuffix(table, "s"); knownTables[base] {
			return base, false
		}
	}
	if strings.HasSuffix(table, "es") {
		if base := strings.TrimSuffix(table, "es"); knownTables[base] {
			return base, false
		}
	}
	return "", false
}

// isWriteVerb reports whether the verb mutates rows (INSERT/UPDATE/DELETE).
func isWriteVerb(verb string) bool {
	return verb == "INSERT" || verb == "UPDATE" || verb == "DELETE"
}
