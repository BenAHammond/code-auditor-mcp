package main

import "database/sql"

// parameterizedQuery uses $1 placeholders — the SQL string is a raw string
// literal recognised by the parameterized-query gate.  This should NOT fire
// sql-injection-risk.
func parameterizedQuery(db *sql.DB, userID int) (*sql.Rows, error) {
	return db.Query("SELECT id, name, email FROM users WHERE id = $1", userID)
}

// parameterizedExec follows the same pattern for writes.
func parameterizedExec(db *sql.DB, name string, email string) error {
	_, err := db.Exec("INSERT INTO users (name, email) VALUES ($1, $2)", name, email)
	return err
}
