package main

import "fmt"

// greet is a non-database function that uses fmt.Sprintf to build a string.
// It has no SQL keywords and is not a DB-provenanced call — this file
// should produce zero findings (near-miss).
func greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}
