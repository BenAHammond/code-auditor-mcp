/**
 * Spec-17 R8 Fixture 18: direct-access-allow-config
 * Report section: R4.3 — directAccess: "allow" skips direct-access findings
 *
 * When directAccess is set to "allow", direct SQL connections should
 * produce ZERO `direct-access` findings (they're allowed on this platform).
 * This supports Cloudflare Workers/D1 use cases where direct connections
 * are the documented pattern.
 */

// @ts-ignore — stub
import { Client } from "pg";

const client = new Client({
  host: "localhost",
  database: "myapp",
});

export async function getUsers(): Promise<unknown[]> {
  await client.connect();
  const result = await client.query("SELECT * FROM users");
  await client.end();
  return result.rows;
}
