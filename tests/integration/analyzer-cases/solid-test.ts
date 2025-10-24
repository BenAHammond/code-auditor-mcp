/**
 * Test file for SOLID analyzer
 * This file contains various SOLID principle violations
 */

// Single Responsibility Principle Violation
class UserService {
  constructor(
    private db: Database,
    private emailService: EmailService,
    private logger: Logger,
    private cache: CacheService
  ) {}
  
  // User management responsibilities
  async createUser(data: UserData) { }
  async updateUser(id: string, data: UserData) { }
  async deleteUser(id: string) { }
  async findUser(id: string) { }
  
  // Authentication responsibilities
  async login(email: string, password: string) { }
  async logout(userId: string) { }
  async resetPassword(email: string) { }
  async validateToken(token: string) { }
  
  // Email responsibilities
  async sendWelcomeEmail(user: User) { }
  async sendPasswordResetEmail(email: string) { }
  async sendNewsletterEmail(userId: string) { }
  
  // Logging responsibilities
  async logUserAction(action: string, userId: string) { }
  async getActivityLog(userId: string) { }
  
  // Caching responsibilities
  async cacheUser(user: User) { }
  async invalidateUserCache(userId: string) { }
}

// Open/Closed Principle Violation - Switch statement
function calculateShippingCost(type: string, weight: number): number {
  switch (type) {
    case 'standard':
      return weight * 0.5;
    case 'express':
      return weight * 1.2;
    case 'overnight':
      return weight * 2.5;
    case 'international':
      return weight * 3.0;
    default:
      return weight * 0.5;
  }
}

// Liskov Substitution Principle Violation
class Bird {
  fly(): string {
    return "Flying high!";
  }
  
  eat(): void {
    console.log("Eating");
  }
}

class Penguin extends Bird {
  fly(): string {
    throw new Error("Penguins cannot fly!");
  }
}

// Interface Segregation Principle Violation - Fat interface
interface Employee {
  // Work-related
  work(): void;
  attendMeeting(): void;
  writeCode(): void;
  reviewCode(): void;
  deployCode(): void;
  
  // Management-related
  conductInterview(): void;
  approveTimeOff(): void;
  conductPerformanceReview(): void;
  
  // HR-related
  submitTimesheet(): void;
  requestTimeOff(): void;
  updateProfile(): void;
  
  // Admin-related
  manageServers(): void;
  configureFirewall(): void;
  monitorSystems(): void;
}

// Dependency Inversion Principle Violation
import { FileLogger } from './FileLogger';
import { MySQLDatabase } from './MySQLDatabase';

class OrderService {
  // Direct dependencies on concrete implementations
  private logger = new FileLogger('/var/log/orders.log');
  private database = new MySQLDatabase('localhost', 3306);
  
  async processOrder(order: Order) {
    this.logger.log('Processing order: ' + order.id);
    await this.database.save('orders', order);
  }
}

// Good example - should NOT be flagged
interface Logger {
  log(message: string): void;
}

interface Database {
  save(table: string, data: any): Promise<void>;
}

class GoodOrderService {
  constructor(
    private logger: Logger,
    private database: Database
  ) {}
  
  async processOrder(order: Order) {
    this.logger.log('Processing order: ' + order.id);
    await this.database.save('orders', order);
  }
}