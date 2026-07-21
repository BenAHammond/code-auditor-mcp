/**
 * Spec-17 R8 Fixture 10: tsx-no-db-usage
 * Report section: R2.2 — File gate
 *
 * A .tsx file with no database usage and SQL-looking strings in JSX
 * should produce ZERO schema findings. The file gate (R2.2) should
 * prevent this file from being scanned for table references.
 */

import React from "react";

export function DatabaseView() {
  return (
    <div>
      <h1>Database Overview</h1>
      <pre>SELECT * FROM users</pre>
      <pre>INSERT INTO orders</pre>
      <code>DROP TABLE temp</code>
      <p>The quick brown fox</p>
    </div>
  );
}
