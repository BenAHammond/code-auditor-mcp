/**
 * Test file for documentation analyzer
 * This file has a proper file-level comment
 */

// Missing documentation - should be flagged
function calculateTax(amount: number, rate: number) {
  return amount * rate;
}

// Missing documentation - should be flagged
export class UserManager {
  async getUser(id: string) {
    return db.users.findOne({ id });
  }
  
  async updateUser(id: string, data: any) {
    return db.users.updateOne({ id }, data);
  }
}

/**
 * Properly documented function
 * @param items - Array of items to sum
 * @returns The total sum
 */
function calculateTotal(items: Item[]) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

/**
 * Missing parameter documentation
 */
function processOrder(order: Order, options: ProcessOptions) {
  // Implementation
}

/**
 * Short desc
 */
function shortDescription() {
  // This description is too short if minDescriptionLength is configured
}

// Arrow function without documentation
export const validateEmail = (email: string) => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

// Async function without documentation
export async function fetchUserData(userId: string) {
  const user = await api.get(`/users/${userId}`);
  return user.data;
}

/**
 * Well-documented service class
 */
export class OrderService {
  /**
   * Create a new order
   * @param orderData - The order data
   * @returns The created order
   */
  async createOrder(orderData: OrderData): Promise<Order> {
    // Implementation
  }
  
  // Missing documentation for this method
  async cancelOrder(orderId: string): Promise<void> {
    // Implementation
  }
}

// React component without documentation (if checking components)
export const Button = ({ label, onClick }: ButtonProps) => {
  return <button onClick={onClick}>{label}</button>;
};

// Test helper functions (might be exempt if configured)
function testHelper() {
  return 'test';
}

function mockData() {
  return { id: 1, name: 'Mock' };
}