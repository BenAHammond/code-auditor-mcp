package testadvanced

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// SRP Violations - Functions doing too many things

// MegaProcessor violates SRP by handling validation, processing, logging, caching, and notifications
func MegaProcessor(data string, userID int, config map[string]interface{}, ctx context.Context) (result string, cached bool, processed bool, notifications []string, errors []error) {
	// Validation logic
	if len(data) == 0 {
		errors = append(errors, fmt.Errorf("empty data"))
		return "", false, false, nil, errors
	}
	
	if userID <= 0 {
		errors = append(errors, fmt.Errorf("invalid user ID"))
		return "", false, false, nil, errors
	}
	
	// Configuration processing
	timeout, ok := config["timeout"].(int)
	if !ok {
		timeout = 30
	}
	
	enableCache, ok := config["cache"].(bool)
	if !ok {
		enableCache = true
	}
	
	// Data processing with complex business logic
	switch strings.ToLower(data) {
	case "process_payment":
		result = "payment_processed"
		processed = true
	case "send_email":
		result = "email_sent"
		processed = true
		notifications = append(notifications, "Email notification sent")
	case "update_inventory":
		result = "inventory_updated"
		processed = true
		notifications = append(notifications, "Inventory notification sent")
	case "generate_report":
		result = "report_generated"
		processed = true
	default:
		result = "unknown_operation"
		processed = false
	}
	
	// Caching logic
	if enableCache && processed {
		cacheKey := fmt.Sprintf("user_%d_%s", userID, data)
		// Simulate cache storage
		log.Printf("Caching result with key: %s", cacheKey)
		cached = true
	}
	
	// Notification system
	if processed {
		notifications = append(notifications, fmt.Sprintf("User %d processed %s", userID, data))
		if timeout > 60 {
			notifications = append(notifications, "Long operation warning sent")
		}
	}
	
	// Logging and metrics
	log.Printf("Operation: %s, User: %d, Duration: %dms, Cached: %v", data, userID, timeout*100, cached)
	
	return result, cached, processed, notifications, errors
}

// OCP Violations - Classes not open for extension but closed for modification

type ReportGenerator struct {
	format string
	data   map[string]interface{}
}

// GenerateReport violates OCP - adding new formats requires modifying this function
func (r *ReportGenerator) GenerateReport() string {
	switch r.format {
	case "pdf":
		return r.generatePDF()
	case "excel":
		return r.generateExcel()
	case "csv":
		return r.generateCSV()
	case "json":
		return r.generateJSON()
	case "xml":
		return r.generateXML()
	default:
		return "unsupported format"
	}
}

func (r *ReportGenerator) generatePDF() string {
	return "PDF report generated"
}

func (r *ReportGenerator) generateExcel() string {
	return "Excel report generated"
}

func (r *ReportGenerator) generateCSV() string {
	return "CSV report generated"
}

func (r *ReportGenerator) generateJSON() string {
	jsonData, _ := json.Marshal(r.data)
	return string(jsonData)
}

func (r *ReportGenerator) generateXML() string {
	return "XML report generated"
}

// LSP Violations - Subtypes that don't properly substitute their base types

type Shape interface {
	Area() float64
	Perimeter() float64
}

type Rectangle struct {
	width, height float64
}

func (r Rectangle) Area() float64 {
	return r.width * r.height
}

func (r Rectangle) Perimeter() float64 {
	return 2 * (r.width + r.height)
}

// Square violates LSP by restricting behavior
type Square struct {
	Rectangle
}

func (s *Square) SetWidth(width float64) {
	s.width = width
	s.height = width // Forces square constraint, violating LSP
}

func (s *Square) SetHeight(height float64) {
	s.width = height  // Forces square constraint, violating LSP
	s.height = height
}

// ISP Violations - Interfaces too large forcing clients to depend on methods they don't use

// MegaInterface violates ISP by combining unrelated responsibilities
type MegaInterface interface {
	// Database operations
	Connect() error
	Disconnect() error
	Query(sql string) (*sql.Rows, error)
	Insert(table string, data map[string]interface{}) error
	Update(table string, id int, data map[string]interface{}) error
	Delete(table string, id int) error
	
	// HTTP operations
	Get(url string) (*http.Response, error)
	Post(url string, body []byte) (*http.Response, error)
	Put(url string, body []byte) (*http.Response, error)
	
	// File operations
	ReadFile(path string) ([]byte, error)
	WriteFile(path string, data []byte) error
	DeleteFile(path string) error
	
	// Cache operations
	SetCache(key string, value interface{}) error
	GetCache(key string) (interface{}, error)
	InvalidateCache(key string) error
	
	// Notification operations
	SendEmail(to, subject, body string) error
	SendSMS(to, message string) error
	SendPushNotification(to, message string) error
}

// DIP Violations - High-level modules depending on low-level modules

// UserService violates DIP by directly depending on concrete implementations
type UserService struct {
	mysql    *MySQLDatabase    // Direct dependency on concrete class
	redis    *RedisCache       // Direct dependency on concrete class
	mailer   *SMTPMailer       // Direct dependency on concrete class
	logger   *FileLogger       // Direct dependency on concrete class
	validator *RegexValidator  // Direct dependency on concrete class
}

type MySQLDatabase struct {
	connectionString string
}

func (m *MySQLDatabase) Connect() error {
	log.Printf("Connecting to MySQL: %s", m.connectionString)
	return nil
}

func (m *MySQLDatabase) Query(sql string) ([]map[string]interface{}, error) {
	log.Printf("Executing query: %s", sql)
	return nil, nil
}

type RedisCache struct {
	host string
	port int
}

func (r *RedisCache) Set(key string, value interface{}) error {
	log.Printf("Setting cache %s on %s:%d", key, r.host, r.port)
	return nil
}

func (r *RedisCache) Get(key string) (interface{}, error) {
	log.Printf("Getting cache %s from %s:%d", key, r.host, r.port)
	return nil, nil
}

type SMTPMailer struct {
	smtpServer string
	port       int
}

func (s *SMTPMailer) SendEmail(to, subject, body string) error {
	log.Printf("Sending email via %s:%d to %s", s.smtpServer, s.port, to)
	return nil
}

type FileLogger struct {
	logFile string
}

func (f *FileLogger) Log(message string) error {
	log.Printf("Writing to %s: %s", f.logFile, message)
	return nil
}

type RegexValidator struct {
	patterns map[string]string
}

func (r *RegexValidator) ValidateEmail(email string) bool {
	return strings.Contains(email, "@")
}

func (r *RegexValidator) ValidatePhone(phone string) bool {
	return len(phone) >= 10
}

// NewUserService creates a new UserService with all concrete dependencies
func NewUserService() *UserService {
	return &UserService{
		mysql: &MySQLDatabase{
			connectionString: "user:pass@tcp(localhost:3306)/db",
		},
		redis: &RedisCache{
			host: "localhost",
			port: 6379,
		},
		mailer: &SMTPMailer{
			smtpServer: "smtp.gmail.com",
			port:       587,
		},
		logger: &FileLogger{
			logFile: "/var/log/app.log",
		},
		validator: &RegexValidator{
			patterns: map[string]string{
				"email": `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`,
				"phone": `^\+?[1-9]\d{1,14}$`,
			},
		},
	}
}

// CreateUser demonstrates multiple SOLID violations in one method
func (u *UserService) CreateUser(email, name, phone string) error {
	// Direct dependency usage (DIP violation)
	if !u.validator.ValidateEmail(email) {
		u.logger.Log(fmt.Sprintf("Invalid email: %s", email))
		return fmt.Errorf("invalid email format")
	}
	
	if !u.validator.ValidatePhone(phone) {
		u.logger.Log(fmt.Sprintf("Invalid phone: %s", phone))
		return fmt.Errorf("invalid phone format")
	}
	
	// Too many responsibilities (SRP violation)
	userData := map[string]interface{}{
		"email": email,
		"name":  name,
		"phone": phone,
		"created_at": time.Now(),
	}
	
	// Database operations
	if err := u.mysql.Connect(); err != nil {
		u.logger.Log(fmt.Sprintf("Database connection failed: %v", err))
		return err
	}
	
	users, err := u.mysql.Query("SELECT * FROM users WHERE email = '" + email + "'")
	if err != nil {
		u.logger.Log(fmt.Sprintf("Query failed: %v", err))
		return err
	}
	
	if len(users) > 0 {
		u.logger.Log(fmt.Sprintf("User already exists: %s", email))
		return fmt.Errorf("user already exists")
	}
	
	// Cache operations
	cacheKey := fmt.Sprintf("user_check_%s", email)
	u.redis.Set(cacheKey, true)
	
	// Email notification
	welcomeEmail := fmt.Sprintf("Welcome %s! Your account has been created.", name)
	if err := u.mailer.SendEmail(email, "Welcome!", welcomeEmail); err != nil {
		u.logger.Log(fmt.Sprintf("Failed to send welcome email: %v", err))
		// Continue despite email failure
	}
	
	u.logger.Log(fmt.Sprintf("User created successfully: %s", email))
	return nil
}