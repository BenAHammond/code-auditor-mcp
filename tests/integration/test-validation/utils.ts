// Mock utility functions for test files
export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString();
}