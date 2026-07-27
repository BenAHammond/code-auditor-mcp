package main

import (
	"database/sql"
	"fmt"
)

// dynamicSQL builds a query with fmt.Sprintf — the format string is a raw
// string literal with SQL keywords, and tableName is an unresolvable
// function parameter.  This should fire sql-injection-risk.
func dynamicSQL(db *sql.DB, tableName string) {
	rows, err := db.Query(fmt.Sprintf("SELECT * FROM %s", tableName))
	if err != nil {
		return
	}
	defer rows.Close()
}
