import { helper } from './lib';

/** A consumer that calls the cross-file helper. */
export function useHelper(): string {
  return helper();
}
