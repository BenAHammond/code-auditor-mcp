/**
 * Debug test to verify configuration passing
 */

import { db } from './database';

// Test 1: Should detect missing org filter
async function badQuery() {
  return await db.users.find({}).toArray();
}

// Test 2: Should NOT flag - has organizationId
async function goodQuery() {
  return await db.users.find({ organizationId: "test" }).toArray();
}

// Test 3: Should NOT flag - has org_id  
async function goodQuery2() {
  return await db.users.find({ org_id: "test" }).toArray();
}

// Test 4: Should NOT flag - has tenantId
async function goodQuery3() {
  return await db.users.find({ tenantId: "test" }).toArray();
}