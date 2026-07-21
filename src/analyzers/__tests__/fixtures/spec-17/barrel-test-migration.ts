/**
 * Spec-17 R8 Fixture 5: barrel-test-migration
 * Report section: R1.5 — File-header checks default OFF
 *
 * With fileHeaders disabled (default), this barrel export file
 * should produce ZERO file-header findings. Also verifies that
 * migration-style test files don't trigger header checks even
 * if fileHeaders were enabled (due to headerSkipGlobs).
 */

export { UserService } from "./services";
export { UserController } from "./controllers";
export type { User, UserRole } from "./types";
