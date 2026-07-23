/**
 * This file has an exported function without JSDoc — should trigger function-documentation.
 */

export function publicAPI(
  param1: string,
  param2: number,
  param3: boolean
): { result: string; count: number } {
  const intermediate = param1.toUpperCase();
  const items = Array.from({ length: param2 }, (_, i) => `${intermediate}-${i}`);

  if (param3) {
    items.push(`${intermediate}-extra`);
  }

  return {
    result: items.join(','),
    count: items.length
  };
}
