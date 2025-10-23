package main

import "fmt"

// Function with too many parameters - should trigger SRP violation
func CreateUserWithAllDetails(name, email, password, firstName, lastName, phone, address, city, state, zipCode string) error {
	fmt.Printf("Creating user: %s %s at %s, %s %s %s\n", firstName, lastName, address, city, state, zipCode)
	return nil
}

func main() {
	CreateUserWithAllDetails("john", "john@example.com", "password123", "John", "Doe", "555-1234", "123 Main St", "Anytown", "CA", "12345")
}