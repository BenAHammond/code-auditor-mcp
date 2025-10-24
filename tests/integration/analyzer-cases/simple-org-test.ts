import { db } from './database';

// This should have organizationId detected
async function testOrgFilter() {
  const result = await db.users.find({ organizationId: "test-org" });
  return result;
}