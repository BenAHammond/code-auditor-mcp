/**
 * Spec-19 item 3 — loop-query TRUE positive.
 * Real N+1: INSERT ... RETURNING per iteration in a for loop.
 * The violation SHOULD fire: each iteration performs a DB write.
 */
import Database from 'better-sqlite3';

// Spec 70 R4 — handle proven by the manifest-package import; the INSERT argument
// is dynamic (interpolated) so R3 cannot prove the handle.
const db = new Database(':memory:');

interface UserRecord {
  id: string;
  email: string;
  created: Date;
}

async function syncUsers(users: Array<{ email: string; name: string }>): Promise<UserRecord[]> {
  const results: UserRecord[] = [];

  for (const user of users) {
    // Each iteration performs INSERT ... RETURNING — real N+1
    const [record] = await db.prepare(
      `INSERT INTO users (email, name) VALUES ('${user.email}', '${user.name}') RETURNING id, email, created`
    ).all();
    results.push(record);
  }

  return results;
}

export { syncUsers };
