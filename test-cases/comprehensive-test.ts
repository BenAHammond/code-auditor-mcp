/**
 * Comprehensive test to verify all analyzer functionality
 * This file intentionally contains multiple types of violations
 */

import { db } from './database';

// Documentation violations - missing JSDoc
function undocumentedFunction(param1: string, param2: number) {
  return param1.repeat(param2);
}

export class UndocumentedClass {
  private value: string;
  
  constructor(value: string) {
    this.value = value;
  }
  
  // Missing documentation
  process(input: any) {
    return input;
  }
}

// SOLID violations
class GodClass {
  // Too many methods (will exceed SRP threshold)
  method1() {}
  method2() {}
  method3() {}
  method4() {}
  method5() {}
  method6() {}
  method7() {}
  method8() {}
  method9() {}
  method10() {}
  method11() {}
  method12() {}
  method13() {}
  method14() {}
  method15() {}
  method16() {} // 16+ methods should trigger SRP violation
  
  // Dependency Inversion violation
  private emailService = new EmailService(); // Direct instantiation
  
  sendEmail() {
    this.emailService.send("test");
  }
}

class EmailService {
  send(message: string) {
    console.log(message);
  }
}

// Liskov Substitution violation
class Bird {
  fly() {
    console.log("Flying");
  }
}

class Penguin extends Bird {
  fly() {
    throw new Error("Cannot fly"); // LSP violation
  }
}

// Data access violations
async function badDatabaseQuery() {
  // Missing org filter
  return await db.users.find({}).toArray();
}

async function sqlInjectionRisk(userInput: string) {
  // SQL injection risk
  const query = `SELECT * FROM users WHERE name = '${userInput}'`;
  return await db.query(query);
}

async function goodDatabaseQuery(orgId: string) {
  // Should NOT be flagged - has org filter
  return await db.users.find({ organizationId: orgId }).toArray();
}

// Function with too many parameters (SRP violation)
function complexFunction(
  a: string,
  b: number,
  c: boolean,
  d: object,
  e: string[] // 5+ parameters should trigger violation
) {
  return { a, b, c, d, e };
}

/**
 * Properly documented function
 * @param name - User name
 * @param age - User age
 * @returns User object
 */
function documentedFunction(name: string, age: number) {
  return { name, age };
}