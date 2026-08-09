/**
 * named-majority directory — majority of exports are named.
 * 20 named exports establish the convention; one default export in
 * `outlier.tsx` should trigger a conventions/export-shape violation.
 *
 * Convention: named export (must have ≥20 total exports, ≥80% named)
 */

export function parseInput(raw: string): string {
  return raw.trim();
}

export function validateEmail(email: string): boolean {
  return email.includes('@');
}

export function formatDate(date: Date): string {
  return date.toISOString();
}

export function generateId(): string {
  return Math.random().toString(36).substring(2);
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-');
}

export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

export function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function debounce<F extends (...args: any[]) => void>(
  fn: F,
  delay: number,
): (...args: Parameters<F>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<F>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function throttle<F extends (...args: any[]) => void>(
  fn: F,
  limit: number,
): (...args: Parameters<F>) => void {
  let inThrottle = false;
  return (...args: Parameters<F>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => { inThrottle = false; }, limit);
    }
  };
}

export function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pick<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) result[key] = obj[key];
  return result;
}

export function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[],
): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) delete result[key];
  return result;
}

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export function memoize<F extends (...args: any[]) => unknown>(
  fn: F,
): (...args: Parameters<F>) => ReturnType<F> {
  const cache = new Map<string, ReturnType<F>>();
  return (...args: Parameters<F>) => {
    const key = JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, fn(...args) as ReturnType<F>);
    return cache.get(key)!;
  };
}

export function once<F extends (...args: any[]) => unknown>(
  fn: F,
): (...args: Parameters<F>) => ReturnType<F> | undefined {
  let called = false;
  let result: ReturnType<F>;
  return (...args: Parameters<F>) => {
    if (!called) {
      called = true;
      result = fn(...args) as ReturnType<F>;
      return result;
    }
    return undefined;
  };
}
