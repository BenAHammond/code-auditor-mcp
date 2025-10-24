/**
 * Interface segregation demo
 */

// Should trigger Interface Segregation violation (21+ members)
interface MegaInterface {
  // User management
  getUser(): void;
  createUser(): void;
  updateUser(): void;
  deleteUser(): void;
  listUsers(): void;
  
  // Auth
  login(): void;
  logout(): void;
  resetPassword(): void;
  
  // Orders
  getOrder(): void;
  createOrder(): void;
  updateOrder(): void;
  deleteOrder(): void;
  
  // Payments
  processPayment(): void;
  refundPayment(): void;
  
  // Notifications
  sendEmail(): void;
  sendSMS(): void;
  
  // Reports
  generateReport(): void;
  exportData(): void;
  
  // Settings
  updateSettings(): void;
  getSettings(): void;
  resetSettings(): void; // 21 methods - should trigger ISP violation
}

// Good interface - focused responsibility
interface UserRepository {
  getUser(id: string): User;
  saveUser(user: User): void;
  deleteUser(id: string): void;
}