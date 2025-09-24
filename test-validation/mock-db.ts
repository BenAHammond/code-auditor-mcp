// Mock database connection for test files
export class DatabaseConnection {
  async query(sql: string, params?: any[]): Promise<any[]> {
    return [];
  }
}