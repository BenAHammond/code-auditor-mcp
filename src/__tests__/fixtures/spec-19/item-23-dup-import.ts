/**
 * Spec-19 item 23 — duplicate-import useless positive.
 * Same import line in 5 utility files (axios imported twice).
 * Verdict: USELESS — cross-file import sharing is normal.
 * duplicate-import is retired (checkImports: false). Produces 0 violations.
 */

import axios from 'axios';

import type { AxiosResponse } from 'axios';

export async function fetchConfig(url: string): Promise<AxiosResponse> {
  return axios.get(url);
}
