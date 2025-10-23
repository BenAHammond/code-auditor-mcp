/**
 * Parity tests to ensure the universal SOLID analyzer produces identical results
 */

import { describe, it, expect } from 'vitest';
import { solidAnalyzer as legacyAnalyzer } from '../../solidAnalyzer.js';
import { solidAnalyzer as universalAnalyzer } from '../../solidAnalyzerCompat.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Test helper to create temporary test files
 */
async function createTestFile(content: string, filename: string): Promise<string> {
  const testDir = path.join(__dirname, 'temp');
  await fs.mkdir(testDir, { recursive: true });
  const filePath = path.join(testDir, filename);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

/**
 * Clean up test files
 */
async function cleanupTestFiles(): Promise<void> {
  const testDir = path.join(__dirname, 'temp');
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch (error) {
    // Ignore if directory doesn't exist
  }
}

describe('SOLID Analyzer Parity Tests', () => {
  afterEach(async () => {
    await cleanupTestFiles();
  });
  
  describe('Single Responsibility Principle', () => {
    it('should produce identical results for class with too many responsibilities', async () => {
      const code = `
class UserService {
  constructor(
    private db: Database,
    private emailService: EmailService,
    private logger: Logger
  ) {}
  
  // User management
  createUser(data: UserData) { }
  updateUser(id: string, data: UserData) { }
  deleteUser(id: string) { }
  
  // Authentication
  login(email: string, password: string) { }
  logout(userId: string) { }
  resetPassword(email: string) { }
  
  // Email notifications
  sendWelcomeEmail(user: User) { }
  sendPasswordResetEmail(email: string) { }
  
  // Logging
  logUserAction(action: string, userId: string) { }
  getActivityLog(userId: string) { }
}
      `;
      
      const file = await createTestFile(code, 'srp-violation.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      // Should detect SRP violation
      expect(universalResult.violations.length).toBeGreaterThan(0);
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Open/Closed Principle', () => {
    it('should produce identical results for switch statement violation', async () => {
      const code = `
function calculatePrice(type: string, basePrice: number): number {
  switch (type) {
    case 'regular':
      return basePrice;
    case 'premium':
      return basePrice * 1.2;
    case 'vip':
      return basePrice * 1.5;
    default:
      return basePrice;
  }
}
      `;
      
      const file = await createTestFile(code, 'ocp-violation.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Liskov Substitution Principle', () => {
    it('should produce identical results for inheritance violation', async () => {
      const code = `
class Bird {
  fly() {
    return "Flying";
  }
}

class Penguin extends Bird {
  fly() {
    throw new Error("Penguins can't fly!");
  }
}
      `;
      
      const file = await createTestFile(code, 'lsp-violation.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Interface Segregation Principle', () => {
    it('should produce identical results for fat interface', async () => {
      const code = `
interface Worker {
  work(): void;
  eat(): void;
  sleep(): void;
  code(): void;
  attendMeeting(): void;
  writeReport(): void;
  fixBug(): void;
  deployCode(): void;
}

class Developer implements Worker {
  work() { }
  eat() { }
  sleep() { }
  code() { }
  attendMeeting() { }
  writeReport() { }
  fixBug() { }
  deployCode() { }
}
      `;
      
      const file = await createTestFile(code, 'isp-violation.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Dependency Inversion Principle', () => {
    it('should produce identical results for direct dependency', async () => {
      const code = `
import { FileLogger } from './FileLogger';

class OrderService {
  private logger = new FileLogger(); // Direct dependency
  
  processOrder(order: Order) {
    this.logger.log('Processing order');
    // Process order
  }
}
      `;
      
      const file = await createTestFile(code, 'dip-violation.ts');
      const files = [file];
      
      const legacyResult = await legacyAnalyzer.analyze(files, {});
      const universalResult = await universalAnalyzer.analyze(files, {});
      
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
  
  describe('Complex Real-World Scenario', () => {
    it('should produce identical results for multiple violations', async () => {
      const code = `
class OrderManager {
  private db = new Database();
  private emailService = new EmailService();
  private paymentGateway = new PaymentGateway();
  
  // Too many responsibilities
  createOrder(data: OrderData) { }
  updateOrder(id: string, data: OrderData) { }
  deleteOrder(id: string) { }
  
  processPayment(orderId: string) { }
  refundPayment(orderId: string) { }
  
  sendOrderConfirmation(order: Order) { }
  sendShippingNotification(order: Order) { }
  
  calculateShipping(order: Order) {
    switch (order.shippingType) {
      case 'standard':
        return 5;
      case 'express':
        return 15;
      case 'overnight':
        return 25;
      default:
        return 5;
    }
  }
  
  generateInvoice(order: Order) { }
  generateReport(startDate: Date, endDate: Date) { }
}
      `;
      
      const file = await createTestFile(code, 'complex-violations.ts');
      const files = [file];
      
      const config = {
        maxMethodsPerClass: 10,
        maxDependencies: 3
      };
      
      const legacyResult = await legacyAnalyzer.analyze(files, config);
      const universalResult = await universalAnalyzer.analyze(files, config);
      
      // Should have multiple violations
      expect(universalResult.violations.length).toBeGreaterThan(0);
      expect(universalResult.violations).toEqual(legacyResult.violations);
    });
  });
});