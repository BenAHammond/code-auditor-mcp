package testadvanced

import (
	"context"
	"fmt"
	"time"
)

// Proper interface design and dependency injection patterns

// Good interfaces - small and focused (ISP compliant)
type Reader interface {
	Read([]byte) (int, error)
}

type Writer interface {
	Write([]byte) (int, error)
}

type Closer interface {
	Close() error
}

// Composite interfaces
type ReadWriter interface {
	Reader
	Writer
}

type ReadWriteCloser interface {
	Reader
	Writer
	Closer
}

// Domain-specific interfaces
type UserRepository interface {
	GetUser(ctx context.Context, id string) (*User, error)
	CreateUser(ctx context.Context, user *User) error
	UpdateUser(ctx context.Context, user *User) error
	DeleteUser(ctx context.Context, id string) error
}

type EmailService interface {
	SendEmail(ctx context.Context, to, subject, body string) error
	SendBulkEmail(ctx context.Context, recipients []string, subject, body string) error
}

type CacheService interface {
	Get(ctx context.Context, key string) (interface{}, error)
	Set(ctx context.Context, key string, value interface{}, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
}

type Logger interface {
	Info(msg string, fields ...interface{})
	Warn(msg string, fields ...interface{})
	Error(msg string, fields ...interface{})
	Debug(msg string, fields ...interface{})
}

// Domain models
type User struct {
	ID       string    `json:"id"`
	Email    string    `json:"email"`
	Name     string    `json:"name"`
	Phone    string    `json:"phone"`
	Created  time.Time `json:"created"`
	Modified time.Time `json:"modified"`
}

// Good dependency injection implementation
type UserService struct {
	userRepo     UserRepository
	emailService EmailService
	cache        CacheService
	logger       Logger
}

func NewUserService(
	userRepo UserRepository,
	emailService EmailService,
	cache CacheService,
	logger Logger,
) *UserService {
	return &UserService{
		userRepo:     userRepo,
		emailService: emailService,
		cache:        cache,
		logger:       logger,
	}
}

func (s *UserService) CreateUser(ctx context.Context, email, name, phone string) (*User, error) {
	s.logger.Info("Creating new user", "email", email, "name", name)
	
	// Check cache first
	cacheKey := fmt.Sprintf("user_email_%s", email)
	if cached, err := s.cache.Get(ctx, cacheKey); err == nil && cached != nil {
		s.logger.Warn("User already exists in cache", "email", email)
		return nil, fmt.Errorf("user with email %s already exists", email)
	}
	
	user := &User{
		ID:       generateID(),
		Email:    email,
		Name:     name,
		Phone:    phone,
		Created:  time.Now(),
		Modified: time.Now(),
	}
	
	if err := s.userRepo.CreateUser(ctx, user); err != nil {
		s.logger.Error("Failed to create user in repository", "error", err, "email", email)
		return nil, fmt.Errorf("failed to create user: %w", err)
	}
	
	// Cache the user
	if err := s.cache.Set(ctx, cacheKey, user, time.Hour); err != nil {
		s.logger.Warn("Failed to cache user", "error", err, "email", email)
	}
	
	// Send welcome email
	if err := s.emailService.SendEmail(ctx, email, "Welcome!", "Welcome to our platform!"); err != nil {
		s.logger.Error("Failed to send welcome email", "error", err, "email", email)
		// Don't fail the entire operation for email failure
	}
	
	s.logger.Info("User created successfully", "id", user.ID, "email", email)
	return user, nil
}

func (s *UserService) GetUser(ctx context.Context, id string) (*User, error) {
	cacheKey := fmt.Sprintf("user_id_%s", id)
	
	// Try cache first
	if cached, err := s.cache.Get(ctx, cacheKey); err == nil && cached != nil {
		if user, ok := cached.(*User); ok {
			s.logger.Debug("User found in cache", "id", id)
			return user, nil
		}
	}
	
	// Fallback to repository
	user, err := s.userRepo.GetUser(ctx, id)
	if err != nil {
		s.logger.Error("Failed to get user from repository", "error", err, "id", id)
		return nil, err
	}
	
	// Cache for future requests
	if err := s.cache.Set(ctx, cacheKey, user, time.Hour); err != nil {
		s.logger.Warn("Failed to cache user", "error", err, "id", id)
	}
	
	return user, nil
}

// Advanced interface patterns

// Strategy pattern with interfaces
type ValidationStrategy interface {
	Validate(user *User) error
}

type EmailValidationStrategy struct{}

func (e *EmailValidationStrategy) Validate(user *User) error {
	if user.Email == "" {
		return fmt.Errorf("email is required")
	}
	if !isValidEmail(user.Email) {
		return fmt.Errorf("invalid email format")
	}
	return nil
}

type PhoneValidationStrategy struct{}

func (p *PhoneValidationStrategy) Validate(user *User) error {
	if user.Phone == "" {
		return fmt.Errorf("phone is required")
	}
	if !isValidPhone(user.Phone) {
		return fmt.Errorf("invalid phone format")
	}
	return nil
}

type CompositeValidationStrategy struct {
	strategies []ValidationStrategy
}

func (c *CompositeValidationStrategy) Validate(user *User) error {
	for _, strategy := range c.strategies {
		if err := strategy.Validate(user); err != nil {
			return err
		}
	}
	return nil
}

// Observer pattern with interfaces
type UserEventObserver interface {
	OnUserCreated(ctx context.Context, user *User) error
	OnUserUpdated(ctx context.Context, user *User) error
	OnUserDeleted(ctx context.Context, userID string) error
}

type AuditObserver struct {
	logger Logger
}

func (a *AuditObserver) OnUserCreated(ctx context.Context, user *User) error {
	a.logger.Info("Audit: User created", "userID", user.ID, "email", user.Email)
	return nil
}

func (a *AuditObserver) OnUserUpdated(ctx context.Context, user *User) error {
	a.logger.Info("Audit: User updated", "userID", user.ID, "email", user.Email)
	return nil
}

func (a *AuditObserver) OnUserDeleted(ctx context.Context, userID string) error {
	a.logger.Info("Audit: User deleted", "userID", userID)
	return nil
}

type MetricsObserver struct {
	metricsCollector MetricsCollector
}

type MetricsCollector interface {
	IncrementCounter(name string, tags map[string]string)
	RecordDuration(name string, duration time.Duration, tags map[string]string)
}

func (m *MetricsObserver) OnUserCreated(ctx context.Context, user *User) error {
	m.metricsCollector.IncrementCounter("user.created", map[string]string{
		"source": "api",
	})
	return nil
}

func (m *MetricsObserver) OnUserUpdated(ctx context.Context, user *User) error {
	m.metricsCollector.IncrementCounter("user.updated", map[string]string{
		"source": "api",
	})
	return nil
}

func (m *MetricsObserver) OnUserDeleted(ctx context.Context, userID string) error {
	m.metricsCollector.IncrementCounter("user.deleted", map[string]string{
		"source": "api",
	})
	return nil
}

// Enhanced UserService with observers and strategies
type EnhancedUserService struct {
	userRepo            UserRepository
	emailService        EmailService
	cache               CacheService
	logger              Logger
	validationStrategy  ValidationStrategy
	observers           []UserEventObserver
}

func NewEnhancedUserService(
	userRepo UserRepository,
	emailService EmailService,
	cache CacheService,
	logger Logger,
	validationStrategy ValidationStrategy,
) *EnhancedUserService {
	return &EnhancedUserService{
		userRepo:           userRepo,
		emailService:       emailService,
		cache:              cache,
		logger:             logger,
		validationStrategy: validationStrategy,
		observers:          make([]UserEventObserver, 0),
	}
}

func (s *EnhancedUserService) AddObserver(observer UserEventObserver) {
	s.observers = append(s.observers, observer)
}

func (s *EnhancedUserService) CreateUser(ctx context.Context, email, name, phone string) (*User, error) {
	user := &User{
		ID:       generateID(),
		Email:    email,
		Name:     name,
		Phone:    phone,
		Created:  time.Now(),
		Modified: time.Now(),
	}
	
	// Validate using strategy
	if err := s.validationStrategy.Validate(user); err != nil {
		s.logger.Warn("User validation failed", "error", err, "email", email)
		return nil, fmt.Errorf("validation failed: %w", err)
	}
	
	// Create user
	if err := s.userRepo.CreateUser(ctx, user); err != nil {
		s.logger.Error("Failed to create user", "error", err, "email", email)
		return nil, err
	}
	
	// Notify observers
	for _, observer := range s.observers {
		if err := observer.OnUserCreated(ctx, user); err != nil {
			s.logger.Warn("Observer notification failed", "error", err, "observer", fmt.Sprintf("%T", observer))
		}
	}
	
	return user, nil
}

// Factory pattern with interfaces
type RepositoryFactory interface {
	CreateUserRepository() UserRepository
	CreateOrderRepository() OrderRepository
	CreateProductRepository() ProductRepository
}

type OrderRepository interface {
	GetOrder(ctx context.Context, id string) (*Order, error)
	CreateOrder(ctx context.Context, order *Order) error
}

type ProductRepository interface {
	GetProduct(ctx context.Context, id string) (*Product, error)
	CreateProduct(ctx context.Context, product *Product) error
}

type Order struct {
	ID       string
	UserID   string
	Products []string
	Total    float64
	Created  time.Time
}

type Product struct {
	ID          string
	Name        string
	Description string
	Price       float64
	Available   bool
}

type MySQLRepositoryFactory struct {
	connectionString string
}

func (f *MySQLRepositoryFactory) CreateUserRepository() UserRepository {
	return &MySQLUserRepository{connectionString: f.connectionString}
}

func (f *MySQLRepositoryFactory) CreateOrderRepository() OrderRepository {
	return &MySQLOrderRepository{connectionString: f.connectionString}
}

func (f *MySQLRepositoryFactory) CreateProductRepository() ProductRepository {
	return &MySQLProductRepository{connectionString: f.connectionString}
}

// Mock implementations for testing
type MySQLUserRepository struct {
	connectionString string
}

func (r *MySQLUserRepository) GetUser(ctx context.Context, id string) (*User, error) {
	// Mock implementation
	return &User{ID: id, Email: "test@example.com"}, nil
}

func (r *MySQLUserRepository) CreateUser(ctx context.Context, user *User) error {
	// Mock implementation
	return nil
}

func (r *MySQLUserRepository) UpdateUser(ctx context.Context, user *User) error {
	// Mock implementation
	return nil
}

func (r *MySQLUserRepository) DeleteUser(ctx context.Context, id string) error {
	// Mock implementation
	return nil
}

type MySQLOrderRepository struct {
	connectionString string
}

func (r *MySQLOrderRepository) GetOrder(ctx context.Context, id string) (*Order, error) {
	// Mock implementation
	return &Order{ID: id, UserID: "user1"}, nil
}

func (r *MySQLOrderRepository) CreateOrder(ctx context.Context, order *Order) error {
	// Mock implementation
	return nil
}

type MySQLProductRepository struct {
	connectionString string
}

func (r *MySQLProductRepository) GetProduct(ctx context.Context, id string) (*Product, error) {
	// Mock implementation
	return &Product{ID: id, Name: "Test Product"}, nil
}

func (r *MySQLProductRepository) CreateProduct(ctx context.Context, product *Product) error {
	// Mock implementation
	return nil
}

// Utility functions
func generateID() string {
	return fmt.Sprintf("id_%d", time.Now().UnixNano())
}

func isValidEmail(email string) bool {
	// Simplified email validation
	return len(email) > 0 && contains(email, "@")
}

func isValidPhone(phone string) bool {
	// Simplified phone validation
	return len(phone) >= 10
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && s[len(s)-len(substr):] == substr || 
		   (len(s) > len(substr) && findSubstring(s, substr))
}

func findSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}