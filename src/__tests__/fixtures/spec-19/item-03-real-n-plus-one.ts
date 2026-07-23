/**
 * Spec-19 item 3 — loop-query TRUE positive.
 * Real N+1: INSERT ... RETURNING per iteration in a for loop.
 * The violation SHOULD fire: each iteration performs a DB write.
 */
import { sql } from './db';

interface UserRecord {
  id: string;
  email: string;
  created: Date;
}

async function syncUsers(users: Array<{ email: string; name: string }>): Promise<UserRecord[]> {
  const results: UserRecord[] = [];

  for (const user of users) {
    // Each iteration performs INSERT ... RETURNING — real N+1
    const [record] = await sql<[UserRecord]>(
      `INSERT INTO users (email, name) VALUES ('${user.email}', '${user.name}') RETURNING id, email, created`
    );
    results.push(record);
  }

  return results;
}

export { syncUsers };
