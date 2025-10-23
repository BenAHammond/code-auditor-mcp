import { db } from './database';

// Should NOT flag - has organizationId
async function goodQuery() {
  return await db.users.find({ organizationId: "test" }).toArray();
}