/**
 * Test file specifically for organization filter detection
 */

import { db } from './database';

// Should be flagged - missing org filter on users table
async function getAllUsers() {
  return await db.users.find({}).toArray();
}

// Should be flagged - missing org filter on orders table
async function getActiveOrders() {
  return await db.orders.find({ status: 'active' }).toArray();
}

// Should NOT be flagged - has org filter
async function getUsersForOrg(orgId: string) {
  return await db.users.find({ organizationId: orgId }).toArray();
}

// Should be flagged - missing org filter on customers table
async function searchCustomers(name: string) {
  return await db.customers.find({ 
    name: { $regex: name, $options: 'i' } 
  }).toArray();
}

// Should NOT be flagged - has org filter
async function getOrgProjects(orgId: string, status: string) {
  return await db.projects.find({ 
    organizationId: orgId,
    status: status
  }).toArray();
}

// Should be flagged - SQL query missing org filter
async function getAccountsSQL(type: string) {
  const query = `SELECT * FROM accounts WHERE type = '${type}'`;
  return await db.query(query);
}

// Should NOT be flagged - not a table that requires org filter
async function getSystemSettings() {
  return await db.settings.find({}).toArray();
}