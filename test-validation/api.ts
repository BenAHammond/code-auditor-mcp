// Mock API functions for test files
export async function fetchUser(userId: string): Promise<any> {
  return { id: userId, name: 'Test User' };
}

export async function updateUser(userId: string, data: any): Promise<void> {
  // Mock implementation
}