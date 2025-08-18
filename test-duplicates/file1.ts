// Test file 1 with various duplicates

import { SomeType } from './types';
import { AnotherType } from './types';
import { ThirdType } from './types';

// Exact duplicate function (will appear in file2.ts)
export function calculateTotalPrice(items: any[]): number {
  let total = 0;
  for (const item of items) {
    if (item.price && item.quantity) {
      total += item.price * item.quantity;
    }
  }
  return total;
}

// Similar function with slight variations (will appear in file2.ts)
export function getUserFullName(user: any): string {
  const firstName = user.firstName || '';
  const lastName = user.lastName || '';
  return `${firstName} ${lastName}`.trim();
}

// Duplicate string literals
const API_ENDPOINT = 'https://api.example.com/v1/users';
const ERROR_MESSAGE = 'An error occurred while processing your request. Please try again later.';
const SUCCESS_MESSAGE = 'Your changes have been saved successfully!';

// Another function that will be duplicated
function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Duplicate code block inside function
export function processUserData(users: any[]) {
  const validUsers = [];
  
  // This block will be duplicated
  for (const user of users) {
    if (user.email && validateEmail(user.email)) {
      validUsers.push({
        id: user.id,
        name: getUserFullName(user),
        email: user.email.toLowerCase()
      });
    }
  }
  
  return validUsers;
}

// Use the same string literal again
export function fetchUsers() {
  return fetch('https://api.example.com/v1/users')
    .then(res => res.json());
}

// Use error message again
export function handleError(error: any) {
  console.log('An error occurred while processing your request. Please try again later.');
  return { error: true, message: ERROR_MESSAGE };
}