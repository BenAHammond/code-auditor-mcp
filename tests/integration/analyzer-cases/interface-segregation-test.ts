/**
 * Test file for Interface Segregation Principle
 */

// Good interface - focused on a single responsibility
interface UserReader {
  getUser(id: string): User;
  getAllUsers(): User[];
}

// Bad interface - violates Interface Segregation Principle
// This interface has too many unrelated responsibilities
interface GodInterface {
  // User management
  getUser(id: string): User;
  createUser(data: UserData): User;
  updateUser(id: string, data: UserData): User;
  deleteUser(id: string): void;
  
  // Authentication
  login(email: string, password: string): Token;
  logout(token: string): void;
  refreshToken(token: string): Token;
  
  // Permissions
  checkPermission(userId: string, resource: string): boolean;
  grantPermission(userId: string, resource: string): void;
  revokePermission(userId: string, resource: string): void;
  
  // Logging
  logEvent(event: string, data: any): void;
  getAuditLogs(userId: string): AuditLog[];
  
  // Email
  sendEmail(to: string, subject: string, body: string): void;
  sendNotification(userId: string, message: string): void;
  
  // File operations
  uploadFile(file: File): string;
  downloadFile(id: string): File;
  deleteFile(id: string): void;
  
  // Payment processing
  processPayment(amount: number, paymentMethod: PaymentMethod): PaymentResult;
  refundPayment(paymentId: string): RefundResult;
  
  // Analytics
  trackUserAction(userId: string, action: string): void;
  generateReport(type: string, filters: any): Report;
  
  // Configuration
  getSettings(): Settings;
  updateSettings(settings: Settings): void;
}

// Another overly complex interface
interface MegaService {
  method1(): void;
  method2(): void;
  method3(): void;
  method4(): void;
  method5(): void;
  method6(): void;
  method7(): void;
  method8(): void;
  method9(): void;
  method10(): void;
  method11(): void;
  method12(): void;
  method13(): void;
  method14(): void;
  method15(): void;
  method16(): void;
  method17(): void;
  method18(): void;
  method19(): void;
  method20(): void;
  method21(): void; // This should trigger the violation (over 20 members)
}

// Better approach - segregated interfaces
interface UserService {
  getUser(id: string): User;
  createUser(data: UserData): User;
  updateUser(id: string, data: UserData): User;
  deleteUser(id: string): void;
}

interface AuthService {
  login(email: string, password: string): Token;
  logout(token: string): void;
  refreshToken(token: string): Token;
}

interface PermissionService {
  checkPermission(userId: string, resource: string): boolean;
  grantPermission(userId: string, resource: string): void;
  revokePermission(userId: string, resource: string): void;
}

interface EmailService {
  sendEmail(to: string, subject: string, body: string): void;
  sendNotification(userId: string, message: string): void;
}