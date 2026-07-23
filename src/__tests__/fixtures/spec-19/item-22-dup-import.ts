/**
 * Spec-19 item 22 — duplicate-import useless positive.
 * Same import line as another hook file (lodash imported twice).
 * Verdict: USELESS — cross-file import sharing is normal.
 * duplicate-import is retired (checkImports: false). Produces 0 violations.
 */

import { debounce } from 'lodash';

import { throttle } from 'lodash';

export function useDebouncedSearch(delay: number) {
  const search = debounce((q: string) => q, delay);
  const flush = throttle(() => {}, delay);
  return { search, flush };
}
