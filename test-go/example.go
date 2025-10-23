package main

import (
	"fmt"
	"net/http"
)

// User represents a user in the system
type User struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

// UserService provides user-related operations
type UserService interface {
	GetUser(id int) (*User, error)
	CreateUser(user *User) error
	UpdateUser(user *User) error
	DeleteUser(id int) error
	ListUsers() ([]*User, error)
	// Too many methods - should trigger Interface Segregation violation
	GetUserByEmail(email string) (*User, error)
	GetUserByName(name string) (*User, error)
	ResetPassword(id int) error
	ChangePassword(id int, newPassword string) error
	ActivateUser(id int) error
	DeactivateUser(id int) error
	GetActiveUsers() ([]*User, error)
	GetInactiveUsers() ([]*User, error)
	SearchUsers(query string) ([]*User, error)
	GetUserStats() (map[string]int, error)
	ExportUsers() ([]byte, error)
	ImportUsers(data []byte) error
	GetUserPermissions(id int) ([]string, error)
	SetUserPermissions(id int, permissions []string) error
	GetUserRoles(id int) ([]string, error)
	SetUserRoles(id int, roles []string) error
	GenerateAPIKey(id int) (string, error)
}

// UserRepository handles user data persistence
type UserRepository struct {
	db Database
}

// NewUserRepository creates a new user repository
func NewUserRepository(db Database) *UserRepository {
	return &UserRepository{db: db}
}

// GetUser retrieves a user by ID
func (r *UserRepository) GetUser(id int) (*User, error) {
	var user User
	err := r.db.QueryRow("SELECT id, name, email FROM users WHERE id = ?", id).Scan(&user.ID, &user.Name, &user.Email)
	if err != nil {
		return nil, err
	}
	return &user, nil
}

// CreateUser creates a new user - too many parameters
func (r *UserRepository) CreateUser(name, email, password, firstName, lastName, phone, address string) error {
	_, err := r.db.Exec("INSERT INTO users (name, email, password, first_name, last_name, phone, address) VALUES (?, ?, ?, ?, ?, ?, ?)", 
		name, email, password, firstName, lastName, phone, address)
	return err
}

// ComplexUserOperation - very long function that should trigger SRP violation
func (r *UserRepository) ComplexUserOperation(id int) error {
	// This function does too many things - violates Single Responsibility
	user, err := r.GetUser(id)
	if err != nil {
		return err
	}
	
	// Validate user
	if user.Name == "" {
		return fmt.Errorf("invalid user name")
	}
	if user.Email == "" {
		return fmt.Errorf("invalid user email")
	}
	
	// Update user stats
	_, err = r.db.Exec("UPDATE user_stats SET last_access = NOW() WHERE user_id = ?", id)
	if err != nil {
		return err
	}
	
	// Send notification
	err = r.sendNotification(user)
	if err != nil {
		return err
	}
	
	// Log activity
	err = r.logActivity(user, "complex_operation")
	if err != nil {
		return err
	}
	
	// Update cache
	err = r.updateCache(user)
	if err != nil {
		return err
	}
	
	// Generate report
	err = r.generateReport(user)
	if err != nil {
		return err
	}
	
	// Send email
	err = r.sendEmail(user)
	if err != nil {
		return err
	}
	
	// Update metrics
	err = r.updateMetrics(user)
	if err != nil {
		return err
	}
	
	return nil
}

func (r *UserRepository) sendNotification(user *User) error {
	// Implementation here
	return nil
}

func (r *UserRepository) logActivity(user *User, action string) error {
	// Implementation here
	return nil
}

func (r *UserRepository) updateCache(user *User) error {
	// Implementation here
	return nil
}

func (r *UserRepository) generateReport(user *User) error {
	// Implementation here
	return nil
}

func (r *UserRepository) sendEmail(user *User) error {
	// Implementation here
	return nil
}

func (r *UserRepository) updateMetrics(user *User) error {
	// Implementation here
	return nil
}

// Database interface - good interface design
type Database interface {
	QueryRow(query string, args ...interface{}) Row
	Exec(query string, args ...interface{}) (Result, error)
}

// Row interface
type Row interface {
	Scan(dest ...interface{}) error
}

// Result interface
type Result interface {
	LastInsertId() (int64, error)
	RowsAffected() (int64, error)
}

func main() {
	fmt.Println("Go code analysis example")
}