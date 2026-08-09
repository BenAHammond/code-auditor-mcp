/**
 * all-named directory — every export is named.
 * No convention violation should be triggered here.
 */

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero');
  return a / b;
}

export function modulus(a: number, b: number): number {
  return a % b;
}

export function power(a: number, b: number): number {
  return Math.pow(a, b);
}

export function sqrt(n: number): number {
  return Math.sqrt(n);
}

export function abs(n: number): number {
  return Math.abs(n);
}

export function min(a: number, b: number): number {
  return a < b ? a : b;
}

export function max(a: number, b: number): number {
  return a > b ? a : b;
}
