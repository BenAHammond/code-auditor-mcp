/**
 * Spec-17 R8 Fixture 4: private-methods
 * Report section: R1.2 — Default scope is public API surface only
 *
 * Private, protected, and underscore-prefixed methods should produce ZERO
 * documentation findings at default scope. Public methods in exported
 * classes SHOULD produce findings.
 */

export class UserService {
  /**
   * Public API — should be flagged if undocumented.
   */
  public getActiveUsers(): string[] {
    return ["Alice", "Bob"];
  }

  private validateInput(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    return true;
  }

  protected normalizeName(name: string): string {
    return name.trim().toLowerCase();
  }

  _internalHelper(value: number): number {
    return Math.abs(value);
  }
}
