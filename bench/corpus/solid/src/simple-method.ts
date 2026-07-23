/**
 * Simple class with low-complexity methods — should not trigger any violations.
 */
export class SimpleMath {
  add(a: number, b: number): number {
    return a + b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }

  average(values: number[]): number {
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
  }
}
