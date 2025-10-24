// Test file 3 with more duplicates and variations

// Different imports but same modules
import { SomeType } from './types';
import { AnotherType } from './types';
import { ThirdType } from './types';

// Another exact duplicate of calculateTotalPrice
function calculateTotalPrice(items: any[]): number {
  let total = 0;
  for (const item of items) {
    if (item.price && item.quantity) {
      total += item.price * item.quantity;
    }
  }
  return total;
}

// Small function that appears multiple times
const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// More string duplicates
const API_URL = 'https://api.example.com/v1/users';
const SUCCESS = 'Your changes have been saved successfully!';
const FAILURE = 'An error occurred while processing your request. Please try again later.';

// Utility function that might be duplicated
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount);
}

// This exact function also appears in file3-copy.ts
export function removeDuplicates<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}

// Complex duplicated logic
export function processOrderItems(orders: any[]) {
  const processed = [];
  
  for (const order of orders) {
    const total = calculateTotalPrice(order.items);
    processed.push({
      orderId: order.id,
      customerName: order.customer.name,
      total: formatCurrency(total),
      status: order.status
    });
  }
  
  return processed;
}