package multilang

import (
	"fmt"
	"log"
)

// Go file with SOLID violations to test multi-language analysis

// Violates SRP - too many responsibilities in one function
func ProcessOrderAndPaymentAndShippingAndNotification(
	orderID string,
	customerID string,
	items []string,
	paymentMethod string,
	shippingAddress string,
	emailAddress string,
	phoneNumber string,
) (bool, error) {
	// Order validation
	if orderID == "" {
		log.Printf("Invalid order ID")
		return false, fmt.Errorf("invalid order ID")
	}
	
	if len(items) == 0 {
		log.Printf("No items in order")
		return false, fmt.Errorf("no items in order")
	}
	
	// Payment processing
	switch paymentMethod {
	case "credit_card":
		log.Printf("Processing credit card payment for order %s", orderID)
	case "paypal":
		log.Printf("Processing PayPal payment for order %s", orderID)
	case "bank_transfer":
		log.Printf("Processing bank transfer for order %s", orderID)
	default:
		log.Printf("Unsupported payment method: %s", paymentMethod)
		return false, fmt.Errorf("unsupported payment method")
	}
	
	// Inventory management
	for _, item := range items {
		log.Printf("Checking inventory for item: %s", item)
		log.Printf("Reserving item: %s", item)
		log.Printf("Updating inventory for item: %s", item)
	}
	
	// Shipping calculation
	shippingCost := 10.0
	if len(shippingAddress) > 50 {
		shippingCost = 15.0
	}
	
	log.Printf("Shipping cost calculated: $%.2f", shippingCost)
	
	// Email notification
	emailSubject := fmt.Sprintf("Order %s confirmed", orderID)
	emailBody := fmt.Sprintf("Your order %s has been confirmed", orderID)
	log.Printf("Sending email to %s: %s", emailAddress, emailSubject)
	
	// SMS notification
	smsMessage := fmt.Sprintf("Order %s confirmed. Items: %v", orderID, items)
	log.Printf("Sending SMS to %s: %s", phoneNumber, smsMessage)
	
	// Audit logging
	log.Printf("Order processed successfully: %s", orderID)
	log.Printf("Customer: %s", customerID)
	log.Printf("Payment method: %s", paymentMethod)
	log.Printf("Shipping address: %s", shippingAddress)
	
	return true, nil
}

// Violates SRP - struct with too many responsibilities
type OrderProcessor struct {
	Database     string
	PaymentAPI   string
	ShippingAPI  string
	EmailService string
	SMSService   string
	Logger       string
	Cache        string
	Validator    string
	ReportGen    string
	Analytics    string
}

// Too many methods - violates SRP  
func (op *OrderProcessor) CreateOrder() error { return nil }
func (op *OrderProcessor) UpdateOrder() error { return nil }
func (op *OrderProcessor) DeleteOrder() error { return nil }
func (op *OrderProcessor) GetOrder() error { return nil }
func (op *OrderProcessor) ProcessPayment() error { return nil }
func (op *OrderProcessor) RefundPayment() error { return nil }
func (op *OrderProcessor) CalculateShipping() error { return nil }
func (op *OrderProcessor) TrackShipping() error { return nil }
func (op *OrderProcessor) SendEmail() error { return nil }
func (op *OrderProcessor) SendSMS() error { return nil }
func (op *OrderProcessor) LogActivity() error { return nil }
func (op *OrderProcessor) LogError() error { return nil }
func (op *OrderProcessor) CacheData() error { return nil }
func (op *OrderProcessor) ValidateOrder() error { return nil }
func (op *OrderProcessor) GenerateReport() error { return nil }
func (op *OrderProcessor) TrackAnalytics() error { return nil }
func (op *OrderProcessor) BackupData() error { return nil }
func (op *OrderProcessor) RestoreData() error { return nil }

// Violates DIP - directly instantiating dependencies
func NewOrderProcessor() *OrderProcessor {
	return &OrderProcessor{
		Database:     "mysql://localhost:3306/orders",  // Direct dependency
		PaymentAPI:   "https://payment.api.com",        // Direct dependency
		ShippingAPI:  "https://shipping.api.com",       // Direct dependency
		EmailService: "smtp.gmail.com:587",             // Direct dependency
		SMSService:   "https://sms.provider.com",       // Direct dependency
		Logger:       "/var/log/orders.log",            // Direct dependency
		Cache:        "redis://localhost:6379",         // Direct dependency
		Validator:    "builtin",                        // Direct dependency
		ReportGen:    "pdf-generator",                  // Direct dependency
		Analytics:    "google-analytics",               // Direct dependency
	}
}

// Interface with too many methods - violates ISP
type MegaOrderInterface interface {
	// Order management
	CreateOrder() error
	UpdateOrder() error
	DeleteOrder() error
	GetOrder() error
	ListOrders() error
	
	// Payment operations
	ProcessPayment() error
	RefundPayment() error
	GetPaymentStatus() error
	
	// Shipping operations
	CalculateShipping() error
	TrackShipping() error
	UpdateShippingAddress() error
	
	// Communication
	SendEmail() error
	SendSMS() error
	SendPushNotification() error
	
	// Reporting
	GenerateReport() error
	ExportData() error
	ImportData() error
	
	// System operations
	BackupData() error
	RestoreData() error
	HealthCheck() error
}