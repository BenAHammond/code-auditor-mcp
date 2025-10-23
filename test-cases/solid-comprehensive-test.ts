/**
 * Comprehensive SOLID principles test file
 */

// Single Responsibility Violation - class doing too many things
class UserManagerViolation {
  // User management methods (15+ methods to trigger SRP violation)
  getUser() {}
  createUser() {}
  updateUser() {}
  deleteUser() {}
  validateUser() {}
  searchUsers() {}
  filterUsers() {}
  sortUsers() {}
  
  // Email functionality (should be separate)
  sendWelcomeEmail() {}
  sendPasswordResetEmail() {}
  sendNotificationEmail() {}
  
  // File operations (should be separate)
  uploadAvatar() {}
  deleteAvatar() {}
  
  // Reporting (should be separate)
  generateUserReport() {}
  exportUserData() {}
  
  // Additional methods to exceed threshold
  method17() {}
  method18() {}
  method19() {}
  method20() {} // This should trigger SRP violation
}

// Open/Closed Principle - Good example
abstract class Shape {
  abstract calculateArea(): number;
}

class Rectangle extends Shape {
  constructor(private width: number, private height: number) {
    super();
  }
  
  calculateArea(): number {
    return this.width * this.height;
  }
}

class Circle extends Shape {
  constructor(private radius: number) {
    super();
  }
  
  calculateArea(): number {
    return Math.PI * this.radius * this.radius;
  }
}

// Liskov Substitution Violation - child class throws when parent doesn't
class Bird {
  fly(): void {
    // Base implementation
  }
}

class Penguin extends Bird {
  fly(): void {
    throw new Error("Penguins can't fly!"); // LSP violation
  }
}

// Dependency Inversion Violation - direct instantiation
class EmailService {
  send(message: string) {
    console.log(`Sending: ${message}`);
  }
}

class UserService {
  private emailService = new EmailService(); // DIP violation - should inject dependency
  
  notifyUser(userId: string, message: string) {
    this.emailService.send(message);
  }
}

// Interface Segregation Violation - bloated interface
interface WorkerInterface {
  work(): void;
  eat(): void;
  sleep(): void;
  
  // Management tasks
  manageTasks(): void;
  delegateWork(): void;
  conductMeetings(): void;
  writeReports(): void;
  
  // HR tasks
  hireEmployees(): void;
  fireEmployees(): void;
  evaluatePerformance(): void;
  
  // Finance tasks
  manageBudget(): void;
  approveExpenses(): void;
  
  // IT tasks
  setupComputers(): void;
  troubleshootNetwork(): void;
  installSoftware(): void;
  
  // Additional methods to exceed threshold
  task17(): void;
  task18(): void;
  task19(): void;
  task20(): void;
  task21(): void; // This should trigger ISP violation
}

// Better approach - segregated interfaces
interface Worker {
  work(): void;
  eat(): void;
  sleep(): void;
}

interface Manager {
  manageTasks(): void;
  delegateWork(): void;
  conductMeetings(): void;
}

interface HRPersonnel {
  hireEmployees(): void;
  fireEmployees(): void;
  evaluatePerformance(): void;
}

// Good practices examples
class GoodUserService {
  constructor(private emailService: EmailService) {} // DI - good!
  
  createUser(userData: any) {
    // Single responsibility - only user creation
    return userData;
  }
}

// Method with too many parameters (should trigger SRP)
function processOrder(
  orderId: string,
  customerId: string,
  items: any[],
  shippingAddress: string,
  billingAddress: string,
  paymentMethod: string,
  shippingMethod: string,
  discountCode: string,
  specialInstructions: string // 9 parameters - should trigger violation
) {
  // Long method (50+ lines to trigger violation)
  console.log("Processing order...");
  console.log("Step 1");
  console.log("Step 2");
  console.log("Step 3");
  console.log("Step 4");
  console.log("Step 5");
  console.log("Step 6");
  console.log("Step 7");
  console.log("Step 8");
  console.log("Step 9");
  console.log("Step 10");
  console.log("Step 11");
  console.log("Step 12");
  console.log("Step 13");
  console.log("Step 14");
  console.log("Step 15");
  console.log("Step 16");
  console.log("Step 17");
  console.log("Step 18");
  console.log("Step 19");
  console.log("Step 20");
  console.log("Step 21");
  console.log("Step 22");
  console.log("Step 23");
  console.log("Step 24");
  console.log("Step 25");
  console.log("Step 26");
  console.log("Step 27");
  console.log("Step 28");
  console.log("Step 29");
  console.log("Step 30");
  console.log("Step 31");
  console.log("Step 32");
  console.log("Step 33");
  console.log("Step 34");
  console.log("Step 35");
  console.log("Step 36");
  console.log("Step 37");
  console.log("Step 38");
  console.log("Step 39");
  console.log("Step 40");
  console.log("Step 41");
  console.log("Step 42");
  console.log("Step 43");
  console.log("Step 44");
  console.log("Step 45");
  console.log("Step 46");
  console.log("Step 47");
  console.log("Step 48");
  console.log("Step 49");
  console.log("Step 50");
  console.log("Step 51"); // Line 51+ should trigger violation
  return "completed";
}