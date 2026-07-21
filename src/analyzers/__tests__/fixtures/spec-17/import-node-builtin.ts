/**
 * Spec-17 R8 Fixture 6: import-node-builtin
 * Report section: R2.1 — SQL-context-only extraction
 *
 * Importing "node:child_process" should produce ZERO schema findings.
 * This was a top false positive in the diagnostic: the old regex-based
 * analyzer flagged "process" in node:child_process as a table reference.
 */

import { spawn } from "node:child_process";

export function runCommand(cmd: string): void {
  const child = spawn(cmd, [], { stdio: "inherit" });
  child.on("exit", (code) => {
    console.log(`Process exited with code ${code}`);
  });
}
