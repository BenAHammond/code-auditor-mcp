// TypeScript file with SOLID violations

export class MegaService {
  private database: any;
  private logger: any;
  private emailer: any;
  private cache: any;
  private validator: any;

  // Violates SRP - too many responsibilities
  async processUserDataAndSendEmailAndLogAndCache(
    userID: string, 
    email: string, 
    name: string, 
    address: string, 
    phone: string,
    zipCode: string,
    country: string,
    preferences: any
  ) {
    // Validation logic
    if (!userID || userID.length === 0) {
      this.logger.error('Invalid user ID');
      return false;
    }
    
    if (!email || !email.includes('@')) {
      this.logger.error('Invalid email');
      return false;
    }
    
    // Database operations
    const userData = {
      userID, email, name, address, phone, zipCode, country, preferences
    };
    
    await this.database.save(userData);
    
    // Caching logic
    const cacheKey = `user_${userID}`;
    await this.cache.set(cacheKey, userData);
    
    // Email notification
    await this.emailer.send(email, 'Welcome!', `Hello ${name}`);
    
    // Logging
    this.logger.info(`User ${userID} processed successfully`);
    
    return true;
  }

  // Too many methods - violates SRP
  async getUserById(id: string) { return this.database.findById(id); }
  async updateUser(id: string, data: any) { return this.database.update(id, data); }
  async deleteUser(id: string) { return this.database.delete(id); }
  async sendWelcomeEmail(email: string) { return this.emailer.send(email, 'Welcome!', 'Hello'); }
  async sendPasswordReset(email: string) { return this.emailer.send(email, 'Reset', 'Reset link'); }
  async logUserAction(action: string) { this.logger.info(action); }
  async logError(error: string) { this.logger.error(error); }
  async cacheUser(user: any) { this.cache.set(`user_${user.id}`, user); }
  async getCachedUser(id: string) { return this.cache.get(`user_${id}`); }
  async validateEmail(email: string) { return this.validator.email(email); }
  async validatePhone(phone: string) { return this.validator.phone(phone); }
  async generateReport() { /* complex logic */ }
  async exportData() { /* complex logic */ }
  async importData() { /* complex logic */ }
  async backup() { /* complex logic */ }
  async restore() { /* complex logic */ }
  async cleanup() { /* complex logic */ }
}