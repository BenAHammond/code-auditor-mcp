/**
 * Processes user input and returns a formatted result with count.
 *
 * @param param1 - The input string to process
 * @param param2 - Number of items to generate
 * @param param3 - Whether to include an extra item
 * @returns An object with the joined result string and item count
 */
export function wellDocumented(
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
