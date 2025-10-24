// Dependency Inversion Principle Violations

// BAD: High-level module depends on low-level module directly
class EmailService {
  private smtpClient: SMTPClient; // Concrete dependency
  
  constructor() {
    this.smtpClient = new SMTPClient(); // Hard dependency
  }
  
  sendEmail(to: string, subject: string, body: string): void {
    this.smtpClient.send(to, subject, body);
  }
}

// BAD: Concrete class instead of abstraction
class SMTPClient {
  send(to: string, subject: string, body: string): void {
    console.log(`Sending email via SMTP to ${to}`);
  }
}

// BAD: UserService depends on concrete EmailService
class UserService {
  private emailService: EmailService; // Should depend on abstraction
  
  constructor() {
    this.emailService = new EmailService(); // Hard dependency
  }
  
  registerUser(email: string): void {
    // Registration logic
    this.emailService.sendEmail(email, "Welcome", "Thanks for registering");
  }
}

// GOOD: Using dependency injection with abstractions
interface IEmailProvider {
  sendEmail(to: string, subject: string, body: string): void;
}

class GoodUserService {
  constructor(private emailProvider: IEmailProvider) {} // Depends on abstraction
  
  registerUser(email: string): void {
    this.emailProvider.sendEmail(email, "Welcome", "Thanks for registering");
  }
}