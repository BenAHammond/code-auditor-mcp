// Test file 2 with duplicates from file1.ts

import { SomeType } from './types';
import { AnotherType } from './types';
import { ThirdType } from './types';

// EXACT DUPLICATE: Same function from file1.ts
export function calculateTotalPrice(items: any[]): number {
  let total = 0;
  for (const item of items) {
    if (item.price && item.quantity) {
      total += item.price * item.quantity;
    }
  }
  return total;
}

// SIMILAR: Almost same function with minor differences
export function getPersonFullName(person: any): string {
  const fname = person.firstName || '';
  const lname = person.lastName || '';
  return `${fname} ${lname}`.trim();
}

// Different function with similar email validation
function isValidEmail(emailAddress: string): boolean {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(emailAddress);
}

// Duplicate string literals
const BASE_URL = 'https://api.example.com/v1/users';
const ERROR_MSG = 'An error occurred while processing your request. Please try again later.';

// Function with duplicated internal logic
export function filterActiveUsers(userList: any[]) {
  const activeUsers = [];
  
  // Similar block to processUserData in file1.ts
  for (const user of userList) {
    if (user.email && isValidEmail(user.email)) {
      activeUsers.push({
        id: user.id,
        name: getPersonFullName(user),
        email: user.email.toLowerCase()
      });
    }
  }
  
  return activeUsers;
}

// More string literal usage
export function getApiUrl() {
  return 'https://api.example.com/v1/users';
}

// Use success message
export function showSuccess() {
  alert('Your changes have been saved successfully!');
}