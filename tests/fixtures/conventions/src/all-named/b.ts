/**
 * All named exports — reinforces the all-named convention.
 */

export function sum(numbers: number[]): number {
  return numbers.reduce((a, b) => a + b, 0);
}

export function average(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return sum(numbers) / numbers.length;
}

export function median(numbers: number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function stdDev(numbers: number[]): number {
  const avg = average(numbers);
  const variance = average(numbers.map((n) => (n - avg) ** 2));
  return Math.sqrt(variance);
}

export function product(numbers: number[]): number {
  return numbers.reduce((a, b) => a * b, 1);
}

export function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

export function gcd(a: number, b: number): number {
  if (b === 0) return a;
  return gcd(b, a % b);
}

export function lcm(a: number, b: number): number {
  return (a * b) / gcd(a, b);
}

export function isPrime(n: number): boolean {
  if (n <= 1) return false;
  for (let i = 2; i <= Math.sqrt(n); i++) {
    if (n % i === 0) return false;
  }
  return true;
}

export function fibonacci(n: number): number {
  if (n <= 1) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) {
    [a, b] = [b, a + b];
  }
  return b;
}
