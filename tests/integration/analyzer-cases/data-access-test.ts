/**
 * Test file for data-access analyzer
 * This file contains various patterns that should be detected
 */

import { db, sequelize } from './database';

// SQL Injection - String concatenation
async function getUserUnsafe(userId: string) {
  const query = "SELECT * FROM users WHERE id = " + userId;
  return db.execute(query);
}

// SQL Injection - Template literal
async function searchUsersUnsafe(name: string) {
  const query = `
    SELECT * FROM users 
    WHERE name LIKE '%${name}%'
  `;
  return db.query(query);
}

// Safe parameterized query - should NOT be flagged
async function getUserSafe(userId: string) {
  const query = "SELECT * FROM users WHERE id = ?";
  return db.execute(query, [userId]);
}

// Missing organization filter
async function getOrdersNoOrgFilter(status: string) {
  return db.orders.find({ status }).toArray();
}

// With organization filter - should NOT be flagged
async function getOrdersWithOrgFilter(status: string, orgId: string) {
  return db.orders.find({ 
    status, 
    organizationId: orgId 
  }).toArray();
}

// Complex SQL injection in ORM
class UserRepository {
  async searchByEmail(email: string) {
    // SQL injection via ORM
    return sequelize.query(`SELECT * FROM users WHERE email = '${email}'`);
  }
  
  async findByRole(role: string) {
    // Missing org filter in repository method
    return db.users.find({ role }).toArray();
  }
}

// Multiple issues in one function
async function complexDataAccess(userId: string, filters: any, orgId: string) {
  // Issue 1: SQL injection
  const userQuery = `SELECT * FROM users WHERE id = ${userId}`;
  
  // Issue 2: Another SQL injection
  if (filters.email) {
    const emailQuery = "SELECT * FROM users WHERE email = '" + filters.email + "'";
    await db.query(emailQuery);
  }
  
  // Issue 3: Missing org filter
  const orders = await db.orders.find({ userId }).toArray();
  
  return {
    user: await db.query(userQuery),
    orders
  };
}