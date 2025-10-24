package main

import (
	"fmt"
	"log"
	"net/http"
	"strings"
)

// UserService handles user operations and validation and email sending
type UserService struct {
	dbConnection string
	emailService string
	logService   string
	cacheService string
	apiClient    string
	validator    string
}

// ProcessUserDataAndSendEmailAndLogAndCache processes user data with multiple responsibilities
func (u *UserService) ProcessUserDataAndSendEmailAndLogAndCache(userID string, email string, name string, address string, phone string) (string, bool, error, *UserService) {
	// This function violates SRP by doing too many things
	fmt.Printf("Processing user %s\n", userID)
	
	// Validation logic
	if len(userID) == 0 {
		log.Println("Invalid user ID")
		return "", false, fmt.Errorf("invalid user ID"), nil
	}
	
	// Database operations
	switch userID {
	case "admin":
		return "admin", true, nil, u
	case "user":
		return "user", false, nil, u
	case "guest":
		return "guest", false, nil, u
	case "moderator":
		return "moderator", true, nil, u
	case "developer":
		return "developer", true, nil, u
	case "tester":
		return "tester", false, nil, u
	default:
		return "unknown", false, nil, u
	}
}

// BadInterface violates ISP with too many methods
type BadInterface interface {
	Method1() error
	Method2() string
	Method3() bool
	Method4() int
	Method5() float64
	Method6() []string
	Method7() map[string]interface{}
}

// PanicFunction demonstrates LSP violation
func PanicFunction() {
	panic("This function panics unexpectedly")
}

// ConcurrentProcessorWithoutSync uses goroutines without proper synchronization
func ConcurrentProcessorWithoutSync() {
	for i := 0; i < 10; i++ {
		go processItem(i)
	}
	// Missing sync.WaitGroup or channel synchronization
}

func processItem(id int) {
	fmt.Printf("Processing item %d\n", id)
}

// ChannelProcessor has complex channel operations
func ChannelProcessor(ch chan string, done chan bool) {
	for {
		select {
		case msg := <-ch:
			if strings.Contains(msg, "error") {
				// Complex channel logic that might deadlock
				done <- true
				return
			}
		default:
			// More complex logic
			ch <- "processed"
		}
	}
}

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "Hello, World!")
	})
	log.Fatal(http.ListenAndServe(":8080", nil))
}